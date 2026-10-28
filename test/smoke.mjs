/**
 * 离线冒烟测试：不访问真实 GitHub，用 mock fetch 验证
 *   1) 路径/仓库名规范化
 *   2) 本地目录收集（跳过 .git / node_modules）
 *   3) Git Data API 上传序列（已有分支 / 空仓库 / 新分支派生）
 *   4) 授权闸门：拒绝、取消、无应答器一律不执行；allowed-once 才放行
 *   5) 端到端：用户拒绝时完全不发网络请求
 *
 * 运行：node test/smoke.mjs
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __test } from '../index.js'

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n  actual:   ${a}\n  expected: ${e}`)
}
async function assertRejects(fn, matcher) {
  try {
    await fn()
  } catch (error) {
    if (matcher && !matcher.test(error.message)) {
      throw new Error(`错误信息不匹配：${error.message}`)
    }
    return error
  }
  throw new Error('预期抛错，但没有抛')
}

/* ---------------- mock GitHub ---------------- */

function makeGithubMock(scenario) {
  const calls = []
  const state = { blobs: 0 }
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url, method: init.method ?? 'GET', body })
    const respond = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

    const path = url.replace('https://api.github.com', '')
    const method = init.method ?? 'GET'

    if (path === '/repos/octocat/demo' && method === 'GET') {
      return respond(200, { default_branch: 'main', html_url: 'https://github.com/octocat/demo' })
    }
    if (scenario === 'existing-branch') {
      if (path === '/repos/octocat/demo/git/ref/heads/main' && method === 'GET') {
        return respond(200, { object: { sha: 'base-commit' } })
      }
      if (path === '/repos/octocat/demo/git/commits/base-commit' && method === 'GET') {
        return respond(200, { sha: 'base-commit', tree: { sha: 'base-tree' } })
      }
    }
    if (scenario === 'empty-repo') {
      if (path.startsWith('/repos/octocat/demo/git/ref/') && method === 'GET') {
        return respond(404, { message: 'Not Found' })
      }
    }
    if (scenario === 'new-branch') {
      if (path === '/repos/octocat/demo/git/ref/heads/feature' && method === 'GET') {
        return respond(404, { message: 'Not Found' })
      }
      if (path === '/repos/octocat/demo/git/ref/heads/main' && method === 'GET') {
        return respond(200, { object: { sha: 'main-head' } })
      }
      if (path === '/repos/octocat/demo/git/commits/main-head' && method === 'GET') {
        return respond(200, { tree: { sha: 'main-tree' } })
      }
    }
    if (path === '/repos/octocat/demo/git/blobs' && method === 'POST') {
      state.blobs += 1
      assert(typeof body.content === 'string' && body.encoding === 'base64', 'blob 必须是 base64')
      return respond(201, { sha: `blob-${state.blobs}` })
    }
    if (path === '/repos/octocat/demo/git/trees' && method === 'POST') {
      return respond(201, { sha: 'new-tree', tree: body.tree })
    }
    if (path === '/repos/octocat/demo/git/commits' && method === 'POST') {
      return respond(201, { sha: 'new-commit', html_url: 'https://github.com/octocat/demo/commit/new-commit' })
    }
    if (path === '/repos/octocat/demo/git/refs/heads/main' && method === 'PATCH') {
      return respond(200, { object: { sha: body.sha } })
    }
    if (path === '/repos/octocat/demo/git/refs' && method === 'POST') {
      return respond(201, { ref: body.ref, object: { sha: body.sha } })
    }
    if (path === '/user' && method === 'GET') {
      return respond(200, { login: 'octocat', name: 'The Octocat', avatar_url: 'https://x/a.png', html_url: 'https://github.com/octocat', type: 'User' })
    }
    if (path === '/user/repos' && method === 'POST') {
      return respond(201, { full_name: `octocat/${body.name}`, html_url: `https://github.com/octocat/${body.name}`, default_branch: 'main', private: body.private })
    }
    return respond(500, { message: `mock: 未处理的请求 ${method} ${path}` })
  }
  return { calls, state }
}

/* ---------------- 测试主体 ---------------- */

delete process.env.GITHUB_TOKEN
delete process.env.GH_TOKEN

let tempRoot

