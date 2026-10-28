/**
 * @local/dsh-github — 宿主半体。
 *
 * 职责：
 *   1. 从宿主凭据服务解析 GitHub Personal Access Token（GITHUB_TOKEN / GH_TOKEN）；
 *   2. 注册三个 Agent 工具：github_status（只读）、github_push（上传代码）、
 *      github_create_repo（创建仓库）；
 *   3. github_push / github_create_repo 在执行前**必须**通过 ctx.approval.request()
 *      取得用户当场授权（allowed-once），拒绝 / 取消 / 无应答器一律不执行（fail closed）；
 *   4. 为浏览器设置卡片提供 /api/dsh-github/* 路由读写令牌与连接状态。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const API_BASE = 'https://api.github.com'
const USER_AGENT = 'dsh-github-connector'
const TOKEN_REFS = ['GITHUB_TOKEN', 'GH_TOKEN']
const MAX_INCLUDE_DEPTH = 8

const DEFAULT_SKIP_DIRS = [
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.cache',
  '.idea',
  '.vscode',
  'coverage',
]

const GITHUB_TOKEN_URL = 'https://github.com/settings/tokens'

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function asInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function text(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function textBlocks(value) {
  return [{ type: 'text', text: text(value) }]
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`
}

function normalizeRepo(value) {
  const repo = String(value ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(repo)
  if (!match) throw new Error(`仓库标识不合法：${JSON.stringify(value)}（应为 owner/name，例如 octocat/hello-world）`)
  return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}` }
}

function normalizeBranch(value) {
  const branch = String(value ?? '').trim()
  if (!branch) return undefined
  if (branch.startsWith('-') || branch.includes('..') || /\s/.test(branch)) {
    throw new Error(`分支名不合法：${JSON.stringify(branch)}`)
  }
  return branch
}

function normalizeTargetPath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/')
  const cleaned = raw.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!cleaned) return ''
  if (cleaned.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`目标目录不合法：${JSON.stringify(value)}`)
  }
  return cleaned
}

/** 面板内文件预览的最大字节数（超出部分截断并标记）。 */
const MAX_PREVIEW_BYTES = 256 * 1024

function normalizeContentPath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!raw) return ''
  const parts = raw.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`路径不合法：${JSON.stringify(value)}`)
  }
  return parts.join('/')
}

function encodeContentPath(path) {
  return String(path ?? '')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function decodeBase64Text(content) {
  return Buffer.from(String(content ?? '').replace(/\s+/g, ''), 'base64').toString('utf8')
}

/* ------------------------------------------------------------------ *
 * GitHub API
 * ------------------------------------------------------------------ */

function githubHeaders(token, hasBody) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
  }
}

