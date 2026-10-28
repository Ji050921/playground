/**
 * @local/dsh-github — 浏览器半体。
 *
 * 三个挂载点：
 *   1. 侧边栏「GitHub」图标（sidebar.panellist）→ 主区域 GitHub 面板（main#github）；
 *   2. 插件配置页里的「GitHub 连接」卡片（plugins.bundle.config）绑定令牌；
 *   3. 面板顶部可直接在系统浏览器打开 GitHub。
 *
 * 令牌经 /api/dsh-github/* 读写宿主凭据服务，不经过会话日志。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-github',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BUNDLE_KEY = '@local/dsh-github'
    const PANEL_ID = 'github'

    /* ------------------------------ 文案 ------------------------------ */

    const ZH = {
      title: 'GitHub 连接',
      subtitle: '绑定账号后，Agent 可以把本地代码上传到仓库；每次上传都会在对话里请求你授权。',
      connected: '已连接',
      disconnected: '未连接',
      checking: '检测中…',
      tokenLabel: 'Personal Access Token',
      tokenPlaceholder: 'ghp_… 或 github_pat_…',
      save: '保存并验证',
      saving: '验证中…',
      retest: '重新验证',
      testing: '验证中…',
      clear: '断开连接',
      clearing: '清除中…',
      help: '创建令牌 ↗',
      hint: '令牌只保存在本机凭据存储中，不会写入对话记录。classic 令牌需要 repo 权限；fine-grained 令牌需要目标仓库的 Contents 读写权限（创建仓库还需要 Administration）。',
      empty: '请先粘贴令牌。',
      failed: '操作失败',
      saved: '令牌已保存并验证通过。',
      invalid: '令牌校验失败',
      cleared: '已清除本机保存的令牌。',
      confirmClear: '断开后 Agent 将无法上传代码。确定断开吗？',
      envNote: '当前令牌来自环境变量，覆盖它请在这里保存新令牌。',
      account: '账号',
      avatarAlt: 'GitHub 头像',

      openInBrowser: '在浏览器打开 GitHub',
      refresh: '刷新',
      loadingRepos: '加载中…',
      myRepos: '我的仓库',
      newRepo: '新建仓库',
      issues: 'Issues',
      tokens: '令牌设置',
      recentRepos: '最近更新的仓库',
      noRepos: '这个账号下还没有仓库。',
      bindFirst: '还没有绑定 GitHub 令牌。绑定后，这里会列出你的仓库，并支持一键跳到 GitHub。',
      privateTag: '私有',
      archivedTag: '已归档',
      lastUpdated: '更新于',
      back: '返回',
      openRepo: '打开仓库',
      openRepoPlaceholder: 'owner/name，例如 octocat/hello-world',
      open: '打开',
      readme: 'README',
      loading: '加载中…',
      emptyDir: '这个目录是空的。',
      fileTooLarge: '文件太大，没有加载全文。',
      binaryFile: '二进制文件，无法预览。',
      contentTruncated: '内容已截断（仅显示前 256 KB）。',
      starsLabel: '星标',
      forksLabel: '分支',
      invalidRepo: '请输入 owner/name 格式的仓库，例如 octocat/hello-world。',
      openInGitHub: '在浏览器打开',
    }

    const EN = {
      title: 'GitHub connection',
      subtitle: 'Once connected, the agent can upload local code to your repositories. Every upload asks for your approval in the chat first.',
      connected: 'Connected',
      disconnected: 'Not connected',
      checking: 'Checking…',
      tokenLabel: 'Personal Access Token',
      tokenPlaceholder: 'ghp_… or github_pat_…',
      save: 'Save and verify',
      saving: 'Verifying…',
      retest: 'Re-verify',
      testing: 'Verifying…',
      clear: 'Disconnect',
      clearing: 'Clearing…',
      help: 'Create a token ↗',
      hint: 'The token is stored in the local credential store and never written to the conversation log. Classic tokens need the repo scope; fine-grained tokens need Contents read/write (plus Administration to create repositories).',
      empty: 'Paste a token first.',
      failed: 'Action failed',
      saved: 'Token saved and verified.',
      invalid: 'Token verification failed',
      cleared: 'The locally stored token was removed.',
      confirmClear: 'Without a token the agent cannot upload code. Disconnect anyway?',
      envNote: 'The current token comes from the environment. Save a new token here to override it.',
      account: 'Account',
      avatarAlt: 'GitHub avatar',

      openInBrowser: 'Open GitHub in browser',
      refresh: 'Refresh',
      loadingRepos: 'Loading…',
      myRepos: 'My repositories',
      newRepo: 'New repository',
      issues: 'Issues',
      tokens: 'Token settings',
      recentRepos: 'Recently updated repositories',
      noRepos: 'This account has no repositories yet.',
      bindFirst: 'No GitHub token is bound yet. Once bound, your repositories appear here and you can jump to GitHub in one click.',
      privateTag: 'Private',
      archivedTag: 'Archived',
      lastUpdated: 'Updated',
      back: 'Back',
      openRepo: 'Open repository',
      openRepoPlaceholder: 'owner/name, e.g. octocat/hello-world',
      open: 'Open',
      readme: 'README',
      loading: 'Loading…',
      emptyDir: 'This directory is empty.',
      fileTooLarge: 'The file is too large to load in full.',
      binaryFile: 'Binary file — no preview available.',
      contentTruncated: 'Content truncated (first 256 KB only).',
      starsLabel: 'stars',
      forksLabel: 'forks',
      invalidRepo: 'Enter a repository as owner/name, e.g. octocat/hello-world.',
      openInGitHub: 'Open in browser',
    }

    const t = (active) => (String(active).toLowerCase().startsWith('zh') ? ZH : EN)

    /* ------------------------------ 样式 ------------------------------ */

    const CSS = `
.ghc_card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary)}
.ghc_head{display:flex;align-items:center;gap:8px}
.ghc_title{font-size:14px;font-weight:600;line-height:22px}
.ghc_badge{margin-left:auto;flex:none;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:16px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.ghc_badge[data-state="on"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.ghc_badge[data-state="error"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ghc_sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0}
.ghc_account{display:flex;align-items:center;gap:8px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.ghc_avatar{width:22px;height:22px;border-radius:50%;background:var(--dsw-alias-bg-base);flex:none}
.ghc_login{font-family:var(--dsw-font-family-code);font-size:12.5px}
.ghc_source{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11.5px}
.ghc_form{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}
.ghc_label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ghc_input{box-sizing:border-box;height:32px;min-width:180px;flex:1 1 220px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family-code);font-size:12.5px}
.ghc_input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;border-color:var(--dsw-alias-brand-primary)}
.ghc_btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-family:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;text-decoration:none}
.ghc_btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.ghc_btn:disabled{opacity:.45;cursor:not-allowed}
.ghc_btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.ghc_btnGhost{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.ghc_btnGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1))}
.ghc_btnGhost:disabled{opacity:.45;cursor:not-allowed}
.ghc_btnDanger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}
.ghc_btnDanger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.ghc_link{color:var(--dsw-alias-brand-primary);font-size:12px;text-decoration:none}
.ghc_link:hover{text-decoration:underline}
.ghc_hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:0}
.ghc_banner{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;font-size:12px;line-height:17px;overflow-wrap:anywhere}
.ghc_banner[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.ghc_banner[data-kind="error"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ghc_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ghc_spacer{flex:1}

.ghp_page{display:flex;flex-direction:column;gap:16px;box-sizing:border-box;min-height:100%;padding:26px 28px 40px;overflow-y:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.ghp_header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ghp_titleRow{display:flex;align-items:center;gap:10px;min-width:0}
.ghp_title{font-size:19px;font-weight:600;line-height:26px;letter-spacing:-.01em}
.ghp_login{font-family:var(--dsw-font-family-code);font-size:12.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 10px;white-space:nowrap}
.ghp_headerActions{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}
.ghp_stack{display:flex;flex-direction:column;gap:12px;max-width:900px}
.ghp_shortcuts{display:flex;gap:8px;flex-wrap:wrap}
.ghp_shortcut{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;text-decoration:none}
.ghp_shortcut:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);text-decoration:none}
.ghp_sectionTitle{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:600;letter-spacing:.05em;color:var(--dsw-alias-label-secondary);margin:6px 0 0}
.ghp_list{display:flex;flex-direction:column;gap:6px;list-style:none;margin:0;padding:0}
.ghp_repo{display:flex;align-items:center;gap:10px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:inherit;text-decoration:none;min-width:0}
.ghp_repo:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);text-decoration:none}
.ghp_repoMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.ghp_repoName{font-family:var(--dsw-font-family-code);font-size:12.5px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghp_repoDesc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghp_repoMeta{flex:none;display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ghp_tag{font-size:11px;line-height:16px;padding:0 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ghp_tag[data-kind="private"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.ghp_empty{font-size:12.5px;color:var(--dsw-alias-label-secondary);padding:18px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:10px;text-align:center}
.ghp_openForm{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ghp_input{box-sizing:border-box;height:30px;flex:1 1 240px;min-width:160px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family-code);font-size:12.5px}
.ghp_input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.ghp_repoHeader{display:flex;flex-direction:column;gap:6px}
.ghp_repoTitleRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ghp_repoTitle{font-family:var(--dsw-font-family-code);font-size:16px;font-weight:600}
.ghp_repoSub{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ghp_crumbs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-family:var(--dsw-font-family-code);font-size:12px}
.ghp_crumb{background:none;border:none;padding:0 2px;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:inherit;cursor:pointer}
.ghp_crumb:hover{text-decoration:underline}
.ghp_crumbSep{color:var(--dsw-alias-label-secondary)}
.ghp_entry{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ghp_entry:hover{background:var(--dsw-alias-bg-layer-2)}
.ghp_entryName{flex:1;min-width:0;font-family:var(--dsw-font-family-code);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghp_entrySize{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ghp_entryIcon{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-secondary);display:inline-flex}
.ghp_dir{color:var(--dsw-alias-brand-primary)}
.ghp_fileMeta{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ghp_code{box-sizing:border-box;margin:0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family-code);font-size:12px;line-height:1.55;overflow:auto;max-height:60vh;white-space:pre;tab-size:2}
.ghp_readme{border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:14px 16px;font-size:13px;line-height:1.65;overflow-wrap:anywhere}
.ghp_readme h1,.ghp_readme h2,.ghp_readme h3,.ghp_readme h4,.ghp_readme h5,.ghp_readme h6{margin:14px 0 8px;font-weight:600;line-height:1.3}
.ghp_readme h1:first-child,.ghp_readme h2:first-child,.ghp_readme h3:first-child{margin-top:0}
.ghp_readme h1{font-size:19px}
.ghp_readme h2{font-size:16px;padding-bottom:4px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ghp_readme h3{font-size:14px}
.ghp_readme p{margin:8px 0}
.ghp_readme ul{margin:8px 0;padding-left:22px}
.ghp_readme li{margin:3px 0}
.ghp_readme pre{margin:10px 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l1);overflow:auto;font-family:var(--dsw-font-family-code);font-size:12px;line-height:1.5}
.ghp_readme code{font-family:var(--dsw-font-family-code);font-size:.92em;padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-base)}
.ghp_readme pre code{padding:0;background:none}
.ghp_readme a{color:var(--dsw-alias-brand-primary);text-decoration:none}
.ghp_readme a:hover{text-decoration:underline}
.ghp_readme strong{font-weight:600}
button.ghp_repo{font:inherit;text-align:left;cursor:pointer;width:100%}
`

    let styleEl
    let pluginCtx = null

    function ensureStyle() {
      if (styleEl) return
      styleEl = document.createElement('style')
      styleEl.setAttribute('data-dsh-github-connector', '')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
    }

    /* ------------------------------ 数据层 ------------------------------ */

    async function api(path, options) {
      const res = await fetch(path, options)
      let body = {}
      try {
        body = await res.json()
      } catch {
        /* 非 JSON 响应 */
      }
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      return body
    }

    const apiState = () => api('/api/dsh-github/state')
    const apiRepos = () => api('/api/dsh-github/repos')
    const apiSaveToken = (token) =>
      api('/api/dsh-github/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    const apiClear = () => api('/api/dsh-github/token/clear', { method: 'POST' })
    const apiTest = () => api('/api/dsh-github/test', { method: 'POST' })
    const apiRepo = (repo) => api(`/api/dsh-github/repo?repo=${encodeURIComponent(repo)}`)
    const apiTree = (repo, path) =>
      api(`/api/dsh-github/tree?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`)
    const apiFile = (repo, path) =>
      api(`/api/dsh-github/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`)

    /* ------------------------------ 组件 ------------------------------ */

    function useActiveLocale() {
      const ctx = pluginCtx
      const [active, setActive] = React.useState(() => {
        try {
          return ctx.locale.getSnapshot().active
        } catch {
          return 'zh'
        }
      })
      React.useEffect(() => {
        let unsubscribe
        try {
          unsubscribe = ctx.locale.subscribe(() => setActive(ctx.locale.getSnapshot().active))
        } catch {
          unsubscribe = undefined
        }
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [ctx])
      return active
    }

    function GithubConnectionCard(props) {
      const options = props ?? {}
      const strings = t(useActiveLocale())
      const [status, setStatus] = React.useState({ loading: true })
      const [token, setToken] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      const applyState = React.useCallback((next) => {
        setStatus({
          loading: false,
          configured: next.configured === true,
          connected: next.connected === true,
          login: next.login,
          name: next.name,
          avatarUrl: next.avatarUrl,
          profileUrl: next.profileUrl,
          error: next.error,
          source: next.source,
          tokenUrl: next.tokenUrl,
        })
      }, [])

      React.useEffect(() => {
        let alive = true
        apiState()
          .then((next) => {
            if (alive) applyState(next)
          })
          .catch((error) => {
            if (alive) {
              setStatus({ loading: false, configured: false, connected: false })
              setNotice({ kind: 'error', text: `${strings.failed}：${error.message}` })
            }
          })
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const submit = async (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        const value = token.trim()
        if (!value) {
          setNotice({ kind: 'error', text: strings.empty })
          return
        }
        setBusy('save')
        setNotice(null)
        try {
          const next = await apiSaveToken(value)
          applyState(next)
          setToken('')
          setNotice({ kind: 'ok', text: `${strings.saved}（@${next.login}）` })
          if (typeof options.onChanged === 'function') options.onChanged()
        } catch (error) {
          setNotice({ kind: 'error', text: `${strings.invalid}：${error.message}` })
        } finally {
          setBusy('')
        }
      }

      const retest = async () => {
        setBusy('test')
        setNotice(null)
        try {
          const next = await apiTest()
          applyState(next)
          if (next.connected) setNotice({ kind: 'ok', text: `@${next.login}` })
          else setNotice({ kind: 'error', text: next.error || strings.disconnected })
          if (typeof options.onChanged === 'function') options.onChanged()
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy('')
        }
      }

      const clear = async () => {
        if (!window.confirm(strings.confirmClear)) return
        setBusy('clear')
        setNotice(null)
        try {
          const next = await apiClear()
          applyState(next)
          setNotice({ kind: 'ok', text: strings.cleared })
          if (typeof options.onChanged === 'function') options.onChanged()
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy('')
        }
      }

      const loading = status.loading === true
      const connected = status.connected === true
      const badgeState = loading ? undefined : connected ? 'on' : 'error'
      const badgeText = loading ? strings.checking : connected ? strings.connected : strings.disconnected

      return h(
        'div',
        { className: 'ghc_card' },
        h(
          'div',
          { className: 'ghc_head' },
          h('span', { className: 'ghc_title' }, strings.title),
          h('span', { className: 'ghc_badge', 'data-state': badgeState, role: 'status' }, badgeText),
        ),
        h('p', { className: 'ghc_sub' }, strings.subtitle),

        connected && status.login
          ? h(
              'div',
              { className: 'ghc_account' },
              status.avatarUrl
                ? h('img', {
                    className: 'ghc_avatar',
                    src: status.avatarUrl,
                    alt: strings.avatarAlt,
                    loading: 'lazy',
                    onError: (event) => {
                      event.currentTarget.style.display = 'none'
                    },
                  })
                : null,
              h('span', { className: 'ghc_login' }, `@${status.login}`),
              status.source === 'environment' ? h('span', { className: 'ghc_source' }, strings.envNote) : null,
              h('span', { className: 'ghc_spacer' }),
              status.profileUrl
                ? h('a', { className: 'ghc_link', href: status.profileUrl, target: '_blank', rel: 'noreferrer' }, 'GitHub ↗')
                : null,
            )
          : null,

        !connected && status.configured && status.error
          ? h('div', { className: 'ghc_banner', 'data-kind': 'error' }, status.error)
          : null,

        h(
          'form',
          { className: 'ghc_form', onSubmit: submit },
          h('label', { className: 'ghc_label', htmlFor: 'ghc-token' }, strings.tokenLabel),
          h('input', {
            id: 'ghc-token',
            className: 'ghc_input',
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: connected ? '••••••••（重新绑定）' : strings.tokenPlaceholder,
            value: token,
            disabled: busy !== '',
            onChange: (event) => setToken(event.target.value),
          }),
          h(
            'button',
            { className: 'ghc_btn', type: 'submit', disabled: busy !== '' },
            busy === 'save' ? strings.saving : strings.save,
          ),
          connected
            ? h(
                'button',
                { className: 'ghc_btnGhost', type: 'button', disabled: busy !== '', onClick: retest },
                busy === 'test' ? strings.testing : strings.retest,
              )
            : null,
          connected
            ? h(
                'button',
                { className: 'ghc_btnGhost ghc_btnDanger', type: 'button', disabled: busy !== '', onClick: clear },
                busy === 'clear' ? strings.clearing : strings.clear,
              )
            : null,
        ),

        notice ? h('div', { className: 'ghc_banner', 'data-kind': notice.kind }, notice.text) : null,

        h(
          'p',
          { className: 'ghc_hint' },
          strings.hint,
          ' ',
          h(
            'a',
            {
              className: 'ghc_link',
              href: status.tokenUrl || 'https://github.com/settings/tokens',
              target: '_blank',
              rel: 'noreferrer',
            },
            strings.help,
          ),
        ),
      )
    }

    function repoTag(label, kind) {
      return h('span', { className: 'ghp_tag', 'data-kind': kind }, label)
    }

    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
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

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
    }

    function inlineMarkdown(value) {
      let html = value
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      return html
    }

    // 先整体转义，再套用少量标记——生成的 HTML 里只有我们自己的标签。
    function renderMarkdown(source) {
      const lines = escapeHtml(source).split(/\r?\n/)
      const out = []
      let inCode = false
      let code = []
      let list = []
      const flushList = () => {
        if (list.length > 0) {
          out.push(`<ul>${list.join('')}</ul>`)
          list = []
        }
      }
      for (const line of lines) {
        if (/^\s*```/.test(line)) {
          if (inCode) {
            out.push(`<pre><code>${code.join('\n')}</code></pre>`)
            code = []
            inCode = false
          } else {
            flushList()
            inCode = true
          }
          continue
        }
        if (inCode) {
          code.push(line)
          continue
        }
        if (/^\s*$/.test(line)) {
          flushList()
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          flushList()
          const level = heading[1].length
          out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
          continue
        }
        const item = /^\s*[-*+]\s+(.*)$/.exec(line)
        if (item) {
          list.push(`<li>${inlineMarkdown(item[1])}</li>`)
          continue
        }
        flushList()
        out.push(`<p>${inlineMarkdown(line)}</p>`)
      }
      if (inCode && code.length > 0) out.push(`<pre><code>${code.join('\n')}</code></pre>`)
      flushList()
      return out.join('')
    }

    function RepoView(props) {
      const { repo, onBack, strings } = props
      const [meta, setMeta] = React.useState(null)
      const [metaError, setMetaError] = React.useState(null)
      const [path, setPath] = React.useState('')
      const [entries, setEntries] = React.useState(null)
      const [listError, setListError] = React.useState(null)
      const [listLoading, setListLoading] = React.useState(false)
      const [file, setFile] = React.useState(null)
      const [fileLoading, setFileLoading] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        setMeta(null)
        setMetaError(null)
        apiRepo(repo)
          .then((next) => {
            if (alive) setMeta(next)
          })
          .catch((failure) => {
            if (alive) setMetaError(failure.message)
          })
        return () => {
          alive = false
        }
      }, [repo])

      const openDirectory = React.useCallback(
        async (nextPath) => {
          setListLoading(true)
          setListError(null)
          setFile(null)
          try {
            const next = await apiTree(repo, nextPath)
            setEntries(Array.isArray(next.entries) ? next.entries : [])
            setPath(nextPath)
          } catch (failure) {
            setEntries([])
            setListError(failure.message)
          } finally {
            setListLoading(false)
          }
        },
        [repo],
      )

      React.useEffect(() => {
        void openDirectory('')
      }, [openDirectory])

      const openFile = async (entry) => {
        setFileLoading(true)
        setFile({ path: entry.path })
        try {
          const next = await apiFile(repo, entry.path)
          setFile(next)
        } catch (failure) {
          setFile({ path: entry.path, error: failure.message })
        } finally {
          setFileLoading(false)
        }
      }

      const segments = path ? path.split('/') : []
      const breadcrumb = h(
        'div',
        { className: 'ghp_crumbs' },
        h(
          'button',
          { className: 'ghp_crumb', type: 'button', onClick: () => openDirectory('') },
          repo.split('/')[1] || repo,
        ),
        segments.map((segment, index) =>
          h(
            React.Fragment,
            { key: `${segment}-${index}` },
            h('span', { className: 'ghp_crumbSep' }, '/'),
            h(
              'button',
              {
                className: 'ghp_crumb',
                type: 'button',
                onClick: () => openDirectory(segments.slice(0, index + 1).join('/')),
              },
              segment,
            ),
          ),
        ),
      )

      const repoHeader = h(
        'div',
        { className: 'ghp_repoHeader' },
        h(
          'div',
          { className: 'ghp_repoTitleRow' },
          h('button', { className: 'ghc_btnGhost', type: 'button', onClick: onBack }, `← ${strings.back}`),
          h('span', { className: 'ghp_repoTitle' }, repo),
          meta && meta.repo && meta.repo.htmlUrl
            ? h('a', { className: 'ghc_link', href: meta.repo.htmlUrl, target: '_blank', rel: 'noreferrer' }, strings.openInGitHub)
            : null,
        ),
        meta && meta.repo
          ? h(
              'div',
              { className: 'ghp_repoSub' },
              meta.repo.description ? h('span', null, meta.repo.description) : null,
              meta.repo.language ? h('span', null, meta.repo.language) : null,
              h('span', null, `★ ${meta.repo.stars}`),
              h('span', null, `⑂ ${meta.repo.forks}`),
              h('span', null, meta.repo.defaultBranch),
              meta.repo.private ? repoTag(strings.privateTag, 'private') : null,
            )
          : null,
      )

      const readmeBlock =
        meta && meta.readme && meta.readme.content && path === ''
          ? h(
              'div',
              { className: 'ghp_stack' },
              h('div', { className: 'ghp_sectionTitle' }, strings.readme),
              h('div', {
                className: 'ghp_readme',
                dangerouslySetInnerHTML: { __html: renderMarkdown(meta.readme.content) },
              }),
            )
          : null

      const listBlock = h(
        'div',
        { className: 'ghp_stack' },
        breadcrumb,
        listLoading ? h('div', { className: 'ghp_empty' }, strings.loading) : null,
        listError ? h('div', { className: 'ghp_empty' }, listError) : null,
        !listLoading && !listError && entries && entries.length === 0
          ? h('div', { className: 'ghp_empty' }, strings.emptyDir)
          : null,
        !listLoading && !listError && entries && entries.length > 0
          ? h(
              'ul',
              { className: 'ghp_list' },
              entries.map((entry) =>
                h(
                  'li',
                  { key: entry.path },
                  h(
                    'button',
                    {
                      className: 'ghp_entry',
                      type: 'button',
                      onClick: () => (entry.type === 'dir' ? openDirectory(entry.path) : openFile(entry)),
                    },
                    h(
                      'span',
                      { className: `ghp_entryIcon${entry.type === 'dir' ? ' ghp_dir' : ''}` },
                      entry.type === 'dir' ? '▸' : '·',
                    ),
                    h(
                      'span',
                      { className: `ghp_entryName${entry.type === 'dir' ? ' ghp_dir' : ''}` },
                      entry.name,
                    ),
                    entry.type === 'file' && entry.size
                      ? h('span', { className: 'ghp_entrySize' }, formatSize(entry.size))
                      : null,
                  ),
                ),
              ),
            )
          : null,
      )

      const fileBlock = file
        ? h(
            'div',
            { className: 'ghp_stack' },
            h(
              'div',
              { className: 'ghp_fileMeta' },
              h('span', null, file.path),
              typeof file.size === 'number' && file.size > 0 ? h('span', null, formatSize(file.size)) : null,
              file.truncated ? h('span', null, strings.contentTruncated) : null,
            ),
            fileLoading
              ? h('div', { className: 'ghp_empty' }, strings.loading)
              : file.error
                ? h('div', { className: 'ghp_empty' }, file.error)
                : file.tooLarge
                  ? h('div', { className: 'ghp_empty' }, strings.fileTooLarge)
                  : file.binary
                    ? h('div', { className: 'ghp_empty' }, strings.binaryFile)
                    : h('pre', { className: 'ghp_code' }, file.content),
          )
        : null

      return h(
        'div',
        { className: 'ghp_page' },
        repoHeader,
        metaError ? h('div', { className: 'ghp_empty' }, metaError) : null,
        readmeBlock,
        listBlock,
        fileBlock,
      )
    }

    function GithubPanel() {
      const strings = t(useActiveLocale())
      const [data, setData] = React.useState({ loading: true })
      const [error, setError] = React.useState(null)
      const [activeRepo, setActiveRepo] = React.useState('')
      const [repoInput, setRepoInput] = React.useState('')

      const load = React.useCallback(async () => {
        setData((prev) => ({ ...prev, loading: true }))
        try {
          const next = await apiRepos()
          setData({ loading: false, ...next })
          setError(null)
        } catch (failure) {
          setData((prev) => ({ ...prev, loading: false }))
          setError(failure.message)
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      if (activeRepo) {
        return h(RepoView, {
          repo: activeRepo,
          strings,
          onBack: () => {
            setActiveRepo('')
            void load()
          },
        })
      }

      const connected = data.connected === true
      const repos = Array.isArray(data.repos) ? data.repos : []
      const login = typeof data.login === 'string' ? data.login : ''

      const openFromInput = () => {
        const value = repoInput
          .trim()
          .replace(/^https?:\/\/github\.com\//i, '')
          .replace(/\.git$/i, '')
        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) {
          setError(strings.invalidRepo)
          return
        }
        setError(null)
        setActiveRepo(value)
      }

      return h(
        'div',
        { className: 'ghp_page' },
        h(
          'div',
          { className: 'ghp_header' },
          h(
            'div',
            { className: 'ghp_titleRow' },
            h('span', { className: 'ghp_title' }, 'GitHub'),
            connected && login ? h('span', { className: 'ghp_login' }, `@${login}`) : null,
            !connected && !data.loading ? h('span', { className: 'ghc_badge', 'data-state': 'error' }, strings.disconnected) : null,
          ),
          h(
            'div',
            { className: 'ghp_headerActions' },
            h(
              'button',
              { className: 'ghc_btnGhost', type: 'button', onClick: load, disabled: data.loading === true },
              data.loading ? strings.loadingRepos : strings.refresh,
            ),
          ),
        ),

        !connected
          ? h(
              'div',
              { className: 'ghp_stack' },
              h('div', { className: 'ghp_empty' }, error || strings.bindFirst),
              h(GithubConnectionCard, { onChanged: load }),
            )
          : h(
              'div',
              { className: 'ghp_stack' },
              h(
                'form',
                {
                  className: 'ghp_openForm',
                  onSubmit: (event) => {
                    if (event && typeof event.preventDefault === 'function') event.preventDefault()
                    openFromInput()
                  },
                },
                h('input', {
                  className: 'ghp_input',
                  value: repoInput,
                  spellCheck: false,
                  placeholder: strings.openRepoPlaceholder,
                  onChange: (event) => setRepoInput(event.target.value),
                }),
                h('button', { className: 'ghc_btn', type: 'submit' }, strings.openRepo),
              ),
              error ? h('div', { className: 'ghc_banner', 'data-kind': 'error' }, error) : null,
              h('div', { className: 'ghp_sectionTitle' }, strings.recentRepos),
              repos.length === 0
                ? h('div', { className: 'ghp_empty' }, strings.noRepos)
                : h(
                    'ul',
                    { className: 'ghp_list' },
                    repos.map((repo) =>
                      h(
                        'li',
                        { key: repo.fullName },
                        h(
                          'button',
                          {
                            className: 'ghp_repo',
                            type: 'button',
                            onClick: () => setActiveRepo(repo.fullName),
                          },
                          h(
                            'span',
                            { className: 'ghp_repoMain' },
                            h('span', { className: 'ghp_repoName' }, repo.fullName),
                            repo.description ? h('span', { className: 'ghp_repoDesc' }, repo.description) : null,
                          ),
                          h(
                            'span',
                            { className: 'ghp_repoMeta' },
                            repo.private ? repoTag(strings.privateTag, 'private') : null,
                            repo.language ? h('span', null, repo.language) : null,
                            repo.updatedAt ? h('span', null, repo.updatedAt.slice(0, 10)) : null,
                          ),
                        ),
                      ),
                    ),
                  ),
            ),
      )
    }

    function GithubPanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 20
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 6.5, cy: 5.5, r: 2.2 }),
        h('circle', { cx: 6.5, cy: 18.5, r: 2.2 }),
        h('circle', { cx: 17.5, cy: 8.5, r: 2.2 }),
        h('path', { d: 'M6.5 7.7v8.6' }),
        h('path', { d: 'M6.5 12h5.5a3.5 3.5 0 0 0 3.5-3.5' }),
      )
    }

    /* ------------------------------ 插件入口 ------------------------------ */

    const exportsObject = {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx

        ctx.effect(() => {
          ensureStyle()
          return () => {
            if (styleEl) {
              styleEl.remove()
              styleEl = undefined
            }
          }
        }, 'github-connector: styles')

        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE_KEY }, GithubConnectionCard),
        )

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => 'GitHub' },
            GithubPanelIcon,
          ),
        )

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, GithubPanel))
      },
    }

    return exportsObject
  },
})