console.log('\n[1] 参数规范化')
check('normalizeRepo 接受 owner/name', () => {
  assertEqual(__test.normalizeRepo('octocat/hello-world'), { owner: 'octocat', name: 'hello-world', fullName: 'octocat/hello-world' }, 'repo 解析错误')
})
check('normalizeRepo 拒绝非法值', () => {
  let threw = false
  try {
    __test.normalizeRepo('not a repo')
  } catch {
    threw = true
  }
  assert(threw, '应当拒绝非法 repo')
})
check('normalizeTargetPath 去掉首尾斜杠', () => {
  assertEqual(__test.normalizeTargetPath('/apps/demo/'), 'apps/demo', 'targetPath 规范化错误')
  assertEqual(__test.normalizeTargetPath(''), '', '空 targetPath 应返回空串')
})

console.log('\n[2] 本地目录收集')
await checkAsync('递归收集并跳过 .git / node_modules', async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'ghc-'))
  await mkdir(join(tempRoot, 'src'), { recursive: true })
  await mkdir(join(tempRoot, 'node_modules', 'x'), { recursive: true })
  await mkdir(join(tempRoot, '.git'), { recursive: true })
  await writeFile(join(tempRoot, 'README.md'), '# demo\n')
  await writeFile(join(tempRoot, 'src', 'a.js'), 'export const a = 1\n')
  await writeFile(join(tempRoot, 'node_modules', 'x', 'index.js'), 'noop\n')
  await writeFile(join(tempRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const { files } = await __test.collectFiles(tempRoot, { skipDirs: __test.collectFiles ? defaultSkip() : [] })
  assertEqual(files.map((file) => file.rel), ['README.md', 'src/a.js'], '收集结果不符')
})

function defaultSkip() {
  return ['.git', 'node_modules']
}

console.log('\n[3] Git Data API 上传序列')
await checkAsync('已有分支：blob×N → trees → commits → PATCH ref', async () => {
  const mock = makeGithubMock('existing-branch')
  const result = await __test.uploadTree('ghp_x', { owner: 'octocat', name: 'demo', branch: undefined }, [
    { path: 'README.md', content: Buffer.from('# hi\n').toString('base64') },
    { path: 'src/a.js', content: Buffer.from('a=1\n').toString('base64') },
  ], 'docs: add demo', undefined)
  const sequence = mock.calls.map((call) => `${call.method} ${call.url.replace('https://api.github.com', '')}`)
  assertEqual(sequence, [
    'GET /repos/octocat/demo',
    'GET /repos/octocat/demo/git/ref/heads/main',
    'GET /repos/octocat/demo/git/commits/base-commit',
    'POST /repos/octocat/demo/git/blobs',
    'POST /repos/octocat/demo/git/blobs',
    'POST /repos/octocat/demo/git/trees',
    'POST /repos/octocat/demo/git/commits',
    'PATCH /repos/octocat/demo/git/refs/heads/main',
  ], '请求序列不符')
  const treeCall = mock.calls.find((call) => call.url.endsWith('/git/trees'))
  assert(treeCall.body.base_tree === 'base-tree', 'trees 必须基于 base_tree 叠加，否则会误删其它文件')
  const commitCall = mock.calls.find((call) => call.url.endsWith('/git/commits'))
  assertEqual(commitCall.body.parents, ['base-commit'], '父提交错误')
  assertEqual(commitCall.body.message, 'docs: add demo', 'commit message 错误')
  assertEqual(result.commitSha, 'new-commit', 'commit sha 错误')
})

await checkAsync('空仓库：无 base_tree、无父提交，并创建 ref', async () => {
  const mock = makeGithubMock('empty-repo')
  await __test.uploadTree('ghp_x', { owner: 'octocat', name: 'demo', branch: 'main' }, [
    { path: 'README.md', content: Buffer.from('# hi\n').toString('base64') },
  ], 'init', undefined)
  const treeCall = mock.calls.find((call) => call.url.endsWith('/git/trees'))
  assert(treeCall.body.base_tree === undefined, '空仓库不应带 base_tree')
  const commitCall = mock.calls.find((call) => call.url.endsWith('/git/commits'))
  assertEqual(commitCall.body.parents, [], '空仓库的首次提交不应有父提交')
  const createRef = mock.calls.find((call) => call.url.endsWith('/git/refs') && call.method === 'POST')
  assert(createRef, '应创建分支 ref')
  assertEqual(createRef.body.ref, 'refs/heads/main', 'ref 名错误')
})