async function githubRequest(token, path, init = {}, signal) {
  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: githubHeaders(token, init.body !== undefined),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法连接 GitHub API（${path}）：${reason}`)
  }
  const bodyText = await response.text()
  let data
  try {
    data = bodyText ? JSON.parse(bodyText) : {}
  } catch {
    data = { message: bodyText.slice(0, 400) }
  }
  if (!response.ok) {
    const message = typeof data?.message === 'string' ? data.message : bodyText.slice(0, 200)
    const error = new Error(`GitHub API ${response.status}（${init.method ?? 'GET'} ${path}）：${message}`)
    error.status = response.status
    error.data = data
    throw error
  }
  return data
}

async function withNotFound(operation) {
  try {
    return { found: true, value: await operation() }
  } catch (error) {
    if (error?.status === 404) return { found: false, value: undefined }
    throw error
  }
}

function branchPath(branch) {
  return branch.split('/').map((part) => encodeURIComponent(part)).join('/')
}

/* ------------------------------------------------------------------ *
 * 令牌解析
 * ------------------------------------------------------------------ */

async function resolveToken(ctx) {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  const credentials = ctx.get('credentials')
  if (credentials) {
    for (const ref of TOKEN_REFS) {
      try {
        const resolved = await credentials.resolve(ref)
        if (resolved && typeof resolved.value === 'string' && resolved.value.trim()) {
          return { token: resolved.value.trim(), source: resolved.source ?? 'credentials', ref }
        }
      } catch {
        /* 尝试下一个名称 */
      }
    }
  }
  if (envToken && envToken.trim()) return { token: envToken.trim(), source: 'environment' }
  return undefined
}

async function fetchViewer(token) {
  const data = await githubRequest(token, '/user')
  return {
    login: data.login,
    name: typeof data.name === 'string' ? data.name : undefined,
    avatarUrl: data.avatar_url,
    htmlUrl: data.html_url,
    type: data.type,
  }
}

async function describeConnection(ctx) {
  const resolved = await resolveToken(ctx)
  if (!resolved) {
    return { configured: false, connected: false, tokenUrl: GITHUB_TOKEN_URL }
  }
  try {
    const viewer = await fetchViewer(resolved.token)
    return { configured: true, connected: true, source: resolved.source, viewer, tokenUrl: GITHUB_TOKEN_URL }
  } catch (error) {
    return {
      configured: true,
      connected: false,
      source: resolved.source,
      error: error instanceof Error ? error.message : String(error),
      tokenUrl: GITHUB_TOKEN_URL,
    }
  }
}

/* ------------------------------------------------------------------ *
 * 本地文件收集
 * ------------------------------------------------------------------ */

function isInside(root, target) {
  const base = resolve(root)
  const abs = resolve(target)
  return abs === base || abs.startsWith(base + sep)
}

async function collectFiles(sourceDir, options) {
  const root = resolve(String(sourceDir ?? '').trim())
  if (!sourceDir || !String(sourceDir).trim()) throw new Error('sourceDir 不能为空。')
  let rootInfo
  try {
    rootInfo = await stat(root)
  } catch {
    throw new Error(`本地目录不存在或不可读：${root}`)
  }
  if (!rootInfo.isDirectory()) throw new Error(`sourceDir 不是目录：${root}`)

  const include = Array.isArray(options.include)
    ? options.include.map((item) => String(item).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')).filter(Boolean)
    : []
  const seen = new Set()
  const files = []

  const push = async (abs, rel) => {
    if (seen.has(rel)) return
    seen.add(rel)
    const info = await stat(abs)
    if (!info.isFile()) return
    files.push({ rel, abs, bytes: info.size })
  }

  if (include.length > 0) {
    for (const rel of include) {
      const abs = resolve(root, rel)
      if (!isInside(root, abs)) throw new Error(`include 路径越出 sourceDir：${rel}`)
      if (!(await stat(abs).catch(() => undefined))?.isFile()) {
        throw new Error(`include 指定的文件不存在：${rel}`)
      }
      await push(abs, rel)
    }
  } else {
    const skippedDirs = new Set(options.skipDirs)
    const walk = async (dir, prefix, depth) => {
      if (depth > MAX_INCLUDE_DEPTH) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name)
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (skippedDirs.has(entry.name)) continue
          await walk(abs, rel, depth + 1)
        } else if (entry.isFile()) {
          if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue
          await push(abs, rel)
        }
      }
    }
    await walk(root, '', 0)
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { root, files }
}

/* ------------------------------------------------------------------ *
 * 审批闸门（每次执行都必须经过）
 * ------------------------------------------------------------------ */

const OUTCOME_MESSAGES = {
  rejected: '用户拒绝了本次操作，已取消。不要绕过授权重试；如果确实需要，请说明原因后等用户主动要求。',
  cancelled: '用户在授权界面上取消了本次操作。',
  unavailable: '宿主没有可用的授权应答器，出于安全原因已拒绝执行（fail closed）。',
}

async function requireUserApproval(ctx, exec, request) {
  if (!exec.agent) throw new Error('当前调用没有会话上下文，无法请求用户授权，已取消。')
  const approval = ctx.get('approval')
  if (!approval) throw new Error('审批服务不可用，出于安全原因拒绝执行（fail closed）。')
  let outcome
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: request.toolName,
      callId: exec.callId,
      reason: request.reason,
      displayReason: request.displayReason,
      signal: exec.signal,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法完成用户授权流程，已取消：${reason}`)
  }
  if (outcome === 'allowed-once') return
  throw new Error(OUTCOME_MESSAGES[outcome] ?? '未获得用户授权，已取消。')
}

