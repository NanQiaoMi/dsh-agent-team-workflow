/**
 * @local/dsh-git-graph - Client UI Plugin
 *
 * Registers:
 * 1. `conversation.input.dock` -> Interactive Git Status Icon & Quick Popover
 * 2. `conversation.view` -> Full-fidelity Interactive Git Tree DAG Graph View
 *
 * Zero external require (strictly only `require('react')`).
 * Uses DSH host theme tokens (`--dsw-alias-*`) and self-contained styles.
 * 100% fault-tolerant with error boundaries and scrollport normalization.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-git-graph',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useCallback = React.useCallback
    const useRef = React.useRef

    const NS = 'dsh-git-graph'
    const SNAPSHOT_PATH = '/api/git-graph.snapshot'
    const DEFAULT_POLL_MS = 2000

    // -------------------------------------------------------------------------
    // Localization Dictionaries
    // -------------------------------------------------------------------------
    const zh = {
      'view.label': 'Git 树图',
      'dock.title': 'Git 状态',
      'dock.clean': '工作区干净',
      'dock.dirty': '{n} 项改动',
      'dock.ahead': '超前 {n}',
      'dock.behind': '落后 {n}',
      'dock.openGraph': '打开完整树图',
      'dock.copyBranch': '复制分支名',
      'dock.copySha': '复制 SHA',
      'dock.refresh': '刷新',
      'dock.loading': '读取中...',
      'dock.offline': 'Git 离线',
      'dock.notGit': '未初始化',
      'graph.title': 'Git 提交关系与分支树',
      'graph.searchPlaceholder': '搜索提交信息、SHA、作者或分支...',
      'graph.uncommitted': '工作区未提交改动',
      'graph.staged': '暂存 {n}',
      'graph.unstaged': '未暂存 {n}',
      'graph.untracked': '未跟踪 {n}',
      'graph.headBadge': 'HEAD',
      'graph.author': '作者: {name}',
      'graph.date': '时间: {time}',
      'graph.parents': '父提交:',
      'graph.noCommits': '没有找到匹配的提交',
      'graph.notGitRepo': '当前目录不是一个有效的 Git 仓库',
      'graph.notGitRepoDesc': '在此工作区运行 git init 即可启用完整的 Git 树图与分支追踪。',
      'graph.loading': '正在读取 Git 树图...',
      'graph.copied': '已复制到剪贴板！',
      'graph.inspectCommit': '提交详情',
      'graph.inspectWorking': '工作区变更详情',
      'graph.filesChanged': '变更文件 ({n})',
      'graph.actions': '辅助操作',
      'graph.copyDiffCmd': '复制 Diff 命令',
      'graph.autoRefresh': '自动轮询',
      'graph.retry': '重试连接',
      'graph.connErrorTitle': 'Git 树图服务连接中或暂未就绪',
      'graph.connErrorHint': '正在尝试与 Host 数据路由建立通信。若刚安装插件，可点击重试或重启 DSH Desktop。',
    }

    const en = {
      'view.label': 'Git Graph',
      'dock.title': 'Git Status',
      'dock.clean': 'Working tree clean',
      'dock.dirty': '{n} changes',
      'dock.ahead': 'ahead {n}',
      'dock.behind': 'behind {n}',
      'dock.openGraph': 'Open Git Graph',
      'dock.copyBranch': 'Copy Branch Name',
      'dock.copySha': 'Copy SHA',
      'dock.refresh': 'Refresh',
      'dock.loading': 'Loading...',
      'dock.offline': 'Git Offline',
      'dock.notGit': 'Not a repo',
      'graph.title': 'Git Commit DAG & Branch Tree',
      'graph.searchPlaceholder': 'Search message, SHA, author, branch...',
      'graph.uncommitted': 'Uncommitted Working Changes',
      'graph.staged': 'staged {n}',
      'graph.unstaged': 'unstaged {n}',
      'graph.untracked': 'untracked {n}',
      'graph.headBadge': 'HEAD',
      'graph.author': 'Author: {name}',
      'graph.date': 'Date: {time}',
      'graph.parents': 'Parents:',
      'graph.noCommits': 'No matching commits found',
      'graph.notGitRepo': 'Current directory is not a Git repository',
      'graph.notGitRepoDesc': 'Run git init in this workspace to enable live Git tree tracking.',
      'graph.loading': 'Loading Git graph...',
      'graph.copied': 'Copied to clipboard!',
      'graph.inspectCommit': 'Commit Details',
      'graph.inspectWorking': 'Working Changes Details',
      'graph.filesChanged': 'Changed Files ({n})',
      'graph.actions': 'Developer Actions',
      'graph.copyDiffCmd': 'Copy Diff Command',
      'graph.autoRefresh': 'Auto Refresh',
      'graph.retry': 'Retry Connection',
      'graph.connErrorTitle': 'Git Graph service connecting or not yet ready',
      'graph.connErrorHint': 'Connecting to Host snapshot route. If newly installed, click Retry or restart DSH.',
    }

    // -------------------------------------------------------------------------
    // Custom Hooks
    // -------------------------------------------------------------------------

    /** Fetch live Git snapshot with automatic document visibility pause */
    function useGitSnapshot(sessionId, pollMs = DEFAULT_POLL_MS) {
      const [snapshot, setSnapshot] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [lastUpdated, setLastUpdated] = useState(null)

      const refresh = useCallback(async () => {
        try {
          const url = `${SNAPSHOT_PATH}?session=${encodeURIComponent(sessionId || '')}&limit=60`
          const res = await fetch(url, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`)
          }
          const data = await res.json()
          if (data && typeof data === 'object') {
            setSnapshot(data)
            setError(null)
            setLastUpdated(new Date())
          }
        } catch (err) {
          setError(err?.message || 'Failed to fetch Git snapshot')
        } finally {
          setLoading(false)
        }
      }, [sessionId])

      useEffect(() => {
        refresh()
        if (pollMs <= 0) return

        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          refresh()
        }, pollMs)

        return () => clearInterval(timer)
      }, [refresh, pollMs])

      return { snapshot, loading, error, refresh, lastUpdated }
    }

    // -------------------------------------------------------------------------
    // SVG Icons
    // -------------------------------------------------------------------------

    function GitBranchIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: props.size || 14,
          height: props.size || 14,
          fill: 'currentColor',
          style: props.style,
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z',
        })
      )
    }

    function GitCommitIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: props.size || 14,
          height: props.size || 14,
          fill: 'currentColor',
          style: props.style,
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M10.5 8a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.45 0a3.999 3.999 0 00-7.9 0H1.75a.75.75 0 000 1.5h2.3a3.999 3.999 0 007.9 0h2.3a.75.75 0 000-1.5h-2.3z',
        })
      )
    }

    function RefreshIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: props.size || 13,
          height: props.size || 13,
          fill: 'currentColor',
          style: props.style,
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M1.705 8.005a.75.75 0 01.834.656 5.5 5.5 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7 7 0 011.05 8.84a.75.75 0 01.655-.835zm11.745-.01a.75.75 0 01-.834-.656 5.5 5.5 0 00-9.592-2.97l1.204 1.204a.25.25 0 01-.177.427H.405a.25.25 0 01-.25-.25V2.104a.25.25 0 01.427-.177l1.38 1.38A7 7 0 0114.105 7.16a.75.75 0 01-.655.835z',
        })
      )
    }

    function CopyIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: props.size || 13,
          height: props.size || 13,
          fill: 'currentColor',
          style: props.style,
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z',
        }),
        h('path', {
          d: 'M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z',
        })
      )
    }

    // -------------------------------------------------------------------------
    // Translation Helper
    // -------------------------------------------------------------------------
    function makeTr(callerT, fallbackLocale) {
      return (key, params) => {
        try {
          if (typeof callerT === 'function') {
            const res = callerT(key, params)
            if (res && res !== key) return res
          }
          let text = (fallbackLocale && fallbackLocale[key]) || zh[key] || key
          if (params && typeof params === 'object') {
            for (const [k, v] of Object.entries(params)) {
              text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
            }
          }
          return text
        } catch {
          return key
        }
      }
    }

    // -------------------------------------------------------------------------
    // Component: GitDock (Conversation Composer Dock Item)
    // -------------------------------------------------------------------------

    function GitDock(props) {
      try {
        const source = props && typeof props === 'object' ? props : {}
        const sessionId = source.sessionId || ''
        const tr = makeTr(source.t, zh)

        const { snapshot, loading, error, refresh } = useGitSnapshot(sessionId, 2000)
        const [flyoutOpen, setFlyoutOpen] = useState(false)
        const [copiedText, setCopiedText] = useState('')

        const copyToClipboard = (text, label) => {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
              setCopiedText(label)
              setTimeout(() => setCopiedText(''), 1500)
            })
          }
        }

        // Safe status values
        const status = (snapshot && snapshot.status) || {}
        const isGitRepo = Boolean(snapshot?.isGitRepo)
        const branch = status.headBranch || 'Git'
        const isDirty = Boolean(status.isDirty)
        const changedCount = status.totalChanged || 0
        const ahead = status.ahead || 0
        const behind = status.behind || 0

        // Loading state
        if (loading && !snapshot) {
          return h(
            'div',
            { className: 'dsh-gg-dock-wrap' },
            h(
              'button',
              { type: 'button', className: 'dsh-gg-dock-pill is-loading', title: tr('dock.loading') },
              h(GitBranchIcon, { size: 13 }),
              h('span', { className: 'dsh-gg-dock-branch' }, tr('dock.loading'))
            )
          )
        }

        // Offline / route not ready state
        if (error && !snapshot) {
          return h(
            'div',
            { className: 'dsh-gg-dock-wrap' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-gg-dock-pill is-error',
                onClick: () => refresh(),
                title: `${error} (${tr('dock.refresh')})`,
              },
              h(GitBranchIcon, { size: 13, style: { color: '#f87171' } }),
              h('span', { className: 'dsh-gg-dock-branch' }, tr('dock.offline'))
            )
          )
        }

        // Not a git repository
        if (snapshot && !isGitRepo) {
          return h(
            'div',
            { className: 'dsh-gg-dock-wrap' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-gg-dock-pill is-clean',
                onClick: () => refresh(),
                title: tr('graph.notGitRepo'),
              },
              h(GitBranchIcon, { size: 13, style: { opacity: 0.5 } }),
              h('span', { className: 'dsh-gg-dock-branch' }, tr('dock.notGit'))
            )
          )
        }

        return h(
          'div',
          { className: 'dsh-gg-dock-wrap' },
          h(
            'button',
            {
              type: 'button',
              className: `dsh-gg-dock-pill ${isDirty ? 'is-dirty' : 'is-clean'} ${flyoutOpen ? 'is-active' : ''}`,
              onClick: () => setFlyoutOpen(!flyoutOpen),
              title: isDirty ? `Git: ${branch} (${changedCount} uncommitted)` : `Git: ${branch} (clean)`,
            },
            h(GitBranchIcon, { size: 13 }),
            h('span', { className: 'dsh-gg-dock-branch' }, branch),
            isDirty
              ? h('span', { className: 'dsh-gg-dock-badge dirty' }, `● ${changedCount}`)
              : h('span', { className: 'dsh-gg-dock-badge clean' }, '✓'),
            ahead > 0 && h('span', { className: 'dsh-gg-dock-ahead' }, `↑${ahead}`),
            behind > 0 && h('span', { className: 'dsh-gg-dock-behind' }, `↓${behind}`)
          ),

          // Quick Flyout Popover
          flyoutOpen &&
            h(
              'div',
              { className: 'dsh-gg-flyout' },
              h(
                'div',
                { className: 'dsh-gg-flyout-header' },
                h(
                  'div',
                  { className: 'dsh-gg-flyout-title' },
                  h(GitBranchIcon, { size: 14 }),
                  h('strong', null, branch)
                ),
                h(
                  'div',
                  { className: 'dsh-gg-flyout-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-gg-icon-btn',
                      onClick: () => refresh(),
                      title: tr('dock.refresh'),
                    },
                    h(RefreshIcon, { size: 12 })
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-gg-icon-btn close',
                      onClick: () => setFlyoutOpen(false),
                    },
                    '✕'
                  )
                )
              ),

              h(
                'div',
                { className: 'dsh-gg-flyout-body' },
                h(
                  'div',
                  { className: 'dsh-gg-flyout-status-row' },
                  h('span', { className: 'dsh-gg-status-label' }, 'HEAD Commit:'),
                  h(
                    'span',
                    { className: 'dsh-gg-sha-tag', onClick: () => copyToClipboard(status.headOid || '', 'sha') },
                    status.headOid ? status.headOid.slice(0, 7) : 'none',
                    h(CopyIcon, { size: 11, style: { marginLeft: 4 } })
                  )
                ),

                isDirty &&
                  h(
                    'div',
                    { className: 'dsh-gg-flyout-dirty-box' },
                    h(
                      'div',
                      { className: 'dsh-gg-dirty-counts' },
                      h('span', { className: 'staged' }, `Staged: ${status.staged || 0}`),
                      h('span', { className: 'unstaged' }, `Unstaged: ${status.unstaged || 0}`),
                      h('span', { className: 'untracked' }, `Untracked: ${status.untracked || 0}`)
                    ),
                    h(
                      'ul',
                      { className: 'dsh-gg-file-list' },
                      (status.files || []).slice(0, 6).map((f) =>
                        h(
                          'li',
                          { key: f.path, className: 'dsh-gg-file-item' },
                          h('span', { className: `status-tag ${f.status}` }, (f.xy || '..').trim()),
                          h('span', { className: 'file-path', title: f.path }, f.path)
                        )
                      )
                    )
                  ),

                copiedText && h('div', { className: 'dsh-gg-copied-notice' }, tr('graph.copied'))
              ),

              h(
                'div',
                { className: 'dsh-gg-flyout-footer' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-gg-btn secondary',
                    onClick: () => copyToClipboard(branch, 'branch'),
                  },
                  tr('dock.copyBranch')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-gg-btn secondary',
                    onClick: () => copyToClipboard(`git diff`, 'diff'),
                  },
                  tr('graph.copyDiffCmd')
                )
              )
            )
        )
      } catch (err) {
        console.error('[dsh-git-graph] GitDock crash prevented:', err)
        return null
      }
    }

    // -------------------------------------------------------------------------
    // Component: GitGraphView (Full Conversation View Tab)
    // -------------------------------------------------------------------------

    function GitGraphView(props) {
      const rootRef = useRef(null)

      try {
        const source = props && typeof props === 'object' ? props : {}
        const sessionId = source.sessionId || ''
        const tr = makeTr(source.t, zh)

        const { snapshot, loading, error, refresh } = useGitSnapshot(sessionId, 2500)
        const [searchQuery, setSearchQuery] = useState('')
        const [selectedNode, setSelectedNode] = useState(null)
        const [copyNotice, setCopyNotice] = useState('')

        // View switch reuses conversation scrollport: normalize scrollTop to 0 on mount
        useEffect(() => {
          const node = rootRef.current
          if (!node || !node.parentElement) return
          let cursor = node.parentElement
          while (cursor) {
            const style = typeof getComputedStyle === 'function' ? getComputedStyle(cursor) : null
            const overflowY = style?.overflowY
            if ((overflowY === 'auto' || overflowY === 'scroll') && cursor.scrollHeight > cursor.clientHeight) {
              cursor.scrollTop = 0
              return
            }
            cursor = cursor.parentElement
          }
        }, [])

        const copyText = (text) => {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
              setCopyNotice(tr('graph.copied'))
              setTimeout(() => setCopyNotice(''), 1500)
            })
          }
        }

        // Filter nodes by query
        const filteredNodes = useMemo(() => {
          if (!snapshot?.graph?.nodes) return []
          if (!searchQuery.trim()) return snapshot.graph.nodes
          const q = searchQuery.toLowerCase()
          return snapshot.graph.nodes.filter(
            (n) =>
              (n.subject && n.subject.toLowerCase().includes(q)) ||
              (n.hash && n.hash.toLowerCase().includes(q)) ||
              (n.author && n.author.toLowerCase().includes(q)) ||
              (n.refs && n.refs.some((r) => r.name && r.name.toLowerCase().includes(q)))
          )
        }, [snapshot, searchQuery])

        // 1. Loading State
        if (loading && !snapshot) {
          return h(
            'div',
            { ref: rootRef, className: 'dsh-gg-container' },
            h('div', { className: 'dsh-gg-view-loading' }, tr('graph.loading')),
            h('style', null, CSS_STYLES)
          )
        }

        // 2. Offline / Connection Error State
        if (error && !snapshot) {
          return h(
            'div',
            { ref: rootRef, className: 'dsh-gg-container' },
            h(
              'div',
              { className: 'dsh-gg-empty-state is-error' },
              h(GitBranchIcon, { size: 40, style: { color: '#f87171', opacity: 0.8 } }),
              h('h3', null, tr('graph.connErrorTitle')),
              h('p', { style: { color: 'var(--dsw-alias-label-tertiary, #888)', maxWidth: 440, textAlign: 'center' } }, error),
              h('p', { style: { color: 'var(--dsw-alias-label-secondary, #aaa)', fontSize: 12, maxWidth: 440, textAlign: 'center' } }, tr('graph.connErrorHint')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-gg-btn primary',
                  onClick: () => refresh(),
                  style: { marginTop: 12, padding: '6px 16px' },
                },
                tr('graph.retry')
              )
            ),
            h('style', null, CSS_STYLES)
          )
        }

        // 3. Not a Git repository
        if (snapshot && !snapshot.isGitRepo) {
          return h(
            'div',
            { ref: rootRef, className: 'dsh-gg-container' },
            h(
              'div',
              { className: 'dsh-gg-empty-state' },
              h(GitBranchIcon, { size: 40, style: { opacity: 0.4 } }),
              h('h3', null, tr('graph.notGitRepo')),
              h('p', { style: { color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 13 } }, snapshot.cwd || ''),
              h('p', { style: { color: 'var(--dsw-alias-label-tertiary, #666)', fontSize: 12, marginTop: 4 } }, tr('graph.notGitRepoDesc')),
              h('code', { style: { background: 'rgba(255,255,255,0.06)', padding: '4px 10px', borderRadius: 4, marginTop: 10, fontFamily: 'monospace' } }, 'git init')
            ),
            h('style', null, CSS_STYLES)
          )
        }

        // 4. Fallback for unexpected empty snapshot
        if (!snapshot) {
          return h(
            'div',
            { ref: rootRef, className: 'dsh-gg-container' },
            h('div', { className: 'dsh-gg-view-loading' }, tr('graph.loading')),
            h('style', null, CSS_STYLES)
          )
        }

        // Safe status and graph attributes
        const status = snapshot.status || {}
        const nodes = filteredNodes || []
        const connections = snapshot.graph?.connections || []
        const totalWidth = Math.max(snapshot.graph?.totalWidth || 120, 160)
        const totalHeight = snapshot.graph?.totalHeight || (nodes.length + 1) * 40
        const isDirty = Boolean(status.isDirty)
        const totalChanged = status.totalChanged || 0
        const currentBranch = status.headBranch || 'detached'

        return h(
          'div',
          { ref: rootRef, className: 'dsh-gg-container' },
          // Top Toolbar
          h(
            'div',
            { className: 'dsh-gg-toolbar' },
            h(
              'div',
              { className: 'dsh-gg-toolbar-left' },
              h(GitBranchIcon, { size: 16 }),
              h('span', { className: 'dsh-gg-title' }, tr('graph.title')),
              h('span', { className: 'dsh-gg-branch-chip' }, currentBranch),
              isDirty &&
                h('span', { className: 'dsh-gg-dirty-chip' }, `${totalChanged} uncommitted`)
            ),
            h(
              'div',
              { className: 'dsh-gg-toolbar-right' },
              h('input', {
                type: 'text',
                className: 'dsh-gg-search-input',
                placeholder: tr('graph.searchPlaceholder'),
                value: searchQuery,
                onChange: (e) => setSearchQuery(e.target.value),
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-gg-btn icon',
                  onClick: () => refresh(),
                  title: tr('dock.refresh'),
                },
                h(RefreshIcon, { size: 14 })
              )
            )
          ),

          // Main Two-Column Layout: Left DAG Graph, Right Details Drawer
          h(
            'div',
            { className: 'dsh-gg-main' },
            // Left: Graph Scroll Area
            h(
              'div',
              { className: 'dsh-gg-graph-area' },
              h(
                'div',
                { className: 'dsh-gg-svg-wrap', style: { width: totalWidth, minHeight: totalHeight } },
                h(
                  'svg',
                  {
                    className: 'dsh-gg-svg-layer',
                    width: totalWidth,
                    height: totalHeight,
                  },
                  // Render Connection Curves
                  connections.map((conn, idx) =>
                    h('path', {
                      key: `conn-${idx}`,
                      d: conn.path,
                      stroke: conn.color || 'var(--dsw-alias-border-l1)',
                      strokeWidth: conn.isMerge ? 1.5 : 2,
                      strokeDasharray: conn.isMerge ? '3,2' : 'none',
                      fill: 'none',
                      opacity: 0.85,
                    })
                  ),
                  // Render Node Points
                  nodes.map((node) => {
                    const isSelected = selectedNode?.hash === node.hash
                    return h(
                      'g',
                      {
                        key: `node-${node.hash}`,
                        className: `dsh-gg-node-dot ${isSelected ? 'is-selected' : ''}`,
                        onClick: () => setSelectedNode(node),
                        style: { cursor: 'pointer' },
                      },
                      node.isWorkingTree
                        ? h('polygon', {
                            points: `${node.x},${node.y - 6} ${node.x + 6},${node.y} ${node.x},${node.y + 6} ${node.x - 6},${node.y}`,
                            fill: node.color,
                            stroke: '#fff',
                            strokeWidth: 1.5,
                          })
                        : h('circle', {
                            cx: node.x,
                            cy: node.y,
                            r: node.isHead ? 6 : node.isMerge ? 5.5 : 4.5,
                            fill: node.color,
                            stroke: node.isHead ? '#fff' : isSelected ? '#fff' : 'rgba(0,0,0,0.3)',
                            strokeWidth: node.isHead ? 2 : 1,
                          }),
                      node.isHead &&
                        h('circle', {
                          cx: node.x,
                          cy: node.y,
                          r: 9,
                          fill: 'none',
                          stroke: node.color,
                          strokeWidth: 1.2,
                          opacity: 0.6,
                        })
                    )
                  })
                )
              ),

              // Rows Overlay aligned with Y positions
              h(
                'div',
                { className: 'dsh-gg-rows-layer', style: { minHeight: totalHeight } },
                nodes.map((node) => {
                  const isSelected = selectedNode?.hash === node.hash
                  return h(
                    'div',
                    {
                      key: `row-${node.hash}`,
                      className: `dsh-gg-commit-row ${isSelected ? 'is-selected' : ''} ${node.isWorkingTree ? 'is-working' : ''}`,
                      style: { top: node.y - 18, left: totalWidth },
                      onClick: () => setSelectedNode(node),
                    },
                    // Badges: HEAD, Branches, Tags
                    node.refs &&
                      node.refs.map((ref, rIdx) =>
                        h(
                          'span',
                          {
                            key: `ref-${rIdx}`,
                            className: `dsh-gg-ref-badge ${ref.type}`,
                          },
                          ref.name
                        )
                      ),
                    // Short Hash
                    h('span', { className: 'dsh-gg-hash' }, node.shortHash),
                    // Subject
                    h('span', { className: 'dsh-gg-subject', title: node.subject }, node.subject),
                    // Author & Time
                    h('span', { className: 'dsh-gg-author' }, node.author),
                    h('span', { className: 'dsh-gg-time' }, node.relativeTime)
                  )
                })
              )
            ),

            // Right: Detail Panel / Drawer
            h(
              'div',
              { className: 'dsh-gg-detail-drawer' },
              selectedNode
                ? h(
                    'div',
                    { className: 'dsh-gg-drawer-inner' },
                    h(
                      'div',
                      { className: 'dsh-gg-drawer-header' },
                      h(
                        'h4',
                        null,
                        selectedNode.isWorkingTree ? tr('graph.inspectWorking') : tr('graph.inspectCommit')
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-gg-icon-btn',
                          onClick: () => setSelectedNode(null),
                        },
                        '✕'
                      )
                    ),

                    h(
                      'div',
                      { className: 'dsh-gg-drawer-body' },
                      // Hash & Copy
                      h(
                        'div',
                        { className: 'dsh-gg-meta-item' },
                        h('span', { className: 'label' }, 'Commit:'),
                        h(
                          'code',
                          { className: 'sha', onClick: () => copyText(selectedNode.hash) },
                          selectedNode.hash,
                          h(CopyIcon, { size: 12, style: { marginLeft: 6 } })
                        )
                      ),

                      // Subject
                      h(
                        'div',
                        { className: 'dsh-gg-meta-item full' },
                        h('div', { className: 'subject' }, selectedNode.subject)
                      ),

                      // Author & Date
                      !selectedNode.isWorkingTree &&
                        h(
                          'div',
                          { className: 'dsh-gg-meta-item' },
                          h('span', { className: 'label' }, 'Author:'),
                          h('span', { className: 'val' }, `${selectedNode.author} <${selectedNode.email}>`)
                        ),
                      !selectedNode.isWorkingTree &&
                        h(
                          'div',
                          { className: 'dsh-gg-meta-item' },
                          h('span', { className: 'label' }, 'Date:'),
                          h('span', { className: 'val' }, selectedNode.date)
                        ),

                      // Parents
                      selectedNode.parents &&
                        selectedNode.parents.length > 0 &&
                        h(
                          'div',
                          { className: 'dsh-gg-meta-item' },
                          h('span', { className: 'label' }, 'Parents:'),
                          h(
                            'div',
                            { className: 'parents-wrap' },
                            selectedNode.parents.map((p) =>
                              h('code', { key: p, className: 'parent-sha', onClick: () => copyText(p) }, p.slice(0, 7))
                            )
                          )
                        ),

                      // Working tree files list
                      selectedNode.isWorkingTree &&
                        status.files &&
                        h(
                          'div',
                          { className: 'dsh-gg-files-box' },
                          h(
                            'h5',
                            null,
                            tr('graph.filesChanged', { n: status.files.length })
                          ),
                          h(
                            'div',
                            { className: 'dsh-gg-files-scroll' },
                            status.files.map((file) =>
                              h(
                                'div',
                                { key: file.path, className: 'dsh-gg-file-row' },
                                h('span', { className: `tag ${file.status}` }, (file.xy || '..').trim()),
                                h('span', { className: 'name', title: file.path }, file.path)
                              )
                            )
                          )
                        ),

                      // Copy notice
                      copyNotice && h('div', { className: 'dsh-gg-notice' }, copyNotice)
                    ),

                    // Actions
                    h(
                      'div',
                      { className: 'dsh-gg-drawer-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-gg-btn primary',
                          onClick: () => copyText(selectedNode.hash),
                        },
                        tr('dock.copySha')
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-gg-btn secondary',
                          onClick: () => copyText(`git show ${selectedNode.hash}`),
                        },
                        'git show'
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-gg-btn secondary',
                          onClick: () => copyText(`git diff ${selectedNode.hash}^!`),
                        },
                        'git diff'
                      )
                    )
                  )
                : h(
                    'div',
                    { className: 'dsh-gg-drawer-empty' },
                    h(GitCommitIcon, { size: 32, style: { opacity: 0.3 } }),
                    h('p', null, 'Click on any commit or working change node to inspect details')
                  )
            )
          ),

          // Scoped Stylesheet
          h('style', null, CSS_STYLES)
        )
      } catch (err) {
        console.error('[dsh-git-graph] GitGraphView crash prevented:', err)
        return h(
          'div',
          { ref: rootRef, className: 'dsh-gg-container' },
          h(
            'div',
            { className: 'dsh-gg-empty-state is-error' },
            h(GitBranchIcon, { size: 40, style: { color: '#f87171' } }),
            h('h3', null, 'Git 树图渲染捕获到异常'),
            h('p', { style: { color: '#aaa', fontSize: 12, maxWidth: 440, textAlign: 'center' } }, err?.message || String(err)),
            h('button', {
              type: 'button',
              className: 'dsh-gg-btn primary',
              onClick: () => window.location.reload(),
              style: { marginTop: 12 },
            }, '刷新页面')
          ),
          h('style', null, CSS_STYLES)
        )
      }
    }

    // -------------------------------------------------------------------------
    // Scoped CSS Styles (Derived from DSH Theme Tokens)
    // -------------------------------------------------------------------------
    const CSS_STYLES = `
      .dsh-gg-dock-wrap { position: relative; display: inline-flex; align-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .dsh-gg-dock-pill {
        display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
        border-radius: 13px; font-size: 12px; font-weight: 500; cursor: pointer;
        background: var(--dsw-alias-bg-layer-2, #262626); color: var(--dsw-alias-label-primary, #ededed);
        border: 1px solid var(--dsw-alias-border-l2, #3a3a3a); transition: all 0.15s ease;
      }
      .dsh-gg-dock-pill:hover, .dsh-gg-dock-pill.is-active {
        background: var(--dsw-alias-interactive-bg-hover, #333);
        border-color: var(--dsw-alias-border-l1, #555);
      }
      .dsh-gg-dock-pill.is-loading { opacity: 0.7; cursor: wait; }
      .dsh-gg-dock-pill.is-error { border-color: rgba(248, 113, 113, 0.4); color: #f87171; }
      .dsh-gg-dock-branch { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-gg-dock-badge { font-size: 11px; padding: 1px 5px; border-radius: 9px; }
      .dsh-gg-dock-badge.dirty { background: rgba(245, 158, 11, 0.2); color: #f59e0b; font-weight: 600; }
      .dsh-gg-dock-badge.clean { color: #10b981; }
      .dsh-gg-dock-ahead { color: #38bdf8; font-size: 11px; font-weight: 600; }
      .dsh-gg-dock-behind { color: #f43f5e; font-size: 11px; font-weight: 600; }

      .dsh-gg-flyout {
        position: absolute; bottom: 32px; left: 0; width: 340px;
        background: var(--dsw-alias-bg-layer-1, #1e1e1e);
        border: 1px solid var(--dsw-alias-border-l1, #3a3a3a);
        border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        z-index: 1000; overflow: hidden; display: flex; flex-direction: column;
      }
      .dsh-gg-flyout-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2, #333);
        background: var(--dsw-alias-bg-layer-2, #242424);
      }
      .dsh-gg-flyout-title { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-primary, #fff); }
      .dsh-gg-flyout-actions { display: flex; align-items: center; gap: 4px; }
      .dsh-gg-icon-btn {
        background: transparent; border: none; cursor: pointer; color: var(--dsw-alias-label-secondary, #999);
        padding: 4px; border-radius: 4px; display: flex; align-items: center; justify-content: center;
      }
      .dsh-gg-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #333); color: var(--dsw-alias-label-primary, #fff); }
      .dsh-gg-flyout-body { padding: 12px; font-size: 12px; display: flex; flex-direction: column; gap: 10px; }
      .dsh-gg-flyout-status-row { display: flex; align-items: center; justify-content: space-between; }
      .dsh-gg-status-label { color: var(--dsw-alias-label-secondary, #888); }
      .dsh-gg-sha-tag { font-family: monospace; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; }
      .dsh-gg-flyout-dirty-box { background: rgba(0,0,0,0.2); border-radius: 6px; padding: 8px; }
      .dsh-gg-dirty-counts { display: flex; gap: 8px; font-size: 11px; margin-bottom: 6px; }
      .dsh-gg-dirty-counts .staged { color: #10b981; }
      .dsh-gg-dirty-counts .unstaged { color: #f59e0b; }
      .dsh-gg-dirty-counts .untracked { color: #888; }
      .dsh-gg-file-list { list-style: none; margin: 0; padding: 0; max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .dsh-gg-file-item { display: flex; align-items: center; gap: 6px; font-size: 11px; font-family: monospace; }
      .dsh-gg-file-item .status-tag { padding: 1px 4px; border-radius: 3px; font-weight: bold; font-size: 10px; }
      .dsh-gg-file-item .status-tag.modified { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
      .dsh-gg-file-item .status-tag.added { background: rgba(16, 185, 129, 0.2); color: #10b981; }
      .dsh-gg-file-item .status-tag.untracked { background: rgba(156, 163, 175, 0.2); color: #9ca3af; }
      .dsh-gg-file-item .file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .dsh-gg-copied-notice { color: #10b981; font-size: 11px; text-align: center; }
      .dsh-gg-flyout-footer { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l2, #333); background: var(--dsw-alias-bg-layer-2, #242424); }

      /* Full View Styles */
      .dsh-gg-container { display: flex; flex-direction: column; height: 100%; width: 100%; min-height: 480px; background: var(--dsw-alias-bg-base, #121212); color: var(--dsw-alias-label-primary, #eee); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; position: relative; }
      .dsh-gg-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, #2c2c2c); background: var(--dsw-alias-bg-layer-1, #1a1a1a); }
      .dsh-gg-toolbar-left { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; }
      .dsh-gg-title { font-weight: 600; font-size: 14px; }
      .dsh-gg-branch-chip { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 500; }
      .dsh-gg-dirty-chip { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: rgba(245, 158, 11, 0.18); color: #f59e0b; font-weight: 500; }
      .dsh-gg-toolbar-right { display: flex; align-items: center; gap: 8px; }
      .dsh-gg-search-input { background: var(--dsw-alias-bg-layer-2, #262626); border: 1px solid var(--dsw-alias-border-l2, #3a3a3a); border-radius: 6px; padding: 5px 10px; font-size: 12px; color: #fff; width: 220px; outline: none; }
      .dsh-gg-search-input:focus { border-color: var(--dsw-alias-brand-primary, #38bdf8); }
      .dsh-gg-btn { padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid transparent; font-weight: 500; }
      .dsh-gg-btn.primary { background: var(--dsw-alias-brand-primary, #2563eb); color: #fff; }
      .dsh-gg-btn.secondary { background: var(--dsw-alias-bg-layer-2, #333); color: #ddd; border-color: var(--dsw-alias-border-l2, #444); }
      .dsh-gg-btn.icon { background: var(--dsw-alias-bg-layer-2, #262626); border: 1px solid var(--dsw-alias-border-l2, #3a3a3a); color: #aaa; display: flex; align-items: center; justify-content: center; padding: 5px; }

      .dsh-gg-main { display: flex; flex: 1; overflow: hidden; position: relative; min-height: 400px; }
      .dsh-gg-graph-area { flex: 1; overflow: auto; position: relative; background: var(--dsw-alias-bg-base, #141414); }
      .dsh-gg-svg-wrap { position: absolute; top: 0; left: 0; z-index: 1; pointer-events: none; }
      .dsh-gg-svg-layer { display: block; overflow: visible; }
      .dsh-gg-node-dot { pointer-events: auto; }
      .dsh-gg-node-dot:hover circle { stroke: #fff; stroke-width: 2.5; }

      .dsh-gg-rows-layer { position: absolute; top: 0; right: 0; z-index: 2; pointer-events: auto; }
      .dsh-gg-commit-row {
        position: absolute; height: 36px; display: flex; align-items: center; gap: 8px;
        padding-left: 12px; padding-right: 16px; border-radius: 4px; cursor: pointer;
        font-size: 12px; white-space: nowrap; right: 0; transition: background 0.1s ease;
      }
      .dsh-gg-commit-row:hover { background: rgba(255,255,255,0.04); }
      .dsh-gg-commit-row.is-selected { background: rgba(56, 189, 248, 0.12); border-left: 2px solid #38bdf8; }
      .dsh-gg-commit-row.is-working { font-style: italic; color: #f59e0b; font-weight: 500; }
      .dsh-gg-ref-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; font-family: monospace; }
      .dsh-gg-ref-badge.head { background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); }
      .dsh-gg-ref-badge.branch { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
      .dsh-gg-ref-badge.remote { background: rgba(168, 85, 247, 0.15); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.3); }
      .dsh-gg-ref-badge.tag { background: rgba(234, 179, 8, 0.15); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.3); }
      .dsh-gg-hash { font-family: monospace; color: var(--dsw-alias-label-secondary, #777); font-size: 11px; }
      .dsh-gg-subject { color: var(--dsw-alias-label-primary, #ddd); max-width: 380px; overflow: hidden; text-overflow: ellipsis; }
      .dsh-gg-author { color: var(--dsw-alias-label-secondary, #888); font-size: 11px; margin-left: auto; padding-left: 12px; }
      .dsh-gg-time { color: var(--dsw-alias-label-tertiary, #666); font-size: 11px; min-width: 60px; text-align: right; }

      .dsh-gg-detail-drawer { width: 320px; border-left: 1px solid var(--dsw-alias-border-l1, #2c2c2c); background: var(--dsw-alias-bg-layer-1, #181818); display: flex; flex-direction: column; overflow-y: auto; }
      .dsh-gg-drawer-inner { display: flex; flex-direction: column; height: 100%; }
      .dsh-gg-drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2, #2c2c2c); }
      .dsh-gg-drawer-header h4 { margin: 0; font-size: 13px; font-weight: 600; }
      .dsh-gg-drawer-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; flex: 1; font-size: 12px; }
      .dsh-gg-meta-item { display: flex; gap: 8px; font-size: 12px; }
      .dsh-gg-meta-item .label { color: var(--dsw-alias-label-secondary, #888); width: 60px; flex-shrink: 0; }
      .dsh-gg-meta-item .val { color: var(--dsw-alias-label-primary, #eee); }
      .dsh-gg-meta-item .sha { font-family: monospace; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; word-break: break-all; }
      .dsh-gg-meta-item.full .subject { font-size: 13px; font-weight: 500; color: #fff; line-height: 1.4; }
      .parents-wrap { display: flex; gap: 6px; flex-wrap: wrap; }
      .parent-sha { font-family: monospace; background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; cursor: pointer; }
      .dsh-gg-files-box { margin-top: 6px; border-top: 1px solid var(--dsw-alias-border-l2, #333); padding-top: 8px; }
      .dsh-gg-files-box h5 { margin: 0 0 8px 0; font-size: 12px; }
      .dsh-gg-files-scroll { max-height: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .dsh-gg-file-row { display: flex; align-items: center; gap: 6px; font-size: 11px; font-family: monospace; }
      .dsh-gg-file-row .tag { font-weight: bold; padding: 1px 4px; border-radius: 3px; }
      .dsh-gg-file-row .tag.modified { color: #f59e0b; }
      .dsh-gg-file-row .tag.added { color: #10b981; }
      .dsh-gg-file-row .tag.deleted { color: #ef4444; }
      .dsh-gg-file-row .tag.untracked { color: #9ca3af; }
      .dsh-gg-file-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .dsh-gg-notice { color: #10b981; font-size: 11px; text-align: center; }
      .dsh-gg-drawer-actions { padding: 12px; border-top: 1px solid var(--dsw-alias-border-l2, #2c2c2c); display: flex; gap: 6px; }
      .dsh-gg-drawer-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #666; font-size: 12px; padding: 20px; text-align: center; }
      .dsh-gg-view-loading { display: flex; align-items: center; justify-content: center; height: 320px; color: #888; font-size: 13px; }
      .dsh-gg-empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 360px; color: #777; gap: 10px; padding: 24px; text-align: center; }
      .dsh-gg-empty-state.is-error h3 { color: #f87171; }
    `

    // -------------------------------------------------------------------------
    // Plugin Export Factory
    // -------------------------------------------------------------------------
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Register localizations
        ctx.locale.register(NS, { zh, en })
        const t = ctx.locale.bind(NS)

        // 1. Register Git Dock item in Conversation Input/Composer Dock
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'dsh-git-dock',
              order: 15,
              locale: NS,
              inject: (sessionId) => ({ sessionId, t }),
            },
            GitDock
          )
        )

        // 2. Register full Git Graph tab in Conversation View Navigator
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'dsh-git-graph',
              order: 25,
              locale: NS,
              label: () => t('view.label'),
              inject: (sessionId) => ({ sessionId, t }),
            },
            GitGraphView
          )
        )
      },
    }
  },
})