await checkAsync('新分支：基于默认分支最新提交派生', async () => {
  const mock = makeGithubMock('new-branch')
  const result = await __test.uploadTree('ghp_x', { owner: 'octocat', name: 'demo', branch: 'feature' }, [
    { path: 'README.md', content: Buffer.from('# hi\n').toString('base64') },
  ], 'feat: branch', undefined)
  const commitCall = mock.calls.find((call) => call.url.endsWith('/git/commits'))
  assertEqual(commitCall.body.parents, ['main-head'], '应从默认分支派生')
  assertEqual(result.createdBranch, true, '应标记为新建分支')
})

await checkAsync('GitHub 404 以外的错误会向上抛', async () => {
  makeGithubMock('existing-branch')
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
  await assertRejects(
    () => __test.uploadTree('bad', { owner: 'octocat', name: 'demo', branch: undefined }, [{ path: 'a', content: 'YQ==' }], 'x', undefined),
    /Bad credentials/,
  )
})

console.log('\n[4] 授权闸门')
function fakeContext({ approvals, approvalOutcome, hasApproval = true }) {
  const approval = {
    async request(request) {
      approvals.push(request)
      return approvalOutcome
    },
  }
  const credentials = {
    async resolve(ref) {
      return ref === 'GITHUB_TOKEN' ? { value: 'ghp_test_token', source: 'credentials' } : undefined
    },
  }
  return {
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'approval') return hasApproval ? approval : undefined
      return undefined
    },
  }
}

await checkAsync('allowed-once 放行', async () => {
  const approvals = []
  await __test.requireUserApproval(fakeContext({ approvals, approvalOutcome: 'allowed-once' }), {
    agent: { id: 's1' },
    callId: 'c1',
    signal: undefined,
  }, { toolName: 'github_push', reason: 'up', displayReason: { en: 'up', zh: '上传' } })
  assertEqual(approvals.length, 1, '应恰好请求一次授权')
  assertEqual(approvals[0].toolName, 'github_push', 'toolName 错误')
})

for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
  await checkAsync(`${outcome} 一律拒绝执行`, async () => {
    await assertRejects(
      () => __test.requireUserApproval(fakeContext({ approvals: [], approvalOutcome: outcome }), {
        agent: { id: 's1' },
        callId: 'c1',
        signal: undefined,
      }, { toolName: 'github_create_repo', reason: 'x', displayReason: { en: 'x', zh: 'x' } }),
    )
  })
}

await checkAsync('没有审批服务时 fail closed', async () => {
  await assertRejects(
    () => __test.requireUserApproval(fakeContext({ approvals: [], approvalOutcome: 'allowed-once', hasApproval: false }), {
      agent: { id: 's1' },
      callId: 'c1',
      signal: undefined,
    }, { toolName: 'github_push', reason: 'x', displayReason: { en: 'x', zh: 'x' } }),
    /审批服务不可用/,
  )
})

console.log('\n[5] 端到端：用户拒绝时零网络请求')
await checkAsync('github_push 在授权被拒后不访问 GitHub', async () => {
  const mock = makeGithubMock('existing-branch')
  const ctx = fakeContext({ approvals: [], approvalOutcome: 'rejected' })
  const tool = __test.pushTool(ctx, { maxFiles: 400, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, skipDirs: defaultSkip() })
  const error = await assertRejects(
    () => tool.execute(
      { repo: 'octocat/demo', sourceDir: tempRoot, message: 'docs: update' },
      { agent: { id: 's1' }, callId: 'c1', signal: undefined },
    ),
    /用户拒绝/,
  )
  assert(error.message.includes('用户拒绝'), '应返回用户拒绝的原因')
  assertEqual(mock.calls.length, 0, '用户拒绝后不允许发出任何 GitHub 请求')
})

await checkAsync('github_push 授权通过后完成上传', async () => {
  const mock = makeGithubMock('existing-branch')
  const approvals = []
  const ctx = fakeContext({ approvals, approvalOutcome: 'allowed-once' })
  const tool = __test.pushTool(ctx, { maxFiles: 400, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, skipDirs: defaultSkip() })
  const value = await tool.execute(
    { repo: 'octocat/demo', sourceDir: tempRoot, message: 'docs: update', targetPath: 'apps/demo' },
    { agent: { id: 's1' }, callId: 'c1', signal: undefined },
  )
  assertEqual(value.ok, true, '应成功')
  assertEqual(value.uploaded, 2, '应上传两个文件')
  assertEqual(value.branch, 'main', '默认分支应来自仓库信息')
  const treeCall = mock.calls.find((call) => call.url.endsWith('/git/trees'))
  assertEqual(treeCall.body.tree.map((item) => item.path), ['apps/demo/README.md', 'apps/demo/src/a.js'], 'targetPath 未生效')
  assertEqual(approvals.length, 1, '应请求一次授权')
  assert(approvals[0].displayReason.zh.includes('octocat/demo'), '授权理由应包含仓库')
})