/* ------------------------------------------------------------------ *
 * 上传：Git Data API（blobs → tree → commit → ref）
 * ------------------------------------------------------------------ */

async function readPayloads(files, options) {
  const accepted = []
  const skipped = []
  let totalBytes = 0
  for (const file of files) {
    if (accepted.length >= options.maxFiles) {
      skipped.push({ path: file.rel, reason: `超过单次上传文件上限 ${options.maxFiles}` })
      continue
    }
    if (file.bytes > options.maxFileBytes) {
      skipped.push({ path: file.rel, reason: `文件过大（${formatBytes(file.bytes)} > ${formatBytes(options.maxFileBytes)}）` })
      continue
    }
    if (totalBytes + file.bytes > options.maxTotalBytes) {
      skipped.push({ path: file.rel, reason: `超过单次上传总大小上限 ${formatBytes(options.maxTotalBytes)}` })
      continue
    }
    const buffer = await readFile(file.abs)
    totalBytes += buffer.length
    accepted.push({ path: file.rel, bytes: buffer.length, content: buffer.toString('base64') })
  }
  return { accepted, skipped, totalBytes }
}

async function uploadTree(token, target, files, message, signal) {
  const { owner, name } = target
  const repositoryPath = `/repos/${owner}/${name}`
  const repoInfo = await githubRequest(token, repositoryPath, {}, signal)
  const defaultBranch = typeof repoInfo.default_branch === 'string' ? repoInfo.default_branch : 'main'
  const branch = target.branch ?? defaultBranch

  let baseCommitSha
  let parentTreeSha
  let branchExists = false

  const branchRef = await withNotFound(() =>
    githubRequest(token, `${repositoryPath}/git/ref/heads/${branchPath(branch)}`, {}, signal),
  )
  if (branchRef.found) {
    baseCommitSha = branchRef.value.object?.sha
    branchExists = typeof baseCommitSha === 'string'
  }
  if (!branchExists && branch !== defaultBranch) {
    const defaultRef = await withNotFound(() =>
      githubRequest(token, `${repositoryPath}/git/ref/heads/${branchPath(defaultBranch)}`, {}, signal),
    )
    if (defaultRef.found) baseCommitSha = defaultRef.value.object?.sha
  }
  if (typeof baseCommitSha === 'string') {
    const commit = await githubRequest(token, `${repositoryPath}/git/commits/${baseCommitSha}`, {}, signal)
    parentTreeSha = commit.tree?.sha
  }

  const blobs = []
  for (const file of files) {
    const blob = await githubRequest(
      token,
      `${repositoryPath}/git/blobs`,
      { method: 'POST', body: { content: file.content, encoding: 'base64' } },
      signal,
    )
    blobs.push({ path: file.path, sha: blob.sha })
  }

  const tree = await githubRequest(
    token,
    `${repositoryPath}/git/trees`,
    {
      method: 'POST',
      body: {
        ...(parentTreeSha ? { base_tree: parentTreeSha } : {}),
        tree: blobs.map((item) => ({ path: item.path, mode: '100644', type: 'blob', sha: item.sha })),
      },
    },
    signal,
  )

  const commit = await githubRequest(
    token,
    `${repositoryPath}/git/commits`,
    {
      method: 'POST',
      body: {
        message,
        tree: tree.sha,
        parents: typeof baseCommitSha === 'string' ? [baseCommitSha] : [],
      },
    },
    signal,
  )

  if (branchExists) {
    await githubRequest(
      token,
      `${repositoryPath}/git/refs/heads/${branchPath(branch)}`,
      { method: 'PATCH', body: { sha: commit.sha, force: false } },
      signal,
    )
  } else {
    await githubRequest(
      token,
      `${repositoryPath}/git/refs`,
      { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } },
      signal,
    )
  }

  return {
    branch,
    defaultBranch,
    commitSha: commit.sha,
    commitUrl: commit.html_url ?? `${repoInfo.html_url}/commit/${commit.sha}`,
    repositoryUrl: repoInfo.html_url,
    createdBranch: !branchExists,
  }
}

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */

