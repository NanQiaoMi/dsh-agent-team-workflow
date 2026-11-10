/**
 * @local/dsh-git-graph - Client UI Plugin (Professional Git Graph View & Animations)
 *
 * Registers:
 * 1. `conversation.input.dock` -> Interactive Git Status Icon, Pulse Badge, Mini-Timeline & Flyout
 * 2. `conversation.view` -> Full-fidelity Interactive Git Tree DAG Graph View with:
 *    - Professional Tabular Row Layout: Zero-drift natural document flow aligned with SVG graph.
 *    - Tight, subway-style Bezier tracks without bulging loops.
 *    - Full-width table by default, drawer slides in on demand.
 *    - Multi-dimensional filters (All / Current Branch / Dirty Changes).
 *    - SVG node animations: New entry stagger, amber dirty aura, flowing merge particle streams.
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
    const DEFAULT_POLL_MS = 2500
    const ROW_HEIGHT = 38

    // -------------------------------------------------------------------------
    // Localization Dictionaries (Strict 100% Key Parity)
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
      'dock.recentCommits': '最近提交历史',
      'graph.title': 'Git 提交关系与分支树',
      'graph.searchPlaceholder': '搜索提交信息、SHA、作者或分支...',
      'graph.uncommitted': '工作区未提交改动',
      'graph.staged': '暂存 {n}',
      'graph.unstaged': '未暂存 {n}',
      'graph.untracked': '未跟踪 {n}',
      'graph.headBadge': 'HEAD',
      'graph.mergeBadge': 'MERGE',
      'graph.newBadge': 'NEW',
      'graph.workingBadge': 'WORKING',
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
      'graph.filterAll': '全部提交',
      'graph.filterBranch': '当前分支',
      'graph.filterDirty': '仅工作区',
      'graph.copyPath': '复制路径',
      'graph.colCommit': '提交描述与分支',
      'graph.colAuthor': '作者',
      'graph.colDate': '时间',
      'graph.colSha': '哈希',
      'graph.askAgentReview': '🤖 审查此提交',
      'graph.askAgentSuggest': '🤖 分析改动并生成 Commit',
      'graph.askAgentState': '🤖 注入当前 Git 状态到对话',
      'graph.promptInjected': '已填入输入框（并已复制）！',
      'graph.commitFiles': '变更文件 ({n})',
      'graph.commitBody': '提交详细说明',
      'graph.copyCheckout': '检出新分支',
      'graph.copyCherryPick': '挑选提交',
      'graph.loadingCommit': '正在读取提交详情...',
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
      'dock.recentCommits': 'Recent Commit History',
      'graph.title': 'Git Commit DAG & Branch Tree',
      'graph.searchPlaceholder': 'Search message, SHA, author, branch...',
      'graph.uncommitted': 'Uncommitted Working Changes',
      'graph.staged': 'staged {n}',
      'graph.unstaged': 'unstaged {n}',
      'graph.untracked': 'untracked {n}',
      'graph.headBadge': 'HEAD',
      'graph.mergeBadge': 'MERGE',
      'graph.newBadge': 'NEW',
      'graph.workingBadge': 'WORKING',
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
      'graph.filterAll': 'All Commits',
      'graph.filterBranch': 'Current Branch',
      'graph.filterDirty': 'Working Changes',
      'graph.copyPath': 'Copy Path',
      'graph.colCommit': 'Commit Description & Refs',
      'graph.colAuthor': 'Author',
      'graph.colDate': 'Date',
      'graph.colSha': 'SHA',
      'graph.askAgentReview': '🤖 Review with Agent',
      'graph.askAgentSuggest': '🤖 Suggest Commit with Agent',
      'graph.askAgentState': '🤖 Send Git State to Agent',
      'graph.promptInjected': 'Inserted into chat (and copied)!',
      'graph.commitFiles': 'Changed Files ({n})',
      'graph.commitBody': 'Commit Body',
      'graph.copyCheckout': 'Checkout Branch',
      'graph.copyCherryPick': 'Cherry-pick',
      'graph.loadingCommit': 'Loading commit details...',
    }

    // -------------------------------------------------------------------------
    // Custom Hooks
    // -------------------------------------------------------------------------

    /** Fetch live Git snapshot with automatic state transition tracking */
    function useGitSnapshot(sessionId, pollMs = DEFAULT_POLL_MS) {
      const [snapshot, setSnapshot] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [lastUpdated, setLastUpdated] = useState(null)
      const [newHashes, setNewHashes] = useState(new Set())
      const [dirtyPulse, setDirtyPulse] = useState(false)
      const prevSnapshotRef = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const url = `${SNAPSHOT_PATH}?session=${encodeURIComponent(sessionId || '')}&limit=100`
          const res = await fetch(url, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`)
          }
          const data = await res.json()
          if (data && typeof data === 'object') {
            // Detect state transitions for animations
            if (prevSnapshotRef.current && prevSnapshotRef.current.graph?.nodes && data.graph?.nodes) {
              const oldSet = new Set(prevSnapshotRef.current.graph.nodes.map((n) => n.hash))
              const newlyAdded = new Set()
              for (const n of data.graph.nodes) {
                if (!oldSet.has(n.hash) && !n.isWorkingTree) {
                  newlyAdded.add(n.hash)
                }
              }
              if (newlyAdded.size > 0) {
                setNewHashes(newlyAdded)
                setTimeout(() => setNewHashes(new Set()), 4000)
              }

              // Detect working tree modifications
              const oldChanged = prevSnapshotRef.current.status?.totalChanged || 0
              const curChanged = data.status?.totalChanged || 0
              if (oldChanged !== curChanged) {
                setDirtyPulse(true)
                setTimeout(() => setDirtyPulse(false), 1600)
              }
            }

            prevSnapshotRef.current = data
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

      return { snapshot, loading, error, refresh, lastUpdated, newHashes, dirtyPulse }
    }

    /** Helper to inject prompt text into chat input textarea and copy to clipboard */
    function injectPromptIntoChat(promptText) {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(promptText).catch(() => {})
      }
      try {
        if (typeof document !== 'undefined') {
          const textarea =
            document.querySelector('.dsh-client-ui-conversation textarea') ||
            document.querySelector('textarea')
          if (textarea) {
            textarea.value = promptText
            textarea.dispatchEvent(new Event('input', { bubbles: true }))
            textarea.dispatchEvent(new Event('change', { bubbles: true }))
            textarea.focus()
            if (typeof textarea.setSelectionRange === 'function') {
              const len = promptText.length
              textarea.setSelectionRange(len, len)
            }
            return true
          }
        }
      } catch {
        /* fallback */
      }
      return false
    }

    /** Hook to fetch full commit details on demand */
    function useCommitDetails(selectedHash, sessionId) {
      const [details, setDetails] = useState(null)
      const [loading, setLoading] = useState(false)

      useEffect(() => {
        if (!selectedHash || selectedHash === 'working-tree') {
          setDetails(null)
          return
        }

        let active = true
        setLoading(true)
        const url = `${SNAPSHOT_PATH}?session=${encodeURIComponent(sessionId || '')}&commit=${encodeURIComponent(selectedHash)}`

        fetch(url, { headers: { accept: 'application/json' } })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (active && data?.ok) {
              setDetails(data)
            }
          })
          .catch(() => {})
          .finally(() => {
            if (active) setLoading(false)
          })

        return () => {
          active = false
        }
      }, [selectedHash, sessionId])

      return { details, loading }
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
          className: props.className,
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
          className: props.className,
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
          className: props.spinning ? 'dsh-gg-spin' : '',
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
          width: props.size || 12,
          height: props.size || 12,
          fill: 'currentColor',
          style: props.style,
          className: props.className,
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

    function ChevronDownIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: props.size || 11,
          height: props.size || 11,
          fill: 'currentColor',
          style: props.style,
          className: props.className,
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M4.427 6.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 6H4.604a.25.25 0 00-.177.427z',
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

        const { snapshot, loading, error, refresh, dirtyPulse } = useGitSnapshot(sessionId, 2500)
        const [flyoutOpen, setFlyoutOpen] = useState(false)
        const [copiedText, setCopiedText] = useState('')
        const [isRefreshing, setIsRefreshing] = useState(false)

        const copyToClipboard = (text, label) => {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
              setCopiedText(label)
              setTimeout(() => setCopiedText(''), 1500)
            })
          }
        }

        const handleManualRefresh = () => {
          setIsRefreshing(true)
          refresh().finally(() => setTimeout(() => setIsRefreshing(false), 500))
        }

        const status = snapshot?.status || {}
        const isGitRepo = Boolean(snapshot?.isGitRepo)
        const branch = status.headBranch || 'Git'
        const isDirty = Boolean(status.isDirty)
        const changedCount = status.totalChanged || 0
        const ahead = status.ahead || 0
        const behind = status.behind || 0

        const recentCommits = useMemo(() => {
          if (!snapshot?.graph?.nodes) return []
          return snapshot.graph.nodes.filter((n) => !n.isWorkingTree).slice(0, 3)
        }, [snapshot])

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

        if (error && !snapshot) {
          return h(
            'div',
            { className: 'dsh-gg-dock-wrap' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-gg-dock-pill is-error',
                onClick: handleManualRefresh,
                title: `${error} (${tr('dock.refresh')})`,
              },
              h(GitBranchIcon, { size: 13, style: { color: '#f87171' } }),
              h('span', { className: 'dsh-gg-dock-branch' }, tr('dock.offline'))
            )
          )
        }

        if (snapshot && !isGitRepo) {
          return h(
            'div',
            { className: 'dsh-gg-dock-wrap' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-gg-dock-pill is-clean',
                onClick: handleManualRefresh,
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
              className: `dsh-gg-dock-pill ${isDirty ? 'is-dirty' : 'is-clean'} ${flyoutOpen ? 'is-active' : ''} ${dirtyPulse ? 'has-pulse' : ''}`,
              onClick: () => setFlyoutOpen(!flyoutOpen),
              title: isDirty ? `Git: ${branch} (${changedCount} uncommitted)` : `Git: ${branch} (clean)`,
            },
            h(GitBranchIcon, { size: 13, className: 'dsh-gg-dock-icon-rock' }),
            h('span', { className: 'dsh-gg-dock-branch' }, branch),
            isDirty
              ? h('span', { className: `dsh-gg-dock-badge dirty ${dirtyPulse ? 'bounce' : ''}` }, `● ${changedCount}`)
              : h('span', { className: 'dsh-gg-dock-badge clean' }, '✓'),
            ahead > 0 && h('span', { className: 'dsh-gg-dock-ahead' }, `↑${ahead}`),
            behind > 0 && h('span', { className: 'dsh-gg-dock-behind' }, `↓${behind}`)
          ),

          flyoutOpen &&
            h(
              'div',
              { className: 'dsh-gg-flyout dsh-gg-animate-in' },
              h(
                'div',
                { className: 'dsh-gg-flyout-header' },
                h(
                  'div',
                  { className: 'dsh-gg-flyout-title' },
                  h(GitBranchIcon, { size: 14, style: { color: '#38bdf8' } }),
                  h('strong', null, branch),
                  isDirty && h('span', { className: 'dsh-gg-dirty-chip mini' }, `${changedCount} uncommitted`)
                ),
                h(
                  'div',
                  { className: 'dsh-gg-flyout-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-gg-icon-btn',
                      onClick: handleManualRefresh,
                      title: tr('dock.refresh'),
                    },
                    h(RefreshIcon, { size: 12, spinning: isRefreshing })
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
                  h('span', { className: 'dsh-gg-status-label' }, 'HEAD:'),
                  h(
                    'span',
                    {
                      className: 'dsh-gg-sha-tag',
                      onClick: () => copyToClipboard(status.headOid || '', 'sha'),
                      title: 'Click to copy SHA',
                    },
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
                      (status.files || []).slice(0, 5).map((f) =>
                        h(
                          'li',
                          { key: f.path, className: 'dsh-gg-file-item' },
                          h('span', { className: `status-tag ${f.status}` }, (f.xy || '..').trim()),
                          h('span', { className: 'file-path', title: f.path }, f.path)
                        )
                      )
                    )
                  ),

                recentCommits.length > 0 &&
                  h(
                    'div',
                    { className: 'dsh-gg-mini-timeline' },
                    h('div', { className: 'dsh-gg-mini-timeline-title' }, tr('dock.recentCommits')),
                    h(
                      'div',
                      { className: 'dsh-gg-mini-timeline-list' },
                      recentCommits.map((c) =>
                        h(
                          'div',
                          {
                            key: c.hash,
                            className: 'dsh-gg-mini-item',
                            onClick: () => copyToClipboard(c.hash, 'sha'),
                            title: `${c.subject} (${c.hash})\nClick to copy SHA`,
                          },
                          h('span', {
                            className: 'dsh-gg-mini-dot',
                            style: { background: c.color || '#38bdf8' },
                          }),
                          h('span', { className: 'dsh-gg-mini-sha' }, c.shortHash),
                          h('span', { className: 'dsh-gg-mini-subj' }, c.subject),
                          h('span', { className: 'dsh-gg-mini-time' }, c.relativeTime)
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
                    className: 'dsh-gg-btn prompt mini',
                    onClick: () => {
                      const promptText = `【当前 Git 状态】分支: ${branch}${status.ahead ? ` (超前 ${status.ahead})` : ''}${status.behind ? ` (落后 ${status.behind})` : ''}。${isDirty ? `工作区有 ${totalChanged} 项未提交改动（暂存 ${status.staged || 0}，未暂存 ${status.unstaged || 0}，未跟踪 ${status.untracked || 0}）。` : '工作区当前干净。'}`
                      injectPromptIntoChat(promptText)
                      setCopiedText('prompt')
                      setTimeout(() => setCopiedText(''), 2000)
                    },
                    title: tr('graph.askAgentState'),
                  },
                  tr('graph.askAgentState')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-gg-btn secondary mini',
                    onClick: () => copyToClipboard(branch, 'branch'),
                  },
                  tr('dock.copyBranch')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-gg-btn secondary mini',
                    onClick: () => copyToClipboard('git diff', 'diff'),
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
    // Component: GitGraphView (Full View Table with Pixel-Perfect Alignment)
    // -------------------------------------------------------------------------

    function GitGraphView(props) {
      const rootRef = useRef(null)

      try {
        const source = props && typeof props === 'object' ? props : {}
        const sessionId = source.sessionId || ''
        const tr = makeTr(source.t, zh)

        const { snapshot, loading, error, refresh, newHashes, dirtyPulse } = useGitSnapshot(sessionId, 2500)
        const [searchQuery, setSearchQuery] = useState('')
        const [selectedNode, setSelectedNode] = useState(null)
        const [hoveredNodeHash, setHoveredNodeHash] = useState(null)
        const [copyNotice, setCopyNotice] = useState('')
        const [isManualRefreshing, setIsManualRefreshing] = useState(false)
        const [filterMode, setFilterMode] = useState('all') // 'all' | 'branch' | 'dirty'
        const [expandedGroups, setExpandedGroups] = useState({ staged: true, unstaged: true, untracked: true })

        const { details: commitDetails, loading: commitDetailsLoading } = useCommitDetails(selectedNode?.hash, sessionId)

        // Normalize scrollport on mount
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

        const handleRefreshClick = () => {
          setIsManualRefreshing(true)
          refresh().finally(() => setTimeout(() => setIsManualRefreshing(false), 500))
        }

        const copyText = (text) => {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
              setCopyNotice(tr('graph.copied'))
              setTimeout(() => setCopyNotice(''), 1500)
            })
          }
        }

        const askAgentAboutCommit = (commit) => {
          const fileNames = commitDetails?.files?.map((f) => f.path).slice(0, 8).join(', ') || ''
          const totalFiles = commitDetails?.files?.length || 0
          const promptText = `请帮我审查提交 ${commit.shortHash || commit.hash.slice(0, 7)} ("${commit.subject}")：\n- 作者: ${commit.author} (${commit.date})\n${fileNames ? `- 涉及文件: ${fileNames}${totalFiles > 8 ? ` 等共 ${totalFiles} 个文件` : ''}\n` : ''}请分析代码实现意图，评估改动影响，指出潜在缺陷或边界风险。`
          const injected = injectPromptIntoChat(promptText)
          setCopyNotice(injected ? tr('graph.promptInjected') : tr('graph.copied'))
          setTimeout(() => setCopyNotice(''), 2500)
        }

        const askAgentAboutWorking = () => {
          const staged = stagedFiles.map((f) => f.path).slice(0, 10).join(', ')
          const unstaged = unstagedFiles.map((f) => f.path).slice(0, 10).join(', ')
          const untracked = untrackedFiles.map((f) => f.path).slice(0, 10).join(', ')
          const promptText = `请帮我分析当前工作区未提交的代码改动（共 ${files.length} 个文件）：\n${staged ? `- 暂存文件 (${stagedFiles.length}): ${staged}\n` : ''}${unstaged ? `- 未暂存文件 (${unstagedFiles.length}): ${unstaged}\n` : ''}${untracked ? `- 未跟踪文件 (${untrackedFiles.length}): ${untracked}\n` : ''}请评估改动质量与风险，并建议规范的 Conventional Commits 格式提交信息。`
          const injected = injectPromptIntoChat(promptText)
          setCopyNotice(injected ? tr('graph.promptInjected') : tr('graph.copied'))
          setTimeout(() => setCopyNotice(''), 2500)
        }

        const toggleGroup = (key) => {
          setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }))
        }

        const status = snapshot?.status || {}
        const currentBranch = status.headBranch || 'main'

        // Filter nodes by mode & search query
        const filteredNodes = useMemo(() => {
          if (!snapshot?.graph?.nodes) return []
          let list = snapshot.graph.nodes

          if (filterMode === 'branch') {
            list = list.filter(
              (n) =>
                n.isWorkingTree ||
                n.isHead ||
                (n.refs && n.refs.some((r) => r.name === currentBranch || r.name === `origin/${currentBranch}`)) ||
                n.lane === 0
            )
          } else if (filterMode === 'dirty') {
            list = list.filter((n) => n.isWorkingTree || n.isHead)
          }

          if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase()
            list = list.filter(
              (n) =>
                (n.subject && n.subject.toLowerCase().includes(q)) ||
                (n.hash && n.hash.toLowerCase().includes(q)) ||
                (n.author && n.author.toLowerCase().includes(q)) ||
                (n.refs && n.refs.some((r) => r.name && r.name.toLowerCase().includes(q)))
            )
          }

          return list
        }, [snapshot, filterMode, searchQuery, currentBranch])

        // 1. Loading State
        if (loading && !snapshot) {
          return h(
            'div',
            { ref: rootRef, className: 'dsh-gg-container' },
            h(
              'div',
              { className: 'dsh-gg-view-loading' },
              h(GitCommitIcon, { size: 28, className: 'dsh-gg-spin-slow', style: { marginBottom: 12, opacity: 0.6 } }),
              h('div', null, tr('graph.loading'))
            ),
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
                  onClick: handleRefreshClick,
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

        const nodes = filteredNodes || []
        const connections = snapshot.graph?.connections || []
        const maxLane = snapshot.graph?.maxLane ?? 0
        const graphColWidth = Math.max(18 * 2 + (maxLane + 1) * 18, 56)
        const totalHeight = nodes.length * ROW_HEIGHT
        const isDirty = Boolean(status.isDirty)
        const totalChanged = status.totalChanged || 0

        const files = status.files || []
        const stagedFiles = files.filter((f) => f.staged || (f.xy && f.xy[0] && f.xy[0] !== ' ' && f.xy[0] !== '?'))
        const unstagedFiles = files.filter((f) => !f.staged && f.xy && f.xy[1] && f.xy[1] !== ' ' && f.xy[1] !== '?')
        const untrackedFiles = files.filter((f) => f.status === 'untracked' || f.xy === '??')

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
              h(GitBranchIcon, { size: 16, style: { color: '#38bdf8' } }),
              h('span', { className: 'dsh-gg-title' }, tr('graph.title')),
              h('span', { className: 'dsh-gg-branch-chip' }, currentBranch),
              isDirty &&
                h('span', { className: `dsh-gg-dirty-chip ${dirtyPulse ? 'pulse' : ''}` }, `${totalChanged} uncommitted`),

              // Filter Tabs
              h(
                'div',
                { className: 'dsh-gg-filter-tabs' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: `dsh-gg-filter-tab ${filterMode === 'all' ? 'active' : ''}`,
                    onClick: () => setFilterMode('all'),
                  },
                  tr('graph.filterAll')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: `dsh-gg-filter-tab ${filterMode === 'branch' ? 'active' : ''}`,
                    onClick: () => setFilterMode('branch'),
                  },
                  tr('graph.filterBranch')
                ),
                isDirty &&
                  h(
                    'button',
                    {
                      type: 'button',
                      className: `dsh-gg-filter-tab ${filterMode === 'dirty' ? 'active' : ''}`,
                      onClick: () => setFilterMode('dirty'),
                    },
                    tr('graph.filterDirty')
                  )
              )
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
                  onClick: handleRefreshClick,
                  title: tr('dock.refresh'),
                },
                h(RefreshIcon, { size: 14, spinning: isManualRefreshing })
              )
            )
          ),

          // Main Layout Area
          h(
            'div',
            { className: 'dsh-gg-main' },
            // Table Scroll Area
            h(
              'div',
              { className: 'dsh-gg-table-scroll' },
              // Table Header
              h(
                'div',
                { className: 'dsh-gg-table-header' },
                h('div', { className: 'col-graph-hdr', style: { width: graphColWidth } }, 'Graph'),
                h('div', { className: 'col-msg-hdr' }, tr('graph.colCommit')),
                h('div', { className: 'col-author-hdr' }, tr('graph.colAuthor')),
                h('div', { className: 'col-date-hdr' }, tr('graph.colDate')),
                h('div', { className: 'col-sha-hdr' }, tr('graph.colSha'))
              ),

              // Table Body (Rows + Aligned SVG Overlay)
              h(
                'div',
                { className: 'dsh-gg-table-body', style: { minHeight: totalHeight } },
                // 1. Precise Aligned SVG Canvas
                h(
                  'svg',
                  {
                    className: 'dsh-gg-svg-canvas',
                    style: {
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: graphColWidth,
                      height: totalHeight,
                      pointerEvents: 'auto',
                      overflow: 'visible',
                      zIndex: 3,
                    },
                    width: graphColWidth,
                    height: totalHeight,
                  },
                  // Defs: Gradients and Glow filters
                  h(
                    'defs',
                    null,
                    h(
                      'linearGradient',
                      { id: 'dsh-gg-merge-grad', x1: '0%', y1: '0%', x2: '100%', y2: '100%' },
                      h('stop', { offset: '0%', stopColor: '#c084fc' }),
                      h('stop', { offset: '100%', stopColor: '#38bdf8' })
                    )
                  ),

                  // Connection paths
                  connections.map((conn, idx) => {
                    const isHoverRelated =
                      hoveredNodeHash &&
                      (conn.fromHash === hoveredNodeHash || conn.toHash === hoveredNodeHash)
                    const isMerge = conn.isMerge

                    return h(
                      'g',
                      { key: `conn-${idx}` },
                      h('path', {
                        d: conn.path,
                        stroke: conn.color || 'var(--dsw-alias-border-l1)',
                        strokeWidth: isHoverRelated ? 3 : isMerge ? 2.2 : 2,
                        strokeDasharray: isMerge ? '4,4' : 'none',
                        className: `dsh-gg-conn-path ${isMerge ? 'is-merge-flow' : ''} ${isHoverRelated ? 'is-hover-highlight' : ''}`,
                        fill: 'none',
                        opacity: isHoverRelated ? 1 : hoveredNodeHash ? 0.25 : 0.85,
                      }),
                      isMerge &&
                        h('path', {
                          d: conn.path,
                          stroke: '#fff',
                          strokeWidth: 1.4,
                          strokeDasharray: '3, 8',
                          className: 'dsh-gg-merge-particle-stream',
                          fill: 'none',
                          opacity: isHoverRelated ? 0.95 : 0.6,
                        })
                    )
                  }),

                  // Node dots
                  nodes.map((node, nIdx) => {
                    const isSelected = selectedNode?.hash === node.hash
                    const isHovered = hoveredNodeHash === node.hash
                    const isNewlyAdded = newHashes.has(node.hash)
                    const isWorking = node.isWorkingTree
                    const isMerge = node.isMerge
                    const isHead = node.isHead

                    return h(
                      'g',
                      {
                        key: `dot-${node.hash}`,
                        className: `dsh-gg-node-dot ${isSelected ? 'is-selected' : ''} ${isHovered ? 'is-hovered' : ''} ${isNewlyAdded ? 'is-new' : ''}`,
                        onClick: () => setSelectedNode(node),
                        onMouseEnter: () => setHoveredNodeHash(node.hash),
                        onMouseLeave: () => setHoveredNodeHash(null),
                        style: {
                          cursor: 'pointer',
                          animationDelay: `${Math.min(nIdx * 15, 250)}ms`,
                        },
                      },
                      isWorking &&
                        h('circle', {
                          cx: node.x,
                          cy: node.y,
                          r: 9,
                          className: 'dsh-gg-aura-wave',
                          fill: 'none',
                          stroke: '#f59e0b',
                          strokeWidth: 1.6,
                        }),
                      isWorking
                        ? h('polygon', {
                            points: `${node.x},${node.y - 6} ${node.x + 6},${node.y} ${node.x},${node.y + 6} ${node.x - 6},${node.y}`,
                            className: 'dsh-gg-diamond-working',
                            fill: node.color,
                            stroke: '#fff',
                            strokeWidth: 1.8,
                          })
                        : h('circle', {
                            cx: node.x,
                            cy: node.y,
                            r: isHead ? 6 : isMerge ? 5.5 : 4.5,
                            fill: node.color,
                            stroke: isHead || isSelected ? '#fff' : 'rgba(0,0,0,0.4)',
                            strokeWidth: isHead ? 2.5 : isSelected ? 2 : 1,
                            className: `dsh-gg-commit-circle ${isMerge ? 'is-merge-node' : ''}`,
                          }),
                      isMerge &&
                        h('circle', {
                          cx: node.x,
                          cy: node.y,
                          r: 9,
                          fill: 'none',
                          stroke: node.color,
                          strokeWidth: 1.2,
                          strokeDasharray: '3, 2',
                          className: 'dsh-gg-merge-ring',
                        }),
                      isHead &&
                        h('circle', {
                          cx: node.x,
                          cy: node.y,
                          r: 10,
                          fill: 'none',
                          stroke: node.color,
                          strokeWidth: 1.5,
                          className: 'dsh-gg-head-halo',
                        }),
                      isNewlyAdded &&
                        h('circle', {
                          cx: node.x,
                          cy: node.y,
                          r: 13,
                          fill: 'none',
                          stroke: '#34d399',
                          strokeWidth: 2,
                          className: 'dsh-gg-new-wave',
                        })
                    )
                  })
                ),

                // 2. Table Rows in Natural Document Flow (Guaranteed Visibility & Full Width)
                h(
                  'div',
                  { className: 'dsh-gg-rows-list' },
                  nodes.map((node, rIdx) => {
                    const isSelected = selectedNode?.hash === node.hash
                    const isHovered = hoveredNodeHash === node.hash
                    const isNewlyAdded = newHashes.has(node.hash)
                    const isMerge = node.isMerge

                    return h(
                      'div',
                      {
                        key: `row-${node.hash}`,
                        className: `dsh-gg-table-row ${isSelected ? 'is-selected' : ''} ${isHovered ? 'is-hovered' : ''} ${node.isWorkingTree ? 'is-working' : ''} ${isNewlyAdded ? 'is-new' : ''}`,
                        style: {
                          height: ROW_HEIGHT,
                          animationDelay: `${Math.min(rIdx * 15, 250)}ms`,
                        },
                        onClick: () => setSelectedNode(node),
                        onMouseEnter: () => setHoveredNodeHash(node.hash),
                        onMouseLeave: () => setHoveredNodeHash(null),
                      },
                      // Spacer matching Graph width
                      h('div', { className: 'dsh-gg-row-graph-spacer', style: { width: graphColWidth } }),

                      // Commit Message & Ref Badges
                      h(
                        'div',
                        { className: 'dsh-gg-row-msg' },
                        node.isWorkingTree &&
                          h('span', { className: 'dsh-gg-badge working' }, tr('graph.workingBadge')),
                        isNewlyAdded &&
                          h('span', { className: 'dsh-gg-badge new' }, tr('graph.newBadge')),
                        isMerge &&
                          h('span', { className: 'dsh-gg-badge merge' }, tr('graph.mergeBadge')),
                        node.refs &&
                          node.refs.map((r, i) =>
                            h(
                              'span',
                              { key: `ref-${i}`, className: `dsh-gg-badge ${r.type}` },
                              r.type === 'head' && h('span', { className: 'head-active-dot' }),
                              r.name
                            )
                          ),
                        h('span', { className: 'msg-text', title: node.subject }, node.subject)
                      ),

                      // Author
                      h(
                        'div',
                        { className: 'dsh-gg-row-author' },
                        h(
                          'span',
                          { className: 'author-avatar', style: { background: node.color } },
                          node.author ? node.author[0].toUpperCase() : 'U'
                        ),
                        h('span', { className: 'author-name', title: node.email ? `${node.author} <${node.email}>` : node.author }, node.author)
                      ),

                      // Date
                      h('div', { className: 'dsh-gg-row-date', title: node.date }, node.relativeTime),

                      // SHA
                      h(
                        'div',
                        { className: 'dsh-gg-row-sha' },
                        h(
                          'code',
                          {
                            onClick: (e) => {
                              e.stopPropagation()
                              copyText(node.hash)
                            },
                            title: 'Click to copy SHA',
                          },
                          node.shortHash
                        )
                      )
                    )
                  })
                )
              )
            ),

            // Right: Detail Panel / Drawer (Collapsible; gives full-width when unselected)
            selectedNode &&
              h(
                'div',
                { className: 'dsh-gg-detail-drawer' },
                h(
                  'div',
                  { className: 'dsh-gg-drawer-inner dsh-gg-drawer-animate' },
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

                    h(
                      'div',
                      { className: 'dsh-gg-meta-item full' },
                      h('div', { className: 'subject' }, selectedNode.subject)
                    ),

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

                    selectedNode.parents &&
                      selectedNode.parents.length > 0 &&
                      h(
                        'div',
                        { className: 'dsh-gg-meta-item' },
                        h('span', { className: 'label' }, tr('graph.parents')),
                        h(
                          'div',
                          { className: 'parents-wrap' },
                          selectedNode.parents.map((p) =>
                            h('code', { key: p, className: 'parent-sha', onClick: () => copyText(p) }, p.slice(0, 7))
                          )
                        )
                      ),

                    // Historical Commit Body & Changed Files
                    !selectedNode.isWorkingTree &&
                      commitDetails?.body &&
                      h(
                        'div',
                        { className: 'dsh-gg-commit-body-box' },
                        h('div', { className: 'label' }, tr('graph.commitBody')),
                        h('pre', { className: 'body-content' }, commitDetails.body)
                      ),

                    !selectedNode.isWorkingTree && commitDetailsLoading &&
                      h('div', { className: 'dsh-gg-commit-loading' }, tr('graph.loadingCommit')),

                    !selectedNode.isWorkingTree &&
                      commitDetails?.files &&
                      commitDetails.files.length > 0 &&
                      h(
                        'div',
                        { className: 'dsh-gg-files-box' },
                        h(
                          'div',
                          { className: 'dsh-gg-files-summary' },
                          h('h5', null, tr('graph.commitFiles', { n: commitDetails.files.length })),
                          commitDetails.stats &&
                            h(
                              'span',
                              { className: 'stat-chips' },
                              h('span', { className: 'ins' }, `+${commitDetails.stats.insertions}`),
                              h('span', { className: 'del' }, `-${commitDetails.stats.deletions}`)
                            )
                        ),
                        h(
                          'div',
                          { className: 'dsh-gg-files-scroll' },
                          commitDetails.files.map((file) =>
                            h(
                              'div',
                              { key: file.path, className: 'dsh-gg-file-row' },
                              h('span', { className: `tag ${file.status}` }, file.status),
                              h('span', { className: 'name', title: file.path }, file.path),
                              file.insertions !== undefined &&
                                h(
                                  'span',
                                  { className: 'file-diff-stat' },
                                  file.insertions > 0 && h('span', { className: 'ins' }, `+${file.insertions}`),
                                  file.deletions > 0 && h('span', { className: 'del' }, `-${file.deletions}`)
                                ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'copy-path-btn',
                                  onClick: () => copyText(file.path),
                                  title: tr('graph.copyPath'),
                                },
                                h(CopyIcon, { size: 11 })
                              )
                            )
                          )
                        )
                      ),

                    // Working Tree Accordions
                    selectedNode.isWorkingTree &&
                      h(
                        'div',
                        { className: 'dsh-gg-files-box' },
                        h('h5', null, tr('graph.filesChanged', { n: files.length })),

                        stagedFiles.length > 0 &&
                          h(
                            'div',
                            { className: 'dsh-gg-accordion-group' },
                            h(
                              'div',
                              {
                                className: 'dsh-gg-accordion-header staged',
                                onClick: () => toggleGroup('staged'),
                              },
                              h(ChevronDownIcon, {
                                size: 11,
                                className: `dsh-gg-chevron ${expandedGroups.staged ? 'open' : ''}`,
                              }),
                              h('span', { className: 'title' }, `Staged (${stagedFiles.length})`)
                            ),
                            expandedGroups.staged &&
                              h(
                                'div',
                                { className: 'dsh-gg-files-scroll' },
                                stagedFiles.map((file) =>
                                  h(
                                    'div',
                                    { key: file.path, className: 'dsh-gg-file-row' },
                                    h('span', { className: `tag ${file.status}` }, (file.xy || '..').trim()),
                                    h('span', { className: 'name', title: file.path }, file.path),
                                    h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'copy-path-btn',
                                        onClick: () => copyText(file.path),
                                        title: tr('graph.copyPath'),
                                      },
                                      h(CopyIcon, { size: 11 })
                                    )
                                  )
                                )
                              )
                          ),

                        unstagedFiles.length > 0 &&
                          h(
                            'div',
                            { className: 'dsh-gg-accordion-group' },
                            h(
                              'div',
                              {
                                className: 'dsh-gg-accordion-header unstaged',
                                onClick: () => toggleGroup('unstaged'),
                              },
                              h(ChevronDownIcon, {
                                size: 11,
                                className: `dsh-gg-chevron ${expandedGroups.unstaged ? 'open' : ''}`,
                              }),
                              h('span', { className: 'title' }, `Unstaged (${unstagedFiles.length})`)
                            ),
                            expandedGroups.unstaged &&
                              h(
                                'div',
                                { className: 'dsh-gg-files-scroll' },
                                unstagedFiles.map((file) =>
                                  h(
                                    'div',
                                    { key: file.path, className: 'dsh-gg-file-row' },
                                    h('span', { className: `tag ${file.status}` }, (file.xy || '..').trim()),
                                    h('span', { className: 'name', title: file.path }, file.path),
                                    h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'copy-path-btn',
                                        onClick: () => copyText(file.path),
                                        title: tr('graph.copyPath'),
                                      },
                                      h(CopyIcon, { size: 11 })
                                    )
                                  )
                                )
                              )
                          ),

                        untrackedFiles.length > 0 &&
                          h(
                            'div',
                            { className: 'dsh-gg-accordion-group' },
                            h(
                              'div',
                              {
                                className: 'dsh-gg-accordion-header untracked',
                                onClick: () => toggleGroup('untracked'),
                              },
                              h(ChevronDownIcon, {
                                size: 11,
                                className: `dsh-gg-chevron ${expandedGroups.untracked ? 'open' : ''}`,
                              }),
                              h('span', { className: 'title' }, `Untracked (${untrackedFiles.length})`)
                            ),
                            expandedGroups.untracked &&
                              h(
                                'div',
                                { className: 'dsh-gg-files-scroll' },
                                untrackedFiles.map((file) =>
                                  h(
                                    'div',
                                    { key: file.path, className: 'dsh-gg-file-row' },
                                    h('span', { className: `tag ${file.status}` }, (file.xy || '..').trim()),
                                    h('span', { className: 'name', title: file.path }, file.path),
                                    h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'copy-path-btn',
                                        onClick: () => copyText(file.path),
                                        title: tr('graph.copyPath'),
                                      },
                                      h(CopyIcon, { size: 11 })
                                    )
                                  )
                                )
                              )
                          )
                      ),

                    copyNotice && h('div', { className: 'dsh-gg-notice' }, copyNotice)
                  ),

                  h(
                    'div',
                    { className: 'dsh-gg-drawer-actions' },
                    selectedNode.isWorkingTree
                      ? [
                          h(
                            'button',
                            {
                              key: 'action-suggest',
                              type: 'button',
                              className: 'dsh-gg-btn prompt',
                              onClick: askAgentAboutWorking,
                            },
                            tr('graph.askAgentSuggest')
                          ),
                          h(
                            'button',
                            {
                              key: 'action-add',
                              type: 'button',
                              className: 'dsh-gg-btn secondary mini',
                              onClick: () => copyText('git add -A'),
                            },
                            'git add -A'
                          ),
                          h(
                            'button',
                            {
                              key: 'action-diff',
                              type: 'button',
                              className: 'dsh-gg-btn secondary mini',
                              onClick: () => copyText('git diff'),
                            },
                            'git diff'
                          ),
                        ]
                      : [
                          h(
                            'button',
                            {
                              key: 'action-review',
                              type: 'button',
                              className: 'dsh-gg-btn prompt',
                              onClick: () => askAgentAboutCommit(selectedNode),
                            },
                            tr('graph.askAgentReview')
                          ),
                          h(
                            'button',
                            {
                              key: 'action-sha',
                              type: 'button',
                              className: 'dsh-gg-btn secondary mini',
                              onClick: () => copyText(selectedNode.hash),
                            },
                            tr('dock.copySha')
                          ),
                          h(
                            'button',
                            {
                              key: 'action-checkout',
                              type: 'button',
                              className: 'dsh-gg-btn secondary mini',
                              onClick: () =>
                                copyText(
                                  `git checkout -b feature/from-${selectedNode.shortHash} ${selectedNode.shortHash}`
                                ),
                            },
                            tr('graph.copyCheckout')
                          ),
                          h(
                            'button',
                            {
                              key: 'action-cherry',
                              type: 'button',
                              className: 'dsh-gg-btn secondary mini',
                              onClick: () => copyText(`git cherry-pick ${selectedNode.shortHash}`),
                            },
                            tr('graph.copyCherryPick')
                          ),
                        ]
                  )
                )
              )
          ),

          // Scoped Stylesheet with Keyframe Animations & Table Styling
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
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-gg-btn primary',
                onClick: () => window.location.reload(),
                style: { marginTop: 12 },
              },
              '刷新页面'
            )
          ),
          h('style', null, CSS_STYLES)
        )
      }
    }

    // -------------------------------------------------------------------------
    // Scoped CSS Styles (Pixel-Perfect Alignment, Modern Table, Contrast & Flow)
    // -------------------------------------------------------------------------
    const CSS_STYLES = `
      /* Keyframe Animations */
      @keyframes dsh-gg-fade-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes dsh-gg-node-enter {
        from { opacity: 0; transform: scale(0.6); }
        to { opacity: 1; transform: scale(1); }
      }
      @keyframes dsh-gg-dash-flow {
        from { stroke-dashoffset: 20; }
        to { stroke-dashoffset: 0; }
      }
      @keyframes dsh-gg-aura-wave {
        0% { r: 5px; opacity: 0.85; stroke-width: 2px; }
        50% { r: 11px; opacity: 0.35; stroke-width: 1.5px; }
        100% { r: 15px; opacity: 0; stroke-width: 1px; }
      }
      @keyframes dsh-gg-pulse-amber {
        0%, 100% { filter: drop-shadow(0 0 2px rgba(245, 158, 11, 0.4)); }
        50% { filter: drop-shadow(0 0 8px rgba(245, 158, 11, 0.85)); }
      }
      @keyframes dsh-gg-merge-ring {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes dsh-gg-bounce-number {
        0% { transform: scale(1); }
        40% { transform: scale(1.3); }
        100% { transform: scale(1); }
      }
      @keyframes dsh-gg-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      @keyframes dsh-gg-flyout-in {
        from { opacity: 0; transform: translateY(8px) scale(0.96); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes dsh-gg-drawer-in {
        from { transform: translateX(20px); opacity: 0.8; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes dsh-gg-new-glow {
        0%, 100% { box-shadow: 0 0 4px rgba(52, 211, 153, 0.3); }
        50% { box-shadow: 0 0 12px rgba(52, 211, 153, 0.7); }
      }
      @keyframes dsh-gg-rock {
        0%, 100% { transform: rotate(0deg); }
        25% { transform: rotate(-8deg); }
        75% { transform: rotate(8deg); }
      }

      .dsh-gg-spin { animation: dsh-gg-spin 0.8s linear infinite; }
      .dsh-gg-spin-slow { animation: dsh-gg-spin 2s linear infinite; }

      /* Dock Styles */
      .dsh-gg-dock-wrap { position: relative; display: inline-flex; align-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .dsh-gg-dock-pill {
        display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
        border-radius: 13px; font-size: 12px; font-weight: 500; cursor: pointer;
        background: var(--dsw-alias-bg-layer-2, #262626); color: var(--dsw-alias-label-primary, #ededed);
        border: 1px solid var(--dsw-alias-border-l2, #3a3a3a);
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .dsh-gg-dock-pill:hover, .dsh-gg-dock-pill.is-active {
        background: var(--dsw-alias-interactive-bg-hover, #333);
        border-color: var(--dsw-alias-border-l1, #555);
        transform: translateY(-1px);
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      }
      .dsh-gg-dock-pill:hover .dsh-gg-dock-icon-rock {
        animation: dsh-gg-rock 0.4s ease;
      }
      .dsh-gg-dock-pill.has-pulse {
        border-color: #f59e0b;
        animation: dsh-gg-pulse-amber 1.2s ease-in-out infinite;
      }
      .dsh-gg-dock-pill.is-loading { opacity: 0.7; cursor: wait; }
      .dsh-gg-dock-pill.is-error { border-color: rgba(248, 113, 113, 0.4); color: #f87171; }
      .dsh-gg-dock-branch { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-gg-dock-badge { font-size: 11px; padding: 1px 5px; border-radius: 9px; transition: transform 0.2s ease; }
      .dsh-gg-dock-badge.dirty { background: rgba(245, 158, 11, 0.2); color: #f59e0b; font-weight: 600; }
      .dsh-gg-dock-badge.dirty.bounce { animation: dsh-gg-bounce-number 0.4s ease; }
      .dsh-gg-dock-badge.clean { color: #10b981; }
      .dsh-gg-dock-ahead { color: #38bdf8; font-size: 11px; font-weight: 600; }
      .dsh-gg-dock-behind { color: #f43f5e; font-size: 11px; font-weight: 600; }

      /* Dock Flyout */
      .dsh-gg-flyout {
        position: absolute; bottom: 32px; left: 0; width: 350px;
        background: var(--dsw-alias-bg-layer-1, #1e1e1e);
        border: 1px solid var(--dsw-alias-border-l1, #3a3a3a);
        border-radius: 10px; box-shadow: 0 10px 28px rgba(0,0,0,0.5);
        z-index: 1000; overflow: hidden; display: flex; flex-direction: column;
      }
      .dsh-gg-animate-in { animation: dsh-gg-flyout-in 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
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
        transition: all 0.15s ease;
      }
      .dsh-gg-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #333); color: var(--dsw-alias-label-primary, #fff); }
      .dsh-gg-flyout-body { padding: 12px; font-size: 12px; display: flex; flex-direction: column; gap: 10px; }
      .dsh-gg-flyout-status-row { display: flex; align-items: center; justify-content: space-between; }
      .dsh-gg-status-label { color: var(--dsw-alias-label-secondary, #888); }
      .dsh-gg-sha-tag { font-family: monospace; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; transition: background 0.15s ease; }
      .dsh-gg-sha-tag:hover { background: rgba(255,255,255,0.12); color: #38bdf8; }
      .dsh-gg-flyout-dirty-box { background: rgba(0,0,0,0.22); border-radius: 6px; padding: 8px; border: 1px solid rgba(245, 158, 11, 0.2); }
      .dsh-gg-dirty-counts { display: flex; gap: 8px; font-size: 11px; margin-bottom: 6px; }
      .dsh-gg-dirty-counts .staged { color: #10b981; font-weight: 500; }
      .dsh-gg-dirty-counts .unstaged { color: #f59e0b; font-weight: 500; }
      .dsh-gg-dirty-counts .untracked { color: #888; font-weight: 500; }
      .dsh-gg-file-list { list-style: none; margin: 0; padding: 0; max-height: 110px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .dsh-gg-file-item { display: flex; align-items: center; gap: 6px; font-size: 11px; font-family: monospace; }
      .dsh-gg-file-item .status-tag { padding: 1px 4px; border-radius: 3px; font-weight: bold; font-size: 10px; }
      .dsh-gg-file-item .status-tag.modified { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
      .dsh-gg-file-item .status-tag.added { background: rgba(16, 185, 129, 0.2); color: #10b981; }
      .dsh-gg-file-item .status-tag.untracked { background: rgba(156, 163, 175, 0.2); color: #9ca3af; }
      .dsh-gg-file-item .file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

      .dsh-gg-mini-timeline { border-top: 1px solid var(--dsw-alias-border-l2, #333); padding-top: 8px; }
      .dsh-gg-mini-timeline-title { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
      .dsh-gg-mini-timeline-list { display: flex; flex-direction: column; gap: 5px; }
      .dsh-gg-mini-item { display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer; padding: 3px 6px; border-radius: 4px; transition: background 0.15s ease; }
      .dsh-gg-mini-item:hover { background: rgba(255,255,255,0.06); }
      .dsh-gg-mini-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
      .dsh-gg-mini-sha { font-family: monospace; color: #888; font-size: 10px; }
      .dsh-gg-mini-subj { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; color: #ddd; }
      .dsh-gg-mini-time { color: #666; font-size: 10px; flex-shrink: 0; }

      .dsh-gg-copied-notice { color: #10b981; font-size: 11px; text-align: center; animation: dsh-gg-fade-in 0.2s ease; }
      .dsh-gg-flyout-footer { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l2, #333); background: var(--dsw-alias-bg-layer-2, #242424); }

      /* Full View Main Container */
      .dsh-gg-container {
        display: flex; flex-direction: column; height: 100%; width: 100%; min-height: 480px;
        background: var(--dsw-alias-bg-base, #131417); color: var(--dsw-alias-label-primary, #f1f5f9);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; position: relative;
      }

      /* Toolbar */
      .dsh-gg-toolbar {
        display: flex; align-items: center; justify-content: space-between; padding: 10px 16px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, #252830); background: var(--dsw-alias-bg-layer-1, #181a20);
        backdrop-filter: blur(12px); gap: 12px; flex-shrink: 0;
      }
      .dsh-gg-toolbar-left { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 600; }
      .dsh-gg-title { font-weight: 600; font-size: 13px; color: #f8fafc; }
      .dsh-gg-branch-chip {
        font-size: 11px; padding: 2px 8px; border-radius: 12px;
        background: rgba(56, 189, 248, 0.12); color: #38bdf8; font-weight: 500;
        border: 1px solid rgba(56, 189, 248, 0.25);
      }
      .dsh-gg-dirty-chip {
        font-size: 11px; padding: 2px 8px; border-radius: 12px;
        background: rgba(245, 158, 11, 0.15); color: #f59e0b; font-weight: 500;
        border: 1px solid rgba(245, 158, 11, 0.3); transition: all 0.3s ease;
      }
      .dsh-gg-dirty-chip.mini { font-size: 10px; padding: 1px 6px; }
      .dsh-gg-dirty-chip.pulse { animation: dsh-gg-bounce-number 0.4s ease; border-color: #f59e0b; }

      .dsh-gg-filter-tabs { display: inline-flex; background: rgba(0,0,0,0.3); padding: 2px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #333); margin-left: 6px; }
      .dsh-gg-filter-tab { background: transparent; border: none; color: #94a3b8; font-size: 11px; font-weight: 500; padding: 3px 9px; border-radius: 4px; cursor: pointer; transition: all 0.15s ease; }
      .dsh-gg-filter-tab:hover { color: #f1f5f9; }
      .dsh-gg-filter-tab.active { background: var(--dsw-alias-interactive-bg-hover, #2c3240); color: #38bdf8; font-weight: 600; }

      .dsh-gg-toolbar-right { display: flex; align-items: center; gap: 8px; }
      .dsh-gg-search-input {
        background: var(--dsw-alias-bg-layer-2, #20232b); border: 1px solid var(--dsw-alias-border-l2, #313542);
        border-radius: 6px; padding: 5px 10px; font-size: 12px; color: #fff; width: 230px; outline: none;
        transition: border-color 0.2s ease, width 0.2s ease;
      }
      .dsh-gg-search-input:focus { border-color: #38bdf8; width: 270px; }
      .dsh-gg-btn { padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid transparent; font-weight: 500; transition: all 0.15s ease; }
      .dsh-gg-btn.mini { padding: 3px 8px; font-size: 11px; }
      .dsh-gg-btn.primary { background: #2563eb; color: #fff; }
      .dsh-gg-btn.primary:hover { opacity: 0.9; transform: translateY(-1px); }
      .dsh-gg-btn.prompt {
        background: linear-gradient(135deg, #2563eb, #7c3aed); color: #fff; font-weight: 600;
        border: 1px solid rgba(167, 139, 250, 0.4); box-shadow: 0 2px 8px rgba(124, 58, 237, 0.25);
      }
      .dsh-gg-btn.prompt:hover { opacity: 0.95; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(124, 58, 237, 0.45); }
      .dsh-gg-btn.secondary { background: #2a2e39; color: #cbd5e1; border-color: #3f4453; }
      .dsh-gg-btn.secondary:hover { background: #383d4c; color: #fff; }
      .dsh-gg-btn.icon { background: #20232b; border: 1px solid #313542; color: #94a3b8; display: flex; align-items: center; justify-content: center; padding: 5px; }
      .dsh-gg-btn.icon:hover { color: #fff; border-color: #555; }

      /* Main Split Area */
      .dsh-gg-main { display: flex; flex: 1; overflow: hidden; position: relative; min-height: 400px; width: 100%; }

      /* Scrollable Table Area */
      .dsh-gg-table-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; position: relative; display: flex; flex-direction: column; width: 100%; }

      /* Table Header */
      .dsh-gg-table-header {
        display: flex; align-items: center; height: 30px; background: #181a20;
        border-bottom: 1px solid #252830; font-size: 11px; font-weight: 600; color: #94a3b8;
        padding-right: 16px; user-select: none; position: sticky; top: 0; z-index: 10;
      }
      .col-graph-hdr { flex-shrink: 0; padding-left: 14px; text-transform: uppercase; letter-spacing: 0.5px; }
      .col-msg-hdr { flex: 1; padding-left: 8px; }
      .col-author-hdr { width: 140px; text-align: left; padding-left: 8px; }
      .col-date-hdr { width: 85px; text-align: right; padding-right: 8px; }
      .col-sha-hdr { width: 75px; text-align: right; font-family: monospace; }

      /* Table Body */
      .dsh-gg-table-body { position: relative; width: 100%; display: flex; flex-direction: column; }

      /* SVG Canvas Overlay */
      .dsh-gg-svg-canvas { pointer-events: auto; }
      .dsh-gg-conn-path { transition: stroke-width 0.2s ease, opacity 0.2s ease; }
      .dsh-gg-conn-path.is-hover-highlight { filter: drop-shadow(0 0 5px currentColor); }
      .dsh-gg-merge-particle-stream { animation: dsh-gg-dash-flow 1.2s linear infinite; pointer-events: none; }
      .dsh-gg-node-dot { pointer-events: auto; transform-origin: center; animation: dsh-gg-node-enter 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) backwards; }
      .dsh-gg-node-dot:hover .dsh-gg-commit-circle, .dsh-gg-node-dot.is-hovered .dsh-gg-commit-circle {
        transform: scale(1.35); stroke: #fff; stroke-width: 2.5; filter: drop-shadow(0 0 6px currentColor);
      }
      .dsh-gg-commit-circle { transition: transform 0.2s ease, stroke-width 0.2s ease; transform-origin: center; }
      .dsh-gg-aura-wave { animation: dsh-gg-aura-wave 2s cubic-bezier(0.25, 1, 0.5, 1) infinite; }
      .dsh-gg-diamond-working { animation: dsh-gg-pulse-amber 2.5s ease-in-out infinite; }
      .dsh-gg-merge-ring { animation: dsh-gg-merge-ring 8s linear infinite; transform-origin: center; }
      .dsh-gg-head-halo { animation: dsh-gg-pulse-amber 3s ease-in-out infinite; }
      .dsh-gg-new-wave { animation: dsh-gg-aura-wave 1.5s ease-out 3; stroke: #34d399; }

      /* Rows List in Natural Document Flow */
      .dsh-gg-rows-list { display: flex; flex-direction: column; width: 100%; z-index: 2; pointer-events: auto; }
      .dsh-gg-table-row {
        display: flex; align-items: center; width: 100%; box-sizing: border-box;
        border-bottom: 1px solid rgba(255, 255, 255, 0.035); padding-right: 16px;
        cursor: pointer; font-size: 12px; transition: background 0.15s ease;
      }
      .dsh-gg-table-row:hover, .dsh-gg-table-row.is-hovered {
        background: rgba(255, 255, 255, 0.045);
      }
      .dsh-gg-table-row.is-selected {
        background: rgba(56, 189, 248, 0.12) !important;
        border-left: 3px solid #38bdf8;
      }
      .dsh-gg-table-row.is-working { font-style: italic; color: #f59e0b; }
      .dsh-gg-table-row.is-new { background: rgba(52, 211, 153, 0.08); animation: dsh-gg-new-glow 2s ease infinite; }

      .dsh-gg-row-graph-spacer { flex-shrink: 0; }
      .dsh-gg-row-msg { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding-left: 8px; overflow: hidden; }
      .msg-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: #e2e8f0; }
      .dsh-gg-table-row.is-selected .msg-text { color: #fff; font-weight: 600; }

      /* Badges & Pills */
      .dsh-gg-badge {
        font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px;
        font-family: monospace; letter-spacing: 0.3px; flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px;
      }
      .dsh-gg-badge.head { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
      .dsh-gg-badge.working { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
      .dsh-gg-badge.merge { background: linear-gradient(135deg, rgba(168, 85, 247, 0.25), rgba(236, 72, 153, 0.25)); color: #f472b6; border: 1px solid rgba(244, 114, 182, 0.4); }
      .dsh-gg-badge.new { background: rgba(52, 211, 153, 0.25); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.45); animation: dsh-gg-bounce-number 0.5s ease; }
      .dsh-gg-badge.branch { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
      .dsh-gg-badge.remote { background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); }
      .dsh-gg-badge.tag { background: rgba(234, 179, 8, 0.15); color: #fbbf24; border: 1px solid rgba(234, 179, 8, 0.3); }
      .head-active-dot { width: 5px; height: 5px; border-radius: 50%; background: #f87171; animation: dsh-gg-bounce-number 1s infinite; }

      .dsh-gg-row-author { width: 140px; flex-shrink: 0; display: flex; align-items: center; gap: 6px; padding-left: 8px; overflow: hidden; }
      .author-avatar { width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold; color: #fff; flex-shrink: 0; }
      .author-name { color: #94a3b8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      .dsh-gg-row-date { width: 85px; flex-shrink: 0; text-align: right; color: #64748b; font-size: 11px; padding-right: 8px; }

      .dsh-gg-row-sha { width: 75px; flex-shrink: 0; text-align: right; }
      .dsh-gg-row-sha code {
        font-family: monospace; font-size: 11px; color: #94a3b8; background: rgba(255,255,255,0.05);
        padding: 2px 5px; border-radius: 4px; transition: all 0.15s ease;
      }
      .dsh-gg-row-sha code:hover { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }

      /* Details Drawer */
      .dsh-gg-detail-drawer {
        width: 330px; border-left: 1px solid #252830; background: #16181f;
        display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0;
      }
      .dsh-gg-drawer-inner { display: flex; flex-direction: column; height: 100%; }
      .dsh-gg-drawer-animate { animation: dsh-gg-drawer-in 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
      .dsh-gg-drawer-header {
        display: flex; align-items: center; justify-content: space-between; padding: 12px 14px;
        border-bottom: 1px solid #252830; background: #1c1f27;
      }
      .dsh-gg-drawer-header h4 { margin: 0; font-size: 13px; font-weight: 600; color: #f8fafc; }
      .dsh-gg-drawer-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; flex: 1; font-size: 12px; }
      .dsh-gg-meta-item { display: flex; gap: 8px; font-size: 12px; }
      .dsh-gg-meta-item .label { color: #94a3b8; width: 60px; flex-shrink: 0; }
      .dsh-gg-meta-item .val { color: #f1f5f9; }
      .dsh-gg-meta-item .sha { font-family: monospace; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; word-break: break-all; transition: background 0.15s ease; }
      .dsh-gg-meta-item .sha:hover { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
      .dsh-gg-meta-item.full .subject { font-size: 13px; font-weight: 500; color: #fff; line-height: 1.4; }
      .parents-wrap { display: flex; gap: 6px; flex-wrap: wrap; }
      .parent-sha { font-family: monospace; background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; cursor: pointer; transition: background 0.15s ease; }
      .parent-sha:hover { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }

      /* File Accordion in Drawer */
      .dsh-gg-files-box { margin-top: 6px; border-top: 1px solid #252830; padding-top: 8px; }
      .dsh-gg-files-box h5 { margin: 0 0 8px 0; font-size: 12px; font-weight: 600; }
      .dsh-gg-accordion-group { margin-bottom: 8px; border: 1px solid #252830; border-radius: 6px; overflow: hidden; }
      .dsh-gg-accordion-header {
        display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer; font-size: 11px; font-weight: 600;
        background: #1c1f27; user-select: none; transition: background 0.15s ease;
      }
      .dsh-gg-accordion-header:hover { background: #252830; }
      .dsh-gg-accordion-header.staged .title { color: #10b981; }
      .dsh-gg-accordion-header.unstaged .title { color: #f59e0b; }
      .dsh-gg-accordion-header.untracked .title { color: #888; }
      .dsh-gg-chevron { transition: transform 0.2s ease; }
      .dsh-gg-chevron.open { transform: rotate(180deg); }

      .dsh-gg-files-scroll { max-height: 160px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 4px; }
      .dsh-gg-file-row { display: flex; align-items: center; gap: 6px; font-size: 11px; font-family: monospace; padding: 2px 4px; border-radius: 4px; transition: background 0.15s ease; }
      .dsh-gg-file-row:hover { background: rgba(255,255,255,0.05); }
      .dsh-gg-file-row .tag { font-weight: bold; padding: 1px 4px; border-radius: 3px; font-size: 10px; }
      .dsh-gg-file-row .tag.modified { color: #f59e0b; background: rgba(245, 158, 11, 0.15); }
      .dsh-gg-file-row .tag.added { color: #10b981; background: rgba(16, 185, 129, 0.15); }
      .dsh-gg-file-row .tag.deleted { color: #ef4444; background: rgba(239, 68, 68, 0.15); }
      .dsh-gg-file-row .tag.untracked { color: #9ca3af; background: rgba(156, 163, 175, 0.15); }
      .dsh-gg-file-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .dsh-gg-file-row .copy-path-btn { background: transparent; border: none; cursor: pointer; color: #666; padding: 2px; border-radius: 3px; display: none; }
      .dsh-gg-file-row:hover .copy-path-btn { display: flex; color: #aaa; }
      .dsh-gg-file-row .copy-path-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }

      .dsh-gg-commit-body-box {
        background: rgba(0,0,0,0.25); border-radius: 6px; padding: 8px 10px; border: 1px solid #252830;
      }
      .dsh-gg-commit-body-box .label { color: #94a3b8; font-size: 11px; font-weight: 600; margin-bottom: 4px; }
      .dsh-gg-commit-body-box .body-content {
        margin: 0; font-size: 11px; color: #cbd5e1; font-family: -apple-system, sans-serif;
        white-space: pre-wrap; line-height: 1.45; max-height: 120px; overflow-y: auto;
      }
      .dsh-gg-files-summary { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
      .dsh-gg-files-summary .stat-chips { font-size: 10px; font-family: monospace; display: flex; gap: 6px; }
      .dsh-gg-files-summary .stat-chips .ins { color: #34d399; font-weight: bold; }
      .dsh-gg-files-summary .stat-chips .del { color: #f87171; font-weight: bold; }
      .file-diff-stat { display: flex; gap: 4px; font-size: 10px; font-family: monospace; margin-right: 6px; }
      .file-diff-stat .ins { color: #34d399; }
      .file-diff-stat .del { color: #f87171; }
      .dsh-gg-commit-loading { color: #888; font-size: 11px; padding: 8px 0; text-align: center; font-style: italic; }

      .dsh-gg-notice { color: #10b981; font-size: 11px; text-align: center; animation: dsh-gg-fade-in 0.2s ease; }
      .dsh-gg-drawer-actions { padding: 12px; border-top: 1px solid #252830; display: flex; flex-wrap: wrap; gap: 6px; }
      .dsh-gg-view-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 320px; color: #888; font-size: 13px; }
      .dsh-gg-empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 360px; color: #777; gap: 10px; padding: 24px; text-align: center; }
      .dsh-gg-empty-state.is-error h3 { color: #f87171; }
    `

    // -------------------------------------------------------------------------
    // Plugin Export Factory
    // -------------------------------------------------------------------------
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
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