console.log('\n[6] 创建仓库同样受授权约束')
await checkAsync('github_create_repo 被拒绝时不创建', async () => {
  const mock = makeGithubMock('existing-branch')
  const ctx = fakeContext({ approvals: [], approvalOutcome: 'rejected' })
  const tool = __test.createRepoTool(ctx)
  await assertRejects(
    () => tool.execute({ name: 'demo', private: true }, { agent: { id: 's1' }, callId: 'c1', signal: undefined }),
    /用户拒绝/,
  )
  assertEqual(mock.calls.length, 1, '拒绝后只允许一次只读身份查询')
  assertEqual(
    mock.calls.map((call) => `${call.method} ${call.url.replace('https://api.github.com', '')}`),
    ['GET /user'],
    '拒绝后不允许任何写操作',
  )
})

console.log('\n[7] 仓库列表路由（侧边栏 GitHub 面板用）')
function fakeRequest(method = 'GET', host = '127.0.0.1:49568', url = '/') {
  return { method, headers: { host }, url, on() {} }
}
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(text) {
      this.body = text
    },
  }
}

await checkAsync('未绑定时返回空列表且不报错', async () => {
  const credentials = { async resolve() { return undefined } }
  const routes = __test.makeRoutes({ get: (name) => (name === 'credentials' ? credentials : undefined) })
  const route = routes.find((item) => item.path === '/api/dsh-github/repos')
  assert(route, '应注册 /api/dsh-github/repos')
  const res = fakeResponse()
  await route.handler(fakeRequest('GET'), res)
  const body = JSON.parse(res.body)
  assertEqual(body.configured, false, 'configured 应为 false')
  assertEqual(body.repos, [], 'repos 应为空数组')
})

await checkAsync('已绑定时返回映射后的仓库列表', async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith('/user')) {
      return new Response(JSON.stringify({ login: 'octocat', avatar_url: 'https://x/a.png', html_url: 'https://github.com/octocat', type: 'User' }), { status: 200 })
    }
    if (url.includes('/user/repos')) {
      return new Response(JSON.stringify([{
        full_name: 'octocat/demo',
        html_url: 'https://github.com/octocat/demo',
        private: true,
        description: 'demo repo',
        language: 'TypeScript',
        updated_at: '2026-10-01T00:00:00Z',
        stargazers_count: 3,
        archived: false,
      }]), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  const credentials = { async resolve() { return { value: 'ghp_t', source: 'credentials' } } }
  const routes = __test.makeRoutes({ get: (name) => (name === 'credentials' ? credentials : undefined) })
  const route = routes.find((item) => item.path === '/api/dsh-github/repos')
  const res = fakeResponse()
  await route.handler(fakeRequest('GET'), res)
  const body = JSON.parse(res.body)
  assertEqual(body.connected, true, '应已连接')
  assertEqual(body.login, 'octocat', 'login 错误')
  assertEqual(body.repos.length, 1, '仓库数量错误')
  assertEqual(body.repos[0].fullName, 'octocat/demo', '仓库名错误')
  assertEqual(body.repos[0].private, true, 'private 标记错误')
  assertEqual(body.repos[0].language, 'TypeScript', '语言字段错误')
})

console.log('\n[8] 变更请求的跨站防护')
await checkAsync('外部站点 Origin 的 POST -> 403', async () => {
  const routes = __test.makeRoutes({ get: () => undefined })
  const route = routes.find((item) => item.path === '/api/dsh-github/token/clear')
  assert(route, '应注册 /api/dsh-github/token/clear')
  const res = fakeResponse()
  const req = fakeRequest('POST')
  req.headers.origin = 'https://evil.example'
  await route.handler(req, res)
  assertEqual(res.statusCode, 403, '应拒绝外部站点发起的变更请求')
  assert(/cross-origin/.test(res.body), '错误信息应说明跨站被拒')
})