function statusTool(ctx) {
  return {
    name: 'github_status',
    description:
      '检查 DSH 的 GitHub 连接状态：令牌是否已绑定、绑定的是哪个 GitHub 账号、令牌是否仍有效。只读操作，不修改任何仓库或本地文件。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(value),
    },
    async execute() {
      const state = await describeConnection(ctx)
      if (!state.configured) {
        return {
          connected: false,
          hint: `还没有绑定 GitHub 令牌。请让用户打开「设置 → 插件配置 → GitHub 连接」粘贴 Personal Access Token（也需要 repo 权限），或设置环境变量 GITHUB_TOKEN 后重启。创建令牌：${GITHUB_TOKEN_URL}`,
        }
      }
      if (!state.connected) {
        return {
          connected: false,
          tokenPresent: true,
          source: state.source,
          error: state.error,
          hint: '令牌存在但校验失败（可能已过期或被撤销）。请让用户在「设置 → 插件配置 → GitHub 连接」里重新绑定。',
        }
      }
      return {
        connected: true,
        login: state.viewer.login,
        ...(state.viewer.name ? { name: state.viewer.name } : {}),
        profileUrl: state.viewer.htmlUrl,
        accountType: state.viewer.type,
        tokenSource: state.source,
        tokenUrl: GITHUB_TOKEN_URL,
      }
    },
  }
}

function pushTool(ctx, options) {
  return {
    name: 'github_push',
    description:
      '把本地目录里的代码上传到 GitHub 仓库的指定分支（通过 Git Data API 生成一次提交，不覆盖其它文件）。' +
      '**每次调用都会弹出授权请求，只有用户当场同意后才会真正上传**；用户拒绝时工具会失败，不要绕过授权重试。' +
      '需要先在「设置 → 插件配置 → GitHub 连接」绑定 GitHub 令牌。',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '目标仓库，格式 owner/name，例如 octocat/hello-world。' },
        sourceDir: { type: 'string', description: '本地要上传的目录，必须是绝对路径，例如 E:\\work\\my-project。' },
        message: { type: 'string', description: '本次提交的 commit message，写清楚改了什么。' },
        branch: { type: 'string', description: '目标分支，默认使用仓库的默认分支。分支不存在时会基于默认分支最新提交创建。' },
        targetPath: { type: 'string', description: '仓库内的目标目录前缀，默认为仓库根目录，例如 apps/demo。' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: '可选白名单：只上传这些相对路径（相对 sourceDir）。给定时不再递归整个目录。',
        },
      },
      required: ['repo', 'sourceDir', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(value),
    },
    // 授权等待 + 大目录上传可能耗时数分钟，放宽单次工具超时。
    timeoutMs: 15 * 60 * 1000,
    async execute(args, exec) {
      const target = normalizeRepo(args?.repo)
      const message = String(args?.message ?? '').trim()
      if (!message) throw new Error('message 不能为空：请写一条有意义的提交说明。')
      const branch = normalizeBranch(args?.branch)
      const targetPath = normalizeTargetPath(args?.targetPath)

      const resolved = await resolveToken(ctx)
      if (!resolved) {
        throw new Error(`还没有绑定 GitHub 令牌。请让用户在「设置 → 插件配置 → GitHub 连接」里绑定（创建令牌：${GITHUB_TOKEN_URL}）。`)
      }

      const { root, files } = await collectFiles(args?.sourceDir, {
        include: args?.include,
        skipDirs: options.skipDirs,
      })
      if (files.length === 0) throw new Error(`目录里没有可上传的文件：${root}`)

      const { accepted, skipped, totalBytes } = await readPayloads(files, options)
      if (accepted.length === 0) {
        throw new Error(`没有任何文件满足上传条件（共 ${files.length} 个文件被跳过）。${skipped.length ? '原因：' + skipped[0].reason : ''}`)
      }

      const branchLabel = branch ?? '(默认分支)'
      const targetLabel = targetPath ? `${target.fullName}/${targetPath}` : target.fullName
      await requireUserApproval(ctx, exec, {
        toolName: 'github_push',
        reason:
          `Upload ${accepted.length} file(s) (${formatBytes(totalBytes)}) from ${root} ` +
          `to github.com/${target.fullName} branch "${branchLabel}"${targetPath ? ` path "${targetPath}"` : ''}; commit: ${message}`,
        displayReason: {
          en:
            `Upload ${accepted.length} files to github.com/${targetLabel} (branch ${branchLabel}): ` +
            `${message}`,
          zh: `上传 ${accepted.length} 个文件到 github.com/${targetLabel}（分支 ${branchLabel}）：${message}`,
        },
      })

      const result = await uploadTree(
        resolved.token,
        { owner: target.owner, name: target.name, branch },
        accepted.map((file) => ({ path: targetPath ? `${targetPath}/${file.path}` : file.path, content: file.content })),
        message,
        exec.signal,
      )

      return {
        ok: true,
        repository: target.fullName,
        repositoryUrl: result.repositoryUrl,
        branch: result.branch,
        createdBranch: result.createdBranch,
        commitSha: result.commitSha,
        commitUrl: result.commitUrl,
        uploaded: accepted.length,
        totalBytes,
        files: accepted.slice(0, 50).map((file) => file.path),
        ...(accepted.length > 50 ? { filesTruncated: true } : {}),
        ...(skipped.length ? { skipped: skipped.slice(0, 20), skippedCount: skipped.length } : {}),
      }
    },
  }
}

function createRepoTool(ctx) {
  return {
    name: 'github_create_repo',
    description:
      '在已绑定的 GitHub 账号下新建一个仓库。**每次调用都会弹出授权请求**，只有用户当场同意后才会创建。' +
      '创建完成后可以再用 github_push 上传代码。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '仓库名，例如 hello-world。' },
        description: { type: 'string', description: '仓库简介。' },
        private: { type: 'boolean', description: '是否创建为私有仓库，默认 true。' },
        autoInit: { type: 'boolean', description: '是否附带 README 初始化提交，默认 false。' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(value),
    },
    timeoutMs: 5 * 60 * 1000,
    async execute(args, exec) {
      const name = String(args?.name ?? '').trim()
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error(`仓库名不合法：${JSON.stringify(args?.name)}`)
      const isPrivate = args?.private !== false
      const description = typeof args?.description === 'string' ? args.description.trim() : ''
      const autoInit = args?.autoInit === true

      const resolved = await resolveToken(ctx)
      if (!resolved) {
        throw new Error(`还没有绑定 GitHub 令牌。请让用户在「设置 → 插件配置 → GitHub 连接」里绑定（创建令牌：${GITHUB_TOKEN_URL}）。`)
      }
      const viewer = await fetchViewer(resolved.token)

      await requireUserApproval(ctx, exec, {
        toolName: 'github_create_repo',
        reason: `Create ${isPrivate ? 'private' : 'public'} GitHub repository ${viewer.login}/${name}`,
        displayReason: {
          en: `Create ${isPrivate ? 'private' : 'public'} repository github.com/${viewer.login}/${name}`,
          zh: `在 github.com/${viewer.login} 下创建${isPrivate ? '私有' : '公开'}仓库 ${name}`,
        },
      })

      const created = await githubRequest(
        resolved.token,
        '/user/repos',
        {
          method: 'POST',
          body: {
            name,
            private: isPrivate,
            ...(description ? { description } : {}),
            auto_init: autoInit,
          },
        },
        exec.signal,
      )

      return {
        ok: true,
        fullName: created.full_name,
        url: created.html_url,
        defaultBranch: created.default_branch,
        private: created.private,
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * 设置卡片路由
 * ------------------------------------------------------------------ */

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((done) => {
    let size = 0
    let settled = false
    const chunks = []
    const finish = (value) => {
      if (!settled) {
        settled = true
        done(value)
      }
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        finish({})
        return
      }
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
  })
}

function isLoopbackHost(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

// 变更请求的跨站防护：只拒绝 Origin 明确指向外部站点的请求。
// 本机回环、file://（Origin: null）、非浏览器客户端（无 Origin）一律放行——
// 在 Electron 等非标准载入环境里，靠 Sec-Fetch-Site 推断会误伤正常请求。
function hasLocalOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || !origin || origin === 'null') return true
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return true
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
  return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
}

function makeRoutes(ctx) {
  const guard = async (req, res, method) => {
    if (!isLoopbackHost(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { ok: false, error: `method not allowed: ${String(req.method)}` })
      return false
    }
    if (method === 'POST' && !hasLocalOrigin(req)) {
      writeJson(res, 403, { ok: false, error: `cross-origin change request rejected (origin: ${String(req.headers.origin)})` })
      return false
    }
    return true
  }

  const stateBody = async () => {
    const state = await describeConnection(ctx)
    return {
      configured: state.configured === true,
      connected: state.connected === true,
      ...(state.source ? { source: state.source } : {}),
      ...(state.viewer ? { login: state.viewer.login, name: state.viewer.name, avatarUrl: state.viewer.avatarUrl, profileUrl: state.viewer.htmlUrl } : {}),
      ...(state.error ? { error: state.error } : {}),
      tokenUrl: GITHUB_TOKEN_URL,
    }
  }

  return [
    {
      kind: 'exact',
      path: '/api/dsh-github/state',
      handler: async (req, res) => {
        if (!(await guard(req, res, 'GET'))) return
        try {
          writeJson(res, 200, { ok: true, ...(await stateBody()) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-github/repos',
      handler: async (req, res) => {
        if (!(await guard(req, res, 'GET'))) return
        const resolved = await resolveToken(ctx)
        if (!resolved) {
          writeJson(res, 200, { ok: true, configured: false, connected: false, repos: [] })
          return
        }
        try {
          const [viewer, repositories] = await Promise.all([
            fetchViewer(resolved.token),
            githubRequest(
              resolved.token,
              '/user/repos?sort=updated&direction=desc&per_page=30&affiliation=owner,collaborator,organization_member',
            ),
          ])
          writeJson(res, 200, {
            ok: true,
            configured: true,
            connected: true,
            login: viewer.login,
            avatarUrl: viewer.avatarUrl,
            profileUrl: viewer.htmlUrl,
            repos: (Array.isArray(repositories) ? repositories : []).map((repo) => ({
              fullName: repo.full_name,
              htmlUrl: repo.html_url,
              private: repo.private === true,
              description: typeof repo.description === 'string' ? repo.description : '',
              language: typeof repo.language === 'string' ? repo.language : '',
              updatedAt: typeof repo.updated_at === 'string' ? repo.updated_at : '',
              stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
              archived: repo.archived === true,
            })),
          })
        } catch (error) {
          writeJson(res, 200, {
            ok: true,
            configured: true,
            connected: false,
            error: error instanceof Error ? error.message : String(error),
            repos: [],
          })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-github/repo',
      handler: async (req, res) => {
        if (!(await guard(req, res, 'GET'))) return
        const resolved = await resolveToken(ctx)
        if (!resolved) {
          writeJson(res, 200, { ok: false, error: '还没有绑定 GitHub 令牌。' })
          return
        }
        let target
        try {
          const params = new URL(req.url, 'http://localhost').searchParams
          target = normalizeRepo(params.get('repo'))
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        try {
          const info = await githubRequest(resolved.token, `/repos/${target.owner}/${target.name}`)
          const readmeResult = await withNotFound(() =>
            githubRequest(resolved.token, `/repos/${target.owner}/${target.name}/readme`),
          )
          let readme = null
          if (readmeResult.found && readmeResult.value && typeof readmeResult.value.content === 'string') {
            readme = {
              name: readmeResult.value.name,
              htmlUrl: readmeResult.value.html_url,
              content: decodeBase64Text(readmeResult.value.content),
            }
          }
          writeJson(res, 200, {
            ok: true,
            repo: {
              fullName: info.full_name,
              description: typeof info.description === 'string' ? info.description : '',
              htmlUrl: info.html_url,
              private: info.private === true,
              defaultBranch: typeof info.default_branch === 'string' ? info.default_branch : 'main',
              stars: typeof info.stargazers_count === 'number' ? info.stargazers_count : 0,
              forks: typeof info.forks_count === 'number' ? info.forks_count : 0,
              language: typeof info.language === 'string' ? info.language : '',
              updatedAt: typeof info.updated_at === 'string' ? info.updated_at : '',
              topics: Array.isArray(info.topics) ? info.topics.slice(0, 8) : [],
            },
            readme,
          })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-github/tree',
      handler: async (req, res) => {
        if (!(await guard(req, res, 'GET'))) return
        const resolved = await resolveToken(ctx)
        if (!resolved) {
          writeJson(res, 200, { ok: false, error: '还没有绑定 GitHub 令牌。' })
          return
        }
        let target
        let path
        let ref
        try {
          const params = new URL(req.url, 'http://localhost').searchParams
          target = normalizeRepo(params.get('repo'))
          path = normalizeContentPath(params.get('path'))
          ref = params.get('ref') || undefined
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        try {
          const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
          const data = await githubRequest(
            resolved.token,
            `/repos/${target.owner}/${target.name}/contents/${encodeContentPath(path)}${query}`,
          )
          if (!Array.isArray(data)) {
            writeJson(res, 200, { ok: false, error: '这个路径不是目录。' })
            return
          }
          const entries = data
            .map((entry) => ({
              name: String(entry.name ?? ''),
              path: String(entry.path ?? ''),
              type: String(entry.type ?? 'file'),
              size: typeof entry.size === 'number' ? entry.size : 0,
              htmlUrl: String(entry.html_url ?? ''),
            }))
            .filter((entry) => entry.name)
            .sort((a, b) => {
              const aDir = a.type === 'dir' ? 0 : 1
              const bDir = b.type === 'dir' ? 0 : 1
              return aDir - bDir || a.name.localeCompare(b.name)
            })
          writeJson(res, 200, { ok: true, path, entries })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-github/file',
      handler: async (req, res) => {
        if (!(await guard(req, res, 'GET'))) return
        const resolved = await resolveToken(ctx)
        if (!resolved) {
          writeJson(res, 200, { ok: false, error: '还没有绑定 GitHub 令牌。' })
          return
        }
        let target
        let path
        let ref
        try {
          const params = new URL(req.url, 'http://localhost').searchParams
          target = normalizeRepo(params.get('repo'))
          path = normalizeContentPath(params.get('path'))
          ref = params.get('ref') || undefined
          if (!path) throw new Error('缺少文件路径。')
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        try {
          const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
          const data = await githubRequest(
            resolved.token,
            `/repos/${target.owner}/${target.name}/contents/${encodeContentPath(path)}${query}`,
          )
          if (Array.isArray(data) || data?.type !== 'file') {
            writeJson(res, 200, { ok: false, error: '这个路径不是文件。' })
            return
          }
          if (typeof data.content !== 'string' || data.encoding !== 'base64') {
            writeJson(res, 200, {
              ok: true,
              path,
              name: String(data.name ?? ''),
              size: typeof data.size === 'number' ? data.size : 0,
              tooLarge: true,
              binary: false,
              truncated: false,
              content: '',
            })
            return
          }
          const buffer = Buffer.from(data.content.replace(/\s+/g, ''), 'base64')
          const tooLarge = buffer.length > MAX_PREVIEW_BYTES
          const slice = tooLarge ? buffer.subarray(0, MAX_PREVIEW_BYTES) : buffer
          const binary = slice.includes(0)
          writeJson(res, 200, {
            ok: true,
            path,
            name: String(data.name ?? ''),
            size: typeof data.size === 'number' ? data.size : buffer.length,
            tooLarge,
            binary,
            truncated: tooLarge,
            content: binary ? '' : slice.toString('utf8'),
          })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-github/token',
      handler: async (req, res) => {
        if (!(await guard(req, res, 'POST'))) return
        const body = await readJsonBody(req)
        if (!body || typeof body.token !== 'string') {
          writeJson(res, 400, { ok: false, error: 'invalid body: expected { token: string }' })
          return
        }
        const token = body.token.trim()
        if (!token) {
          writeJson(res, 400, { ok: false, error: '令牌不能为空' })
          return
        }
        const credentials = ctx.get('credentials')
        if (!credentials) {
          writeJson(res, 503, { ok: false, error: '宿主凭据服务不可用，无法保存令牌。' })
          return
        }
        let viewer
        try {
          viewer = await fetchViewer(token)
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        try {
          await credentials.set('GITHUB_TOKEN', token)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: '保存令牌失败：' + (error instanceof Error ? error.message : String(error)) })
          return
        }
        writeJson(res, 200, { ok: true, configured: true, connected: true, source: 'credentials', login: viewer.login, name: viewer.name, avatarUrl: viewer.avatarUrl, profileUrl: viewer.htmlUrl, tokenUrl: GITHUB_TOKEN_URL })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-github/token/clear',
      handler: async (req, res) => {
        if (!(await guard(req, res, 'POST'))) return
        const credentials = ctx.get('credentials')
        if (!credentials) {
          writeJson(res, 503, { ok: false, error: '宿主凭据服务不可用。' })
          return
        }
        try {
          await credentials.unset('GITHUB_TOKEN')
        } catch (error) {
          writeJson(res, 500, { ok: false, error: '清除令牌失败：' + (error instanceof Error ? error.message : String(error)) })
          return
        }
        writeJson(res, 200, { ok: true, ...(await stateBody()) })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-github/test',
      handler: async (req, res) => {
        if (!(await guard(req, res, 'POST'))) return
        try {
          writeJson(res, 200, { ok: true, ...(await stateBody()) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

const GUIDANCE =
  'GitHub 插件（@local/dsh-github）已安装：用户要求「把代码上传到 GitHub / 推送到 GitHub 仓库」时，' +
  '先用 github_status 确认账号已绑定；未绑定时提示用户打开「设置 → 插件配置 → GitHub 连接」绑定 Personal Access Token。' +
  '上传用 github_push（repo 用 owner/name，sourceDir 用绝对路径，message 写清改了什么）；需要新仓库时用 github_create_repo。' +
  'github_push 与 github_create_repo 每次都会向用户弹出授权请求，只有当场同意才执行；用户拒绝后不要绕过授权重试。'

export function apply(ctx, config) {
  const options = {
    maxFiles: asInt(config?.maxFiles, 400),
    maxFileBytes: asInt(config?.maxFileBytes, 20 * 1024 * 1024),
    maxTotalBytes: asInt(config?.maxTotalBytes, 60 * 1024 * 1024),
    skipDirs: Array.isArray(config?.skipDirs)
      ? config.skipDirs.map((item) => String(item)).filter(Boolean)
      : DEFAULT_SKIP_DIRS,
  }

  ctx.inject(['tools'], (toolCtx) => {
    const definitions = [statusTool(ctx), pushTool(ctx, options), createRepoTool(ctx)]
    for (const definition of definitions) {
      toolCtx.effect(
        () => toolCtx.tools.register(definition),
        `github-connector: tool ${definition.name}`,
      )
    }
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = makeRoutes(ctx).map((route) => webCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 释放失败不阻塞卸载 */
          }
        }
      }
    }, 'github-connector: routes')
  })

  if (config?.announce !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(
        () =>
          promptCtx.systemPrompt.section({
            name: 'plugin:dsh-github-connector',
            order: 152,
            text: GUIDANCE,
          }),
        'github-connector: announcement',
      )
    })
  }

  console.log('[dsh-github] mounted')
}

/** 仅用于仓库内离线冒烟测试，不参与运行时注册。 */
export const __test = {
  collectFiles,
  readPayloads,
  uploadTree,
  requireUserApproval,
  statusTool,
  pushTool,
  createRepoTool,
  makeRoutes,
  normalizeRepo,
  normalizeBranch,
  normalizeTargetPath,
}