for (const origin of ['http://127.0.0.1:62980', 'http://localhost:62980', 'null', undefined]) {
  await checkAsync(`Origin=${String(origin)} 的 POST 不被守卫拦下`, async () => {
    const routes = __test.makeRoutes({ get: () => undefined })
    const route = routes.find((item) => item.path === '/api/dsh-github/token/clear')
    const res = fakeResponse()
    const req = fakeRequest('POST')
    if (origin !== undefined) req.headers.origin = origin
    await route.handler(req, res)
    assert(res.statusCode !== 403, '本机 / null / 无 Origin 的请求不应被守卫拒绝')
  })
}

console.log('\n[9] 面板内仓库浏览路由')
function routesWithToken() {
  const credentials = { async resolve() { return { value: 'ghp_t', source: 'credentials' } } }
  return __test.makeRoutes({ get: (name) => (name === 'credentials' ? credentials : undefined) })
}
async function callRoute(routes, path, query) {
  const route = routes.find((item) => item.path === path)
  assert(route, `应注册 ${path}`)
  const res = fakeResponse()
  await route.handler(fakeRequest('GET', '127.0.0.1:49568', `${path}${query}`), res)
  return JSON.parse(res.body)
}

await checkAsync('repo 路由返回元信息与 README', async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith('/readme')) {
      return new Response(JSON.stringify({ name: 'README.md', content: Buffer.from('# hi\n').toString('base64'), html_url: 'u' }), { status: 200 })
    }
    if (/\/repos\/octocat\/demo$/.test(url)) {
      return new Response(JSON.stringify({
        full_name: 'octocat/demo', description: 'd', html_url: 'h', private: false,
        default_branch: 'main', stargazers_count: 5, forks_count: 2, language: 'JS',
        updated_at: '2026-01-01T00:00:00Z', topics: ['a'],
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  const body = await callRoute(routesWithToken(), '/api/dsh-github/repo', '?repo=octocat/demo')
  assertEqual(body.ok, true, 'ok 应为 true')
  assertEqual(body.repo.fullName, 'octocat/demo', '仓库名错误')
  assertEqual(body.repo.stars, 5, '星标数错误')
  assertEqual(body.readme.content, '# hi\n', 'README 解码错误')
})

await checkAsync('tree 路由目录排在文件前', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify([
      { name: 'z.js', path: 'z.js', type: 'file', size: 10, html_url: 'u' },
      { name: 'src', path: 'src', type: 'dir', size: 0, html_url: 'u' },
      { name: 'a.md', path: 'a.md', type: 'file', size: 20, html_url: 'u' },
    ]), { status: 200 })
  const body = await callRoute(routesWithToken(), '/api/dsh-github/tree', '?repo=octocat/demo&path=')
  assertEqual(body.entries.map((entry) => entry.name), ['src', 'a.md', 'z.js'], '目录应排在最前')
})

await checkAsync('file 路由返回文本内容', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ type: 'file', name: 'a.js', size: 6, encoding: 'base64', content: Buffer.from('a = 1\n').toString('base64') }), { status: 200 })
  const body = await callRoute(routesWithToken(), '/api/dsh-github/file', '?repo=octocat/demo&path=src/a.js')
  assertEqual(body.content, 'a = 1\n', '内容解码错误')
  assertEqual(body.binary, false, '不应判定为二进制')
})

await checkAsync('file 路由识别二进制文件', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ type: 'file', name: 'a.png', size: 4, encoding: 'base64', content: Buffer.from([0x89, 0x50, 0x00, 0x01]).toString('base64') }), { status: 200 })
  const body = await callRoute(routesWithToken(), '/api/dsh-github/file', '?repo=octocat/demo&path=a.png')
  assertEqual(body.binary, true, '应识别为二进制')
})

await checkAsync('路径穿越被拒绝', async () => {
  const body = await callRoute(routesWithToken(), '/api/dsh-github/file', '?repo=octocat/demo&path=../../etc/passwd')
  assertEqual(body.ok, false, '应拒绝越权路径')
  assert(/路径不合法/.test(body.error), '错误信息应说明路径不合法')
})

if (tempRoot) await rm(tempRoot, { recursive: true, force: true })

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.error('失败用例：' + failed.map((item) => item.name).join(', '))
  process.exit(1)
}
