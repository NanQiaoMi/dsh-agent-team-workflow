window.__ModuleLoader__.load({
  id: '@local/dsh-agent-team-workflow',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin; also the View tab's copy seat. */
    const NS = 'agent-team-workflow'
    /** Authenticated Connection Fetch route served by the Host half (docs/09 §2). */
    const SNAPSHOT_PATH = '/api/agent-team-workflow.snapshot'
    /** Member panel route (docs/19 §5): GET member view, POST a message. */
    const MEMBER_PATH = '/api/agent-team-workflow.member'
    /** Board refresh cadence; a hidden document skips every tick. */
    const POLL_MS = 1200
    /** Recent events shown by the event stream panel. */
    const EVENTS_LIMIT = 30
    /** Snapshot caps mirrored from the Host contract (defensive; the Host caps too). */
    const MAX_MEMBERS = 16
    const MAX_ITEMS = 64
    const MAX_RECORDS = 12
    /** Peer-collaboration caps mirrored from the Host contract (docs/12 §5). */
    const CHANNEL_LIMIT = 60
    const PROPOSAL_LIMIT = 32
    /** Peer↔peer links drawn by the topology (docs/16 §3 noise budget). */
    const PEER_EDGE_LIMIT = 8
    /** Channel bodies clamp to four lines; longer ones get an expand toggle. */
    const CHANNEL_CLAMP_LINES = 4
    /** Visual cells per channel line (CJK counts double), used without layout. */
    const CHANNEL_LINE_CELLS = 84

    // ---------------------------------------------------------------------
    // Copy (zh is the key-set source of truth; the contract test enforces parity)
    // ---------------------------------------------------------------------

    const zh = {
      'view.label': '团队看板',
      'board.title': 'Agent Team 实时看板',
      'header.run': '运行 {id}',
      'header.noRun': '当前会话还没有 run',
      'header.progress': '已批准 {done}/{total}',
      'header.updated': '更新于 {when}',
      'header.never': '尚未刷新',
      'header.refresh': '刷新',
      'header.pause': '暂停',
      'header.resume': '继续',
      'header.members': '参与者 {n}',
      'header.offline': '离线，显示上一次成功的数据',
      'header.paused': '轮询已暂停',
      'phase.planned': '已计划',
      'phase.reviewing': '评审中',
      'phase.converged': '已收敛',
      'phase.finalized': '已收尾',
      'phase.aborted': '已中止',
      'phase.unknown': '未知阶段',
      'status.pending': '待执行',
      'status.running': '执行中',
      'status.in_review': '评审中',
      'status.changes_requested': '待修改',
      'status.approved': '已批准',
      'status.escalated': '已升级',
      'status.unknown': '未知状态',
      'member.status.running': '运行中',
      'member.status.inactive': '空闲',
      'member.status.provisioning': '初始化中',
      'member.status.failed': '失败',
      'member.context.fresh': 'fresh',
      'member.context.fork': 'fork',
      'flow.title': '执行流程图',
      'flow.hint': '点击卡片查看 DoD、报告与评审记录',
      'flow.wave': '第 {n} 波',
      'flow.waveUnknown': '未分层',
      'flow.owner': '执行者 {name}',
      'flow.round': '评审 {submitted}/{max}',
      'flow.empty': '还没有工作项',
      'topology.title': '协作拓扑',
      'topology.lead': 'Lead',
      'topology.members': '成员',
      'topology.items': '工作项',
      'topology.empty': '还没有成员或工作项',
      'topology.leadEdge': 'Lead → 成员',
      'topology.ownsEdge': '成员 → 工作项',
      'topology.reviewsEdge': '评审 → 被审项',
      'events.title': '事件流',
      'events.count': '最近 {n} 条',
      'events.empty': '还没有事件',
      'events.filter.all': '全部',
      'events.filter.review': '评审',
      'events.filter.escalation': '升级',
      'events.filter.repair': '修复',
      'events.filter.report': '交付',
      'events.actor': '由 {name}',
      'time.secondsAgo': '{n} 秒前',
      'time.minutesAgo': '{n} 分钟前',
      'time.secondsLeft': '{n} 秒后',
      'time.minutesLeft': '{n} 分钟后',
      'time.hoursLeft': '{n} 小时后',
      'gate.title': '门禁',
      'gate.none': '未评估：Lead 还没有运行 team_flow_gate',
      'gate.pass': '通过',
      'gate.fail': '未通过',
      'gate.overridden': '已覆盖',
      'gate.waived': '豁免 {n}',
      'gate.failures': '失败',
      'gate.warnings': '警告',
      'gate.teamFailures': '团队级失败',
      'gate.blockingEscalations': '阻塞升级',
      'gate.reportPath': '报告路径',
      'gate.statePath': '黑板路径',
      'gate.noReportPath': '尚未生成报告文件',
      'gate.copy': '复制',
      'gate.copied': '已复制',
      'gate.evaluatedAt': '评估于 {when}',
      'escalations.title': '升级',
      'escalations.empty': '没有升级记录',
      'escalations.blocking': '阻塞',
      'escalations.resolved': '已解决',
      'escalations.unresolved': '未解决',
      'escalations.resolution': '裁决',
      'escalations.by': '由 {name}',
      'escalations.item': '关联 {id}',
      'escalations.kind.blocker': '阻塞',
      'escalations.kind.conflict': '需求冲突',
      'escalations.kind.scope_change': '范围变更',
      'escalations.kind.decision': '待决策',
      'escalations.kind.arbitration': '仲裁',
      'escalations.kind.unknown': '其他',
      'empty.title': '看板为空',
      'empty.hint': '让 Lead 运行 team_flow_plan 建立 run；看板每 1.2 秒自动刷新。',
      'empty.boardMissing': '还没有找到黑板文件，run 建立后会自动出现在这里。',
      'empty.teamTitle': '当前团队成员',
      'diagnostics.title': '数据提示',
      'error.title': '看板渲染失败',
      'error.hint': '数据可能不完整，请刷新或稍后重试。',
      'error.retry': '重试',
      'error.noSession': '缺少会话标识，无法加载看板。',
      'error.boundary': '看板组件崩溃，已隐藏内容。',
      'drawer.title': '工作项详情',
      'drawer.close': '关闭',
      'drawer.subject': '标题',
      'drawer.owner': '执行者',
      'drawer.role': '角色',
      'drawer.status': '状态',
      'drawer.wave': '波次',
      'drawer.reviewers': '评审人',
      'drawer.writeScopes': '写范围',
      'drawer.blockedBy': '依赖',
      'drawer.dod': '完成定义（DoD）',
      'drawer.report': '交付报告',
      'drawer.noReport': '还没有提交报告',
      'drawer.files': '变更文件',
      'drawer.commands': '验证命令',
      'drawer.exitCode': '退出码',
      'drawer.evidence': '证据',
      'drawer.risks': '风险',
      'drawer.openQuestions': '未决问题',
      'drawer.deviation': '偏差说明',
      'drawer.submittedAt': '提交于 {when}',
      'drawer.reviews': '评审记录',
      'drawer.rounds': '已交 {submitted} 轮 / 重做 {rework} / 上限 {max}',
      'drawer.pendingReviewer': '待评审：{name}',
      'drawer.verdict': '结论',
      'drawer.summary': '摘要',
      'drawer.findings': '发现',
      'drawer.noFindings': '没有发现',
      'drawer.finding': '发现 {id}',
      'drawer.severity': '级别',
      'drawer.resolution': '处置',
      'drawer.resolution.accepted_by_reviewer': '已由评审确认',
      'drawer.resolution.fixed': '已修复',
      'drawer.resolution.rebut': '已反驳',
      'drawer.resolution.accepted_risk': '接受风险',
      'drawer.repairLog': '卡点修复记录',
      'drawer.noRepairLog': '没有修复记录',
      'drawer.repair.at': '时间',
      'drawer.repair.action': '动作',
      'drawer.repair.reason': '原因',
      'drawer.repair.owner': '负责人',
      'drawer.override': '判定覆盖',
      'drawer.task': '任务 {id}@{revision}',
      'drawer.noTask': '没有关联任务',
      'drawer.none': '无',
      'common.none': '无',
      'common.unknown': '未知',
      'channel.title': '协作频道',
      'channel.count': '最近 {n} 条',
      'channel.empty': '暂无协作消息',
      'channel.expand': '展开',
      'channel.collapse': '收起',
      'channel.replyTo': '回复 {id}',
      'channel.filter.all': '全部',
      'channel.filter.question': '提问',
      'channel.filter.answer': '回答',
      'channel.filter.proposal': '提案',
      'channel.filter.handoff': '交接',
      'channel.filter.status': '状态',
      'channel.kind.note': '备注',
      'channel.kind.question': '提问',
      'channel.kind.answer': '回答',
      'channel.kind.proposal': '提案',
      'channel.kind.objection': '反对',
      'channel.kind.handoff': '交接',
      'channel.kind.ack': '收到',
      'channel.kind.status': '状态',
      'channel.kind.unknown': '消息',
      'proposal.title': '提案与投票',
      'proposal.count': '{n} 条',
      'proposal.empty': '暂无提案',
      'proposal.by': '由 {name} 发起',
      'proposal.blocking': '阻断',
      'proposal.affected': '受影响 {affected} 人 · 已投 {total} 票',
      'proposal.resolution': '裁决',
      'proposal.noVotes': '还没有人投票',
      'proposal.deadline': '截止 {when}',
      'proposal.deadlineExpired': '已截止（{when}）',
      'proposal.autoResolved': '超时自动裁决',
      'proposal.overdue': '已截止·待裁决',
      'proposal.quorum': '法定 {n}',
      'proposal.vote.yes': '同意',
      'proposal.vote.no': '反对',
      'proposal.vote.abstain': '弃权',
      'proposal.kind.dod': '完成定义',
      'proposal.kind.scope': '范围',
      'proposal.kind.replan': '重规划',
      'proposal.kind.review_policy': '评审策略',
      'proposal.kind.handoff': '交接',
      'proposal.kind.unknown': '议题',
      'proposal.status.open': '进行中',
      'proposal.status.accepted': '已通过',
      'proposal.status.rejected': '已否决',
      'proposal.status.withdrawn': '已撤回',
      'proposal.status.escalated': '已升级',
      'proposal.status.unknown': '未知',
      'collab.fromTo': '{from} → {to}',
      'collab.team': '全队',
      'topology.peerEdge': '同伴 ↔ 同伴',
      'flow.claimed': '认领 {name}',
      'flow.openAssignment': '待认领',
      'flow.openQueue': '待认领队列',
      'flow.proposalsOpen': '提案中 {n}',
      'flow.memberItem': '自建',
      'flow.createdBy': '自建者 {name}',
      'drawer.assignment': '分派方式',
      'drawer.assignment.lead': 'Lead 指派',
      'drawer.assignment.open': '开放队列',
      'drawer.claim': '认领',
      'drawer.collab': '协作记录',
      'drawer.noCollab': '暂无协作记录',
      'drawer.thread': '讨论串',
      'drawer.reviewRequests': '评审邀请',
      'drawer.review.openInvite': '开放邀请',
      'drawer.review.status.open': '待回应',
      'drawer.review.status.accepted': '已接受',
      'drawer.review.status.declined': '已拒绝',
      'drawer.handoffs': '任务交接',
      'drawer.handoff.reason': '原因',
      'drawer.handoff.status.offered': '待回应',
      'drawer.handoff.status.accepted': '已接受',
      'drawer.handoff.status.declined': '已拒绝',
      'drawer.relatedProposals': '相关提案',
      'drawer.origin': '来源',
      'drawer.originPlan': '计划',
      'topology.idle': '空闲 {n} 人',
      'topology.idleNames': '空闲成员：{names}',
      'git.title': 'Git / PR',
      'git.branch': '分支 {branch}',
      'git.branchLabel': '分支',
      'git.base': '基线分支',
      'git.sha': '提交',
      'git.remote': '远程',
      'git.pushState': '推送',
      'git.pushed': '已推送',
      'git.notPushed': '未推送',
      'git.verifyState': '验证',
      'git.verifyOk': '已验证',
      'git.verifyFail': '验证失败',
      'git.verifyMissing': '未验证',
      'git.pr': 'PR #{number}',
      'git.prUnknown': 'PR',
      'git.prManual': 'PR（手动）',
      'git.merged': '已合并',
      'git.mergedAt': '合并时间',
      'git.prReview': 'PR 评审',
      'member.title': '成员',
      'member.close': '关闭',
      'member.loading': '加载中…',
      'member.unknown': '未知成员',
      'member.fetchError': '成员详情加载失败',
      'member.status': '状态',
      'member.role': '角色',
      'member.context': '上下文',
      'member.items': '当前工作项',
      'member.noItems': '暂无当前工作项',
      'member.activity': '最近活动',
      'member.noActivity': '暂无活动',
      'member.channel': '相关频道',
      'member.noChannel': '暂无相关消息',
      'member.roleDefinition': '角色定义',
      'member.noRoleDefinition': '无角色定义',
      'member.provider': '提供方',
      'member.prompt': '提示词',
      'member.plan': '计划',
      'member.noPlan': '无计划',
      'member.stopState': '停止状态',
      'member.noStop': '无停止请求',
      'member.message': '消息',
      'member.messagePlaceholder': '输入要发送给该成员的消息…',
      'member.send': '发消息',
      'member.sending': '发送中…',
      'member.sent': '已发送',
      'member.error': '发送失败：{message}',
      'member.emptyMessage': '消息不能为空',
      'member.stop.pending': '待回应',
      'member.stop.accepted': '已接受',
      'member.stop.rejected': '已拒绝',
      'member.stop.interrupted': '已中断',
      'plan.title': '计划',
      'plan.status': '状态',
      'plan.pending': '计划待批',
      'plan.approved': '计划已批',
      'plan.rejected': '计划被拒',
      'plan.steps': '步骤',
      'plan.files': '文件',
      'plan.risks': '风险',
      'plan.decidedBy': '决定人',
      'plan.reason': '理由',
      'member.transcript': '对话',
      'member.transcriptEmpty': '暂无对话记录',
      'member.transcriptUnavailable': '该 Host 未暴露会话日志',
      'member.transcriptTruncated': '仅显示最近 {n} 条',
      'member.role.user': '用户',
      'member.role.assistant': '助手',
      'member.role.system': '系统',
      'member.role.tool': '工具',
      'member.transcriptExpand': '展开',
      'member.transcriptCollapse': '收起',
      'board.usage': '用量',
      'board.usageEmpty': '尚无用量数据（gate 执行后采集）',
      'board.usageTotals': '合计',
      'board.usageCapturedAt': '采集于 {time}',
      'board.usageInput': '输入',
      'board.usageOutput': '输出',
      'board.usageCacheRead': '缓存读',
      'board.usageCacheWrite': '缓存写',
    }

    const en = {
      'view.label': 'Team board',
      'board.title': 'Live Agent Team board',
      'header.run': 'Run {id}',
      'header.noRun': 'This conversation has no run yet',
      'header.progress': '{done}/{total} approved',
      'header.updated': 'updated {when}',
      'header.never': 'not refreshed yet',
      'header.refresh': 'Refresh',
      'header.pause': 'Pause',
      'header.resume': 'Resume',
      'header.members': '{n} member(s)',
      'header.offline': 'Offline, showing the last successful snapshot',
      'header.paused': 'Polling paused',
      'phase.planned': 'planned',
      'phase.reviewing': 'reviewing',
      'phase.converged': 'converged',
      'phase.finalized': 'finalized',
      'phase.aborted': 'aborted',
      'phase.unknown': 'unknown phase',
      'status.pending': 'pending',
      'status.running': 'running',
      'status.in_review': 'in review',
      'status.changes_requested': 'changes requested',
      'status.approved': 'approved',
      'status.escalated': 'escalated',
      'status.unknown': 'unknown status',
      'member.status.running': 'running',
      'member.status.inactive': 'idle',
      'member.status.provisioning': 'starting',
      'member.status.failed': 'failed',
      'member.context.fresh': 'fresh',
      'member.context.fork': 'fork',
      'flow.title': 'Execution flow',
      'flow.hint': 'Click a card for its DoD, report, and review records',
      'flow.wave': 'Wave {n}',
      'flow.waveUnknown': 'unscheduled',
      'flow.owner': 'owner {name}',
      'flow.round': 'round {submitted}/{max}',
      'flow.empty': 'No work items yet',
      'topology.title': 'Collaboration topology',
      'topology.lead': 'Lead',
      'topology.members': 'members',
      'topology.items': 'items',
      'topology.empty': 'No members or work items yet',
      'topology.leadEdge': 'Lead → member',
      'topology.ownsEdge': 'member → item',
      'topology.reviewsEdge': 'reviewer → item',
      'events.title': 'Event stream',
      'events.count': 'latest {n}',
      'events.empty': 'No events yet',
      'events.filter.all': 'all',
      'events.filter.review': 'review',
      'events.filter.escalation': 'escalation',
      'events.filter.repair': 'repair',
      'events.filter.report': 'report',
      'events.actor': 'by {name}',
      'time.secondsAgo': '{n}s ago',
      'time.minutesAgo': '{n}m ago',
      'time.secondsLeft': 'in {n}s',
      'time.minutesLeft': 'in {n} min',
      'time.hoursLeft': 'in {n}h',
      'gate.title': 'Quality gate',
      'gate.none': 'Not evaluated: the Lead has not run team_flow_gate yet',
      'gate.pass': 'pass',
      'gate.fail': 'fail',
      'gate.overridden': 'overridden',
      'gate.waived': 'waived {n}',
      'gate.failures': 'failures',
      'gate.warnings': 'warnings',
      'gate.teamFailures': 'team-level failures',
      'gate.blockingEscalations': 'blocking escalations',
      'gate.reportPath': 'report path',
      'gate.statePath': 'board path',
      'gate.noReportPath': 'No report file written yet',
      'gate.copy': 'copy',
      'gate.copied': 'copied',
      'gate.evaluatedAt': 'evaluated {when}',
      'escalations.title': 'Escalations',
      'escalations.empty': 'No escalations',
      'escalations.blocking': 'blocking',
      'escalations.resolved': 'resolved',
      'escalations.unresolved': 'unresolved',
      'escalations.resolution': 'resolution',
      'escalations.by': 'by {name}',
      'escalations.item': 'item {id}',
      'escalations.kind.blocker': 'blocker',
      'escalations.kind.conflict': 'conflict',
      'escalations.kind.scope_change': 'scope change',
      'escalations.kind.decision': 'decision',
      'escalations.kind.arbitration': 'arbitration',
      'escalations.kind.unknown': 'other',
      'empty.title': 'Board is empty',
      'empty.hint': 'Ask the Lead to run team_flow_plan; the board refreshes every 1.2s.',
      'empty.boardMissing': 'No board file found yet; it appears here once a run is planned.',
      'empty.teamTitle': 'Current team members',
      'diagnostics.title': 'Data notes',
      'error.title': 'Board failed to render',
      'error.hint': 'The data may be incomplete; refresh or retry shortly.',
      'error.retry': 'Retry',
      'error.noSession': 'No session id: the board cannot load.',
      'error.boundary': 'The board component crashed and its content was hidden.',
      'drawer.title': 'Work item detail',
      'drawer.close': 'Close',
      'drawer.subject': 'subject',
      'drawer.owner': 'owner',
      'drawer.role': 'role',
      'drawer.status': 'status',
      'drawer.wave': 'wave',
      'drawer.reviewers': 'reviewers',
      'drawer.writeScopes': 'write scopes',
      'drawer.blockedBy': 'blocked by',
      'drawer.dod': 'Definition of done',
      'drawer.report': 'Work report',
      'drawer.noReport': 'No report submitted yet',
      'drawer.files': 'changed files',
      'drawer.commands': 'verification commands',
      'drawer.exitCode': 'exit',
      'drawer.evidence': 'evidence',
      'drawer.risks': 'risks',
      'drawer.openQuestions': 'open questions',
      'drawer.deviation': 'deviation',
      'drawer.submittedAt': 'submitted {when}',
      'drawer.reviews': 'Review records',
      'drawer.rounds': '{submitted} submitted / {rework} rework / max {max}',
      'drawer.pendingReviewer': 'awaiting {name}',
      'drawer.verdict': 'verdict',
      'drawer.summary': 'summary',
      'drawer.findings': 'findings',
      'drawer.noFindings': 'No findings',
      'drawer.finding': 'finding {id}',
      'drawer.severity': 'severity',
      'drawer.resolution': 'resolution',
      'drawer.resolution.accepted_by_reviewer': 'accepted by reviewer',
      'drawer.resolution.fixed': 'fixed',
      'drawer.resolution.rebut': 'rebutted',
      'drawer.resolution.accepted_risk': 'accepted risk',
      'drawer.repairLog': 'Repair log',
      'drawer.noRepairLog': 'No repair entries',
      'drawer.repair.at': 'at',
      'drawer.repair.action': 'action',
      'drawer.repair.reason': 'reason',
      'drawer.repair.owner': 'owner',
      'drawer.override': 'gate override',
      'drawer.task': 'task {id}@{revision}',
      'drawer.noTask': 'No backing task',
      'drawer.none': 'none',
      'common.none': 'none',
      'common.unknown': 'unknown',
      'channel.title': 'Collaboration channel',
      'channel.count': 'latest {n}',
      'channel.empty': 'No collaboration messages yet',
      'channel.expand': 'expand',
      'channel.collapse': 'collapse',
      'channel.replyTo': 'reply to {id}',
      'channel.filter.all': 'all',
      'channel.filter.question': 'question',
      'channel.filter.answer': 'answer',
      'channel.filter.proposal': 'proposal',
      'channel.filter.handoff': 'handoff',
      'channel.filter.status': 'status',
      'channel.kind.note': 'note',
      'channel.kind.question': 'question',
      'channel.kind.answer': 'answer',
      'channel.kind.proposal': 'proposal',
      'channel.kind.objection': 'objection',
      'channel.kind.handoff': 'handoff',
      'channel.kind.ack': 'ack',
      'channel.kind.status': 'status',
      'channel.kind.unknown': 'message',
      'proposal.title': 'Proposals and votes',
      'proposal.count': '{n} item(s)',
      'proposal.empty': 'No proposals yet',
      'proposal.by': 'by {name}',
      'proposal.blocking': 'blocking',
      'proposal.affected': 'affected {affected} · votes {total}',
      'proposal.resolution': 'resolution',
      'proposal.noVotes': 'No votes yet',
      'proposal.deadline': 'due {when}',
      'proposal.deadlineExpired': 'expired ({when})',
      'proposal.autoResolved': 'auto-resolved',
      'proposal.overdue': 'overdue · awaiting decision',
      'proposal.quorum': 'quorum {n}',
      'proposal.vote.yes': 'yes',
      'proposal.vote.no': 'no',
      'proposal.vote.abstain': 'abstain',
      'proposal.kind.dod': 'DoD',
      'proposal.kind.scope': 'scope',
      'proposal.kind.replan': 'replan',
      'proposal.kind.review_policy': 'review policy',
      'proposal.kind.handoff': 'handoff',
      'proposal.kind.unknown': 'topic',
      'proposal.status.open': 'open',
      'proposal.status.accepted': 'accepted',
      'proposal.status.rejected': 'rejected',
      'proposal.status.withdrawn': 'withdrawn',
      'proposal.status.escalated': 'escalated',
      'proposal.status.unknown': 'unknown',
      'collab.fromTo': '{from} → {to}',
      'collab.team': 'team',
      'topology.peerEdge': 'peer ↔ peer',
      'flow.claimed': 'claimed by {name}',
      'flow.openAssignment': 'unclaimed',
      'flow.openQueue': 'Open queue',
      'flow.proposalsOpen': '{n} proposal(s)',
      'flow.memberItem': 'member',
      'flow.createdBy': 'created by {name}',
      'drawer.assignment': 'assignment',
      'drawer.assignment.lead': 'assigned by Lead',
      'drawer.assignment.open': 'open queue',
      'drawer.claim': 'claim',
      'drawer.collab': 'Collaboration record',
      'drawer.noCollab': 'No collaboration records',
      'drawer.thread': 'thread',
      'drawer.reviewRequests': 'review requests',
      'drawer.review.openInvite': 'open invite',
      'drawer.review.status.open': 'open',
      'drawer.review.status.accepted': 'accepted',
      'drawer.review.status.declined': 'declined',
      'drawer.handoffs': 'handoffs',
      'drawer.handoff.reason': 'reason',
      'drawer.handoff.status.offered': 'offered',
      'drawer.handoff.status.accepted': 'accepted',
      'drawer.handoff.status.declined': 'declined',
      'drawer.relatedProposals': 'related proposals',
      'drawer.origin': 'origin',
      'drawer.originPlan': 'planned',
      'topology.idle': '{n} idle',
      'topology.idleNames': 'idle members: {names}',
      'git.title': 'Git / PR',
      'git.branch': 'branch {branch}',
      'git.branchLabel': 'branch',
      'git.base': 'base',
      'git.sha': 'commit',
      'git.remote': 'remote',
      'git.pushState': 'push',
      'git.pushed': 'pushed',
      'git.notPushed': 'not pushed',
      'git.verifyState': 'verify',
      'git.verifyOk': 'verified',
      'git.verifyFail': 'verify failed',
      'git.verifyMissing': 'not verified',
      'git.pr': 'PR #{number}',
      'git.prUnknown': 'PR',
      'git.prManual': 'PR (manual)',
      'git.merged': 'merged',
      'git.mergedAt': 'merged at',
      'git.prReview': 'PR review',
      'member.title': 'Member',
      'member.close': 'close',
      'member.loading': 'Loading…',
      'member.unknown': 'Unknown member',
      'member.fetchError': 'Could not load the member view',
      'member.status': 'status',
      'member.role': 'role',
      'member.context': 'context',
      'member.items': 'Current items',
      'member.noItems': 'No current items',
      'member.activity': 'Recent activity',
      'member.noActivity': 'No recent activity',
      'member.channel': 'Related messages',
      'member.noChannel': 'No related messages',
      'member.roleDefinition': 'Role definition',
      'member.noRoleDefinition': 'No role definition',
      'member.provider': 'provider',
      'member.prompt': 'prompt',
      'member.plan': 'Plan',
      'member.noPlan': 'No plan',
      'member.stopState': 'Stop request',
      'member.noStop': 'No stop request',
      'member.message': 'Message',
      'member.messagePlaceholder': 'Type a message for this member…',
      'member.send': 'Send',
      'member.sending': 'Sending…',
      'member.sent': 'Sent',
      'member.error': 'Send failed: {message}',
      'member.emptyMessage': 'The message cannot be empty',
      'member.stop.pending': 'awaiting response',
      'member.stop.accepted': 'accepted',
      'member.stop.rejected': 'rejected',
      'member.stop.interrupted': 'interrupted',
      'plan.title': 'Plan',
      'plan.status': 'status',
      'plan.pending': 'plan pending',
      'plan.approved': 'plan approved',
      'plan.rejected': 'plan rejected',
      'plan.steps': 'steps',
      'plan.files': 'files',
      'plan.risks': 'risks',
      'plan.decidedBy': 'decided by',
      'plan.reason': 'reason',
      'member.transcript': 'Transcript',
      'member.transcriptEmpty': 'No transcript yet',
      'member.transcriptUnavailable': 'this Host does not expose the session log',
      'member.transcriptTruncated': 'showing the latest {n} messages',
      'member.role.user': 'user',
      'member.role.assistant': 'assistant',
      'member.role.system': 'system',
      'member.role.tool': 'tool',
      'member.transcriptExpand': 'expand',
      'member.transcriptCollapse': 'collapse',
      'board.usage': 'Token usage',
      'board.usageEmpty': 'No usage yet (captured when the gate runs)',
      'board.usageTotals': 'Totals',
      'board.usageCapturedAt': 'captured {time}',
      'board.usageInput': 'input',
      'board.usageOutput': 'output',
      'board.usageCacheRead': 'cache read',
      'board.usageCacheWrite': 'cache write',
    }

    // ---------------------------------------------------------------------
    // Status / tone tables (docs/09 §4 visual mapping)
    // ---------------------------------------------------------------------

    const STATUS_TONES = { approved: 'success', in_review: 'brand', running: 'brand', changes_requested: 'warn', escalated: 'error', pending: 'idle' }
    const PHASE_TONES = { planned: 'idle', reviewing: 'brand', converged: 'success', finalized: 'success', aborted: 'error' }
    const MEMBER_TONES = { running: 'brand', inactive: 'idle', provisioning: 'warn', failed: 'error' }
    const VERDICT_TONES = { approve: 'success', approve_with_nits: 'success', request_changes: 'warn', block: 'error' }
    const SEVERITY_TONES = { blocker: 'error', major: 'error', minor: 'warn', nit: 'idle' }
    const EVENT_FAMILIES = ['all', 'review', 'escalation', 'repair', 'report']
    const CHANNEL_KIND_TONES = { note: 'idle', question: 'brand', answer: 'success', proposal: 'warn', objection: 'error', handoff: 'brand', ack: 'idle', status: 'idle' }
    const PROPOSAL_STATUS_TONES = { open: 'brand', accepted: 'success', rejected: 'error', withdrawn: 'idle', escalated: 'error' }
    const VOTE_TONES = { yes: 'success', no: 'error', abstain: 'idle' }
    const REVIEW_REQUEST_TONES = { open: 'warn', accepted: 'success', declined: 'idle' }
    const HANDOFF_TONES = { offered: 'warn', accepted: 'success', declined: 'idle' }
    const PLAN_STATUS_TONES = { pending: 'warn', approved: 'success', rejected: 'error' }
    const STOP_STATUS_TONES = { pending: 'warn', accepted: 'success', rejected: 'error', interrupted: 'idle' }
    const TRANSCRIPT_ROLE_TONES = { user: 'brand', assistant: 'success', system: 'idle', tool: 'warn' }
    const CHANNEL_FILTERS = ['all', 'question', 'answer', 'proposal', 'handoff', 'status']
    const PROPOSAL_BLOCKING_KINDS = ['dod', 'scope', 'replan']
    const FLOW = {
      cardWidth: 180,
      cardHeight: 126,
      /** Shorter cards for items without a Git row: no dead space in the middle. */
      cardHeightNoGit: 112,
      columnGap: 64,
      rowGap: 28,
      padX: 12,
      padTop: 26,
      padBottom: 12,
      loopWidth: 52,
    }

    // ---------------------------------------------------------------------
    // Defensive readers: every snapshot field is optional (docs/09 §4 容错)
    // ---------------------------------------------------------------------

    /** @returns a definite string for visible text. */
    function str(value, fallback) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return typeof fallback === 'string' ? fallback : ''
    }

    /** @returns a finite number, else `fallback`. */
    function num(value, fallback) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) return parsed
      }
      return fallback
    }

    /** @returns the value as an array, else an empty array. */
    function toArray(value) {
      return Array.isArray(value) ? value : []
    }

    /** @returns whether the value is a plain record (not an array, not null). */
    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /** @returns `[ISO string] -> epoch ms`, `NaN` when unparsable. */
    function parseTime(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value !== 'string' || value === '') return Number.NaN
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : Number.NaN
    }

    /** @returns a one-decimal number for SVG coordinates. */
    function round1(value) {
      return Math.round(value * 10) / 10
    }

    /** @returns a two-decimal number (opacity bands need the extra digit). */
    function round2(value) {
      return Math.round(value * 100) / 100
    }

    /** @returns a cubic path between two anchor points (top-down flow). */
    function linkPath(x1, y1, x2, y2) {
      const mid = (y1 + y2) / 2
      return 'M' + round1(x1) + ',' + round1(y1) + ' C' + round1(x1) + ',' + round1(mid) + ' ' + round1(x2) + ',' + round1(mid) + ' ' + round1(x2) + ',' + round1(y2)
    }

    /**
     * @returns a bowing cubic arc between two peer nodes (percentage space).
     *   `direction` flips the bow so A→B and B→A render as a lens, not a line.
     */
    function peerArc(x1, y1, x2, y2, direction) {
      const dx = x2 - x1
      const dy = y2 - y1
      const length = Math.sqrt(dx * dx + dy * dy)
      if (length === 0) return linkPath(x1, y1, x2, y2)
      const bulge = Math.min(10, Math.max(3, length * 0.12)) * (direction >= 0 ? 1 : -1)
      const controlX = (x1 + x2) / 2 + (-dy / length) * bulge
      const controlY = (y1 + y2) / 2 + (dx / length) * bulge
      const c1x = x1 + (2 / 3) * (controlX - x1)
      const c1y = y1 + (2 / 3) * (controlY - y1)
      const c2x = x2 + (2 / 3) * (controlX - x2)
      const c2y = y2 + (2 / 3) * (controlY - y2)
      return 'M' + round1(x1) + ',' + round1(y1) + ' C' + round1(c1x) + ',' + round1(c1y) + ' ' + round1(c2x) + ',' + round1(c2y) + ' ' + round1(x2) + ',' + round1(y2)
    }

    /** @returns a human message for a thrown value. */
    function messageOf(cause) {
      if (cause instanceof Error) return cause.message
      if (cause && typeof cause === 'object' && typeof cause.message === 'string') return cause.message
      return str(cause, 'unknown error')
    }

    /** Wrap the framework `t` so a missing key never leaks a raw namespace key. */
    function makeTr(t) {
      const translate = typeof t === 'function' ? t : null
      return function tr(key, params, fallback) {
        if (translate !== null) {
          let value
          try {
            value = translate(key, params)
          } catch (ignored) {
            value = undefined
          }
          if (typeof value === 'string' && value.length > 0 && value !== key) return value
        }
        return typeof fallback === 'string' ? fallback : key
      }
    }

    /**
     * @returns a cutoff label for one proposal deadline: the remaining time
     *   while it is still running, the elapsed time once it has passed.
     */
    function deadlineLabel(deadlineMs, nowMs, tr) {
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return ''
      const delta = deadlineMs - nowMs
      if (delta > 0) {
        const seconds = Math.ceil(delta / 1000)
        if (seconds < 60) return tr('proposal.deadline', { when: tr('time.secondsLeft', { n: seconds }) })
        const minutes = Math.ceil(delta / 60000)
        if (minutes < 60) return tr('proposal.deadline', { when: tr('time.minutesLeft', { n: minutes }) })
        return tr('proposal.deadline', { when: tr('time.hoursLeft', { n: Math.ceil(delta / 3600000) }) })
      }
      return tr('proposal.deadlineExpired', { when: relativeTime(deadlineMs, nowMs, tr) })
    }

    /** @returns the local datetime of one instant for a tooltip; '' when unknown. */
    function absoluteTime(atMs) {
      if (!Number.isFinite(atMs) || atMs <= 0) return ''
      try {
        return new Date(atMs).toLocaleString()
      } catch (ignored) {
        return ''
      }
    }

    /** @returns a short relative-time label (`n 秒前` / `n 分钟前`). */
    function relativeTime(atMs, nowMs, tr) {
      if (!Number.isFinite(atMs) || atMs <= 0) return ''
      const seconds = Math.max(0, Math.floor((nowMs - atMs) / 1000))
      if (seconds < 60) return tr('time.secondsAgo', { n: seconds })
      return tr('time.minutesAgo', { n: Math.floor(seconds / 60) })
    }

    /** @returns one of `review` / `escalation` / `repair` / `report` / `other`. */
    function eventFamily(type) {
      const value = str(type).toLowerCase()
      if (value.indexOf('review') !== -1) return 'review'
      if (value.indexOf('escalat') !== -1) return 'escalation'
      if (value.indexOf('repair') !== -1) return 'repair'
      if (value.indexOf('report') !== -1) return 'report'
      return 'other'
    }

    /** @returns the normalized item status (unknown values read as pending). */
    function normalizeStatus(value) {
      const status = str(value, 'pending')
      return Object.prototype.hasOwnProperty.call(STATUS_TONES, status) ? status : 'pending'
    }

    /** @returns the tone class suffix for one item status. */
    function statusTone(status) {
      return STATUS_TONES[status] || 'idle'
    }

    /** @returns the translated label of one item status. */
    function statusLabel(tr, status) {
      return tr('status.' + status, undefined, tr('status.unknown'))
    }

    /** @returns one translated member-status label. */
    function memberStatusLabel(tr, status) {
      const key = 'member.status.' + str(status, 'inactive')
      return tr(key, undefined, tr('common.unknown'))
    }

    /** @returns the tone used by one member-status node. */
    function memberTone(status) {
      return MEMBER_TONES[str(status)] || 'idle'
    }

    /** @returns a translated spawn-context label (`fresh` / `fork`). */
    function contextLabel(tr, context) {
      const value = str(context, 'fresh')
      return tr('member.context.' + value, undefined, value)
    }

    /** @returns a translated phase label. */
    function phaseLabel(tr, phase) {
      const key = 'phase.' + str(phase, 'unknown')
      return tr(key, undefined, tr('phase.unknown'))
    }

    /** @returns the tone used by one phase badge. */
    function phaseTone(phase) {
      return PHASE_TONES[str(phase)] || 'idle'
    }

    /** @returns a translated escalation-kind label. */
    function escalationKindLabel(tr, kind) {
      const key = 'escalations.kind.' + str(kind, 'unknown')
      return tr(key, undefined, tr('escalations.kind.unknown'))
    }

    /** @returns a translated finding-resolution label (`null` reads as none). */
    function resolutionLabel(tr, resolution) {
      const value = str(resolution)
      if (value === '') return tr('common.none')
      return tr('drawer.resolution.' + value, undefined, value)
    }

    /** @returns a translated channel-message-kind label (docs/12 §2). */
    function channelKindLabel(tr, kind) {
      const value = str(kind, 'note')
      return tr('channel.kind.' + value, undefined, tr('channel.kind.unknown'))
    }

    /** @returns a translated proposal-kind label. */
    function proposalKindLabel(tr, kind) {
      const value = str(kind, 'dod')
      return tr('proposal.kind.' + value, undefined, tr('proposal.kind.unknown'))
    }

    /** @returns a translated proposal-status label. */
    function proposalStatusLabel(tr, status) {
      const value = str(status, 'open')
      return tr('proposal.status.' + value, undefined, tr('proposal.status.unknown'))
    }

    /** @returns a translated review-request status label. */
    function reviewRequestStatusLabel(tr, status) {
      const value = str(status, 'open')
      return tr('drawer.review.status.' + value, undefined, value)
    }

    /** @returns a translated handoff status label. */
    function handoffStatusLabel(tr, status) {
      const value = str(status, 'offered')
      return tr('drawer.handoff.status.' + value, undefined, value)
    }

    /** @returns `yes` / `no` / `abstain` (unknown votes read as abstain). */
    /** @returns the plan status label (docs/19 §4). */
    function planStatusLabel(tr, status) {
      if (status === 'approved') return tr('plan.approved')
      if (status === 'rejected') return tr('plan.rejected')
      return tr('plan.pending')
    }

    /** @returns the transcript role label (docs/21). */
    function transcriptRoleLabel(tr, role) {
      if (role === 'user') return tr('member.role.user')
      if (role === 'assistant') return tr('member.role.assistant')
      if (role === 'tool') return tr('member.role.tool')
      return tr('member.role.system')
    }

    /** @returns the stop status label (docs/19 §2). */
    function stopStatusLabel(tr, status) {
      if (status === 'accepted') return tr('member.stop.accepted')
      if (status === 'rejected') return tr('member.stop.rejected')
      if (status === 'interrupted') return tr('member.stop.interrupted')
      return tr('member.stop.pending')
    }

    function normalizeVoteValue(value) {
      const vote = str(value, 'abstain')
      return vote === 'yes' || vote === 'no' || vote === 'abstain' ? vote : 'abstain'
    }

    // ---------------------------------------------------------------------
    // Snapshot normalization (never throws; all fields optional)
    // ---------------------------------------------------------------------

    function normalizeTeam(snapshot) {
      const team = snapshot && typeof snapshot === 'object' ? snapshot.team : null
      const rawMe = team && typeof team === 'object' ? team.me : null
      const me = rawMe && typeof rawMe === 'object' ? { name: str(rawMe.name), role: str(rawMe.role) } : null
      const members = toArray(team && team.members)
        .filter((member) => member && typeof member === 'object')
        .slice(0, MAX_MEMBERS)
        .map((member) => ({
          name: str(member.name, '?'),
          role: str(member.role, 'teammate'),
          status: str(member.status, 'inactive'),
          context: str(member.context, 'fresh'),
        }))
      const tasks = toArray(team && team.tasks).filter((task) => task && typeof task === 'object')
      return { me, members, tasks }
    }

    function normalizeReviews(raw) {
      const reviews = raw && typeof raw === 'object' ? raw : {}
      return {
        reworkRounds: num(reviews.reworkRounds, 0),
        submittedRounds: num(reviews.submittedRounds, 0),
        maxRounds: num(reviews.maxRounds, 2),
        pendingReviewer: reviews.pendingReviewer === null || reviews.pendingReviewer === undefined ? '' : str(reviews.pendingReviewer),
        verdicts: toArray(reviews.verdicts),
        records: toArray(reviews.records),
      }
    }

    function normalizeRepairLog(item) {
      const entries = toArray(item.repairLog)
      if (entries.length > 0) return entries
      const legacy = toArray(item.repairHistory)
      return legacy
    }

    function normalizeItem(raw, runGit) {
      const item = raw && typeof raw === 'object' ? raw : {}
      return {
        id: str(item.id, '?'),
        subject: str(item.subject),
        owner: str(item.owner),
        role: str(item.role, 'implementer'),
        status: normalizeStatus(item.status),
        wave: num(item.wave, 1),
        writeScopes: toArray(item.writeScopes).map((value) => str(value)).filter(Boolean),
        blockedBy: toArray(item.blockedBy).map((value) => str(value)).filter(Boolean),
        definitionOfDone: toArray(item.definitionOfDone).map((value) => str(value)).filter(Boolean),
        reviewers: toArray(item.reviewers).map((value) => str(value)).filter(Boolean),
        needsReview: item.needsReview !== false,
        task: item.task && typeof item.task === 'object' ? item.task : null,
        report: item.report && typeof item.report === 'object' ? item.report : null,
        reviews: normalizeReviews(item.reviews),
        openFindings: num(item.openFindings, 0),
        override: typeof item.override === 'string' && item.override !== '' ? item.override : null,
        repairLog: normalizeRepairLog(item),
        assignment: str(item.assignment, 'lead') === 'open' ? 'open' : 'lead',
        claim: normalizeClaimOrNull(item.claim),
        reviewRequests: toArray(item.reviewRequests).filter(isRecord).map(normalizeReviewRequest),
        handoffs: toArray(item.handoffs).filter(isRecord).map(normalizeHandoff),
        thread: toArray(item.thread).filter(isRecord).map(normalizeChannelEntry),
        openProposals: num(item.openProposals, 0),
        // docs/14 §4: peers may create items mid-run; planned items keep the default.
        origin: str(item.origin, 'plan') === 'member' ? 'member' : 'plan',
        createdBy: str(item.createdBy),
        git: normalizeGit(item.git, runGit),
        plan: normalizePlan(item.plan),
      }
    }

    /**
     * @returns the normalized `items[].git` block, or null when the item has no
     *   git record. Only the item record gates the badges; the run-level record
     *   (`run.git`: branch/base/pushedAt/pr/mergedAt) fills in what the item
     *   record does not carry — that is how the Host aggregates a run that uses
     *   one branch and one pull request for several items (docs/16 §2.3).
     */
    function normalizeGit(raw, runGit) {
      if (!isRecord(raw)) return null
      const run = isRecord(runGit) ? runGit : {}
      const verify = isRecord(raw.verify)
        ? {
            ok: raw.verify.ok === true,
            at: parseTime(raw.verify.at),
            results: toArray(raw.verify.results)
              .filter(isRecord)
              .slice(-4)
              .map((result) => ({ command: str(result.command), exitCode: num(result.exitCode, Number.NaN) })),
          }
        : null
      const prRaw = isRecord(raw.pr) ? raw.pr : isRecord(run.pr) ? run.pr : null
      const pr =
        prRaw === null
          ? null
          : { url: str(prRaw.url), number: num(prRaw.number, Number.NaN), mode: str(prRaw.mode), status: str(prRaw.status) }
      const declaredPush = raw.pushed
      const pushed =
        declaredPush === true ||
        (declaredPush === undefined && (Number.isFinite(parseTime(run.pushedAt)) || str(run.pushedSha) !== ''))
      const itemMerged = parseTime(raw.mergedAt)
      return {
        branch: str(raw.branch, str(run.branch)),
        base: str(raw.base, str(run.base)),
        sha: str(raw.sha, str(run.pushedSha)),
        remote: str(raw.remote, str(run.remote)),
        pushed,
        verify,
        pr,
        prReview: isRecord(raw.prReview) ? { verdict: str(raw.prReview.verdict), mode: str(raw.prReview.mode) } : null,
        mergedAt: Number.isFinite(itemMerged) ? itemMerged : parseTime(run.mergedAt),
        commits: toArray(raw.commits).length,
      }
    }

    /** @returns the run-level git record (`run.git`), or null when absent. */
    function normalizeRunGit(run) {
      return isRecord(run) && isRecord(run.git) ? run.git : null
    }

    /** @returns the run's items with their git records enriched from `run.git`. */
    function normalizeRunItems(run) {
      const runGit = normalizeRunGit(run)
      return toArray(run && run.items).map((item) => normalizeItem(item, runGit))
    }

    /** @returns the normalized `items[].plan` block (docs/19 §4), or null. */
    function normalizePlan(raw) {
      if (!isRecord(raw)) return null
      const status = str(raw.status)
      return {
        steps: toArray(raw.steps)
          .map((step) => str(step))
          .filter((step) => step !== ''),
        files: toArray(raw.files)
          .map((file) => str(file))
          .filter((file) => file !== ''),
        risks: toArray(raw.risks)
          .map((risk) => str(risk))
          .filter((risk) => risk !== ''),
        status: status === 'pending' || status === 'approved' || status === 'rejected' ? status : null,
        decidedBy: str(raw.decidedBy),
        reason: str(raw.reason),
        submittedBy: str(raw.submittedBy),
        submittedAt: parseTime(raw.submittedAt),
        decidedAt: parseTime(raw.decidedAt),
      }
    }

    /** @returns the normalized stop request (docs/19 §2). */
    function normalizeStop(raw) {
      const stop = isRecord(raw) ? raw : {}
      const status = str(stop.status)
      return {
        id: str(stop.id),
        at: parseTime(stop.at),
        by: str(stop.by),
        target: str(stop.target),
        mode: str(stop.mode) === 'interrupt' ? 'interrupt' : 'graceful',
        status: status === 'accepted' || status === 'rejected' || status === 'interrupted' ? status : 'pending',
        reason: str(stop.reason),
        decidedAt: parseTime(stop.decidedAt),
      }
    }

    /**
     * @returns the normalized transcript block (docs/21). The Host projects the
     *   session log best-effort, so a missing/blocked block degrades to
     *   "unavailable" instead of hiding the whole member view.
     */
    function normalizeTranscript(raw) {
      if (!isRecord(raw)) return { available: false, messages: [], truncated: false, totalEvents: 0, error: '' }
      const messages = toArray(raw.messages)
        .filter(isRecord)
        .map((message) => {
          const seq = num(message.seq, Number.NaN)
          return {
            seq: Number.isFinite(seq) ? seq : null,
            role: str(message.role) === 'user' || str(message.role) === 'assistant' || str(message.role) === 'tool' ? str(message.role) : 'system',
            text: str(message.text),
          }
        })
        .filter((message) => message.text !== '')
      return {
        available: raw.available === true,
        messages,
        truncated: raw.truncated === true,
        totalEvents: num(raw.totalEvents, 0),
        error: str(raw.error),
      }
    }

    /** @returns the normalized payload of the member route (docs/19 §5). */
    function normalizeMemberView(raw) {
      const member = isRecord(raw) ? raw : {}
      const stop = isRecord(member.stop) ? member.stop : null
      const plan = isRecord(member.plan) ? member.plan : null
      const roleDefinition = isRecord(member.roleDefinition) ? member.roleDefinition : null
      return {
        name: str(member.name),
        role: str(member.role),
        status: str(member.status),
        context: str(member.context),
        currentItems: toArray(member.currentItems)
          .filter(isRecord)
          .map((item) => ({ id: str(item.id), subject: str(item.subject), status: str(item.status), role: str(item.role) })),
        recentActivity: toArray(member.recentActivity)
          .filter(isRecord)
          .map((event) => ({ at: parseTime(event.at), type: str(event.type), detail: str(event.detail) })),
        channel: toArray(member.channel)
          .filter(isRecord)
          .map((entry) => ({
            id: str(entry.id),
            at: parseTime(entry.at),
            from: str(entry.from),
            to: str(entry.to),
            kind: str(entry.kind),
            text: str(entry.text),
            itemId: str(entry.itemId !== undefined ? entry.itemId : entry.item_id),
          })),
        stop:
          stop === null
            ? null
            : {
                id: str(stop.id),
                status: str(stop.status, 'pending'),
                at: parseTime(stop.at),
                reason: str(stop.reason),
                mode: str(stop.mode),
              },
        plan: plan === null ? null : { itemId: str(plan.itemId), status: str(plan.status) },
        transcript: normalizeTranscript(member.transcript),
        roleDefinition:
          roleDefinition === null
            ? null
            : { role: str(roleDefinition.role), provider: str(roleDefinition.provider), prompt: str(roleDefinition.prompt) },
      }
    }

    function normalizeReport(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        summary: str(raw.summary),
        files: toArray(raw.files).map((value) => str(value)).filter(Boolean),
        commands: toArray(raw.commands)
          .filter((command) => command && typeof command === 'object')
          .map((command) => ({
            command: str(command.command),
            exitCode: command.exitCode === null || command.exitCode === undefined ? null : num(command.exitCode, Number.NaN),
            note: typeof command.note === 'string' && command.note !== '' ? command.note : '',
          })),
        evidence: toArray(raw.evidence).map((value) => str(value)).filter(Boolean),
        risks: toArray(raw.risks).map((value) => str(value)).filter(Boolean),
        openQuestions: toArray(raw.openQuestions).map((value) => str(value)).filter(Boolean),
        deviation: str(raw.deviation),
        submittedAt: str(raw.submittedAt),
      }
    }

    function normalizeRecord(raw) {
      const record = raw && typeof raw === 'object' ? raw : {}
      return {
        round: num(record.round, 0),
        reviewer: str(record.reviewer),
        status: str(record.status),
        verdict: str(record.verdict),
        summary: str(record.summary),
        findings: toArray(record.findings)
          .filter((finding) => finding && typeof finding === 'object')
          .map((finding) => ({
            id: str(finding.id),
            severity: str(finding.severity, 'nit'),
            file: str(finding.file),
            line: finding.line === null || finding.line === undefined ? Number.NaN : num(finding.line, Number.NaN),
            claim: str(finding.claim),
            suggestion: str(finding.suggestion),
            resolution: typeof finding.resolution === 'string' ? finding.resolution : '',
          })),
      }
    }

    function normalizeGate(run) {
      const gate = run && typeof run === 'object' && run.gate && typeof run.gate === 'object' ? run.gate : null
      if (gate === null) return null
      return {
        pass: gate.pass === true,
        evaluatedAt: str(gate.evaluatedAt),
        itemGates: toArray(gate.itemGates)
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => ({
            id: str(entry.id, '?'),
            pass: entry.pass === true,
            overridden: entry.overridden === true,
            overrideReason: str(entry.overrideReason),
            waived: toArray(entry.waived).map((value) => str(value)).filter(Boolean),
            failures: toArray(entry.failures).map((value) => str(value)).filter(Boolean),
            warnings: toArray(entry.warnings).map((value) => str(value)).filter(Boolean),
          })),
        teamFailures: toArray(gate.teamFailures).map((value) => str(value)).filter(Boolean),
        blockingEscalations: toArray(gate.blockingEscalations).map((value) => str(value)).filter(Boolean),
      }
    }

    function normalizeEscalation(raw) {
      const escalation = raw && typeof raw === 'object' ? raw : {}
      return {
        id: str(escalation.id, '?'),
        kind: str(escalation.kind, 'decision'),
        subject: str(escalation.subject),
        detail: str(escalation.detail),
        blocking: escalation.blocking === true,
        itemId: str(escalation.itemId),
        createdBy: str(escalation.createdBy),
        resolved: escalation.resolved === true,
        resolution: str(escalation.resolution),
        resolvedBy: str(escalation.resolvedBy),
        resolvedAt: str(escalation.resolvedAt),
      }
    }

    function normalizeEvent(raw) {
      const event = raw && typeof raw === 'object' ? raw : {}
      return {
        at: parseTime(event.at),
        type: str(event.type, '?'),
        actor: str(event.actor),
        detail: str(event.detail),
      }
    }

    function normalizeArtifacts(run) {
      const artifacts = run && typeof run === 'object' && run.artifacts && typeof run.artifacts === 'object' ? run.artifacts : {}
      return {
        root: str(artifacts.root),
        statePath: str(artifacts.statePath),
        reportPath: str(artifacts.reportPath),
      }
    }

    function normalizeDiagnostics(snapshot) {
      const diagnostics = snapshot && typeof snapshot === 'object' && snapshot.diagnostics && typeof snapshot.diagnostics === 'object' ? snapshot.diagnostics : {}
      return {
        boardSource: str(diagnostics.boardSource, 'missing'),
        warnings: toArray(diagnostics.warnings).map((value) => str(value)).filter(Boolean).slice(0, 8),
      }
    }

    // ---------------------------------------------------------------------
    // Peer collaboration (docs/12 §5): one channel, proposals with tallies,
    // open queue, review invitations, handoffs, and peer-message edges.
    // Every field is optional so a v1 snapshot renders the v1 board.
    // ---------------------------------------------------------------------

    function normalizeChannelEntry(raw) {
      const entry = isRecord(raw) ? raw : {}
      const refs = isRecord(entry.refs) ? entry.refs : {}
      return {
        id: str(entry.id, '?'),
        at: parseTime(entry.at),
        from: str(entry.from, '?'),
        to: str(entry.to, 'team'),
        kind: str(entry.kind, 'note'),
        text: str(entry.text),
        itemId: str(entry.itemId, str(refs.itemId)),
        findingId: str(entry.findingId, str(refs.findingId)),
        proposalId: str(entry.proposalId, str(refs.proposalId)),
        replyTo: str(entry.replyTo),
      }
    }

    function normalizeVote(raw) {
      const vote = isRecord(raw) ? raw : {}
      return {
        by: str(vote.by, '?'),
        at: parseTime(vote.at),
        vote: normalizeVoteValue(vote.vote),
        comment: str(vote.comment),
      }
    }

    function normalizeProposal(raw) {
      const proposal = isRecord(raw) ? raw : {}
      const votes = toArray(proposal.votes).filter(isRecord).map(normalizeVote)
      const tallyRaw = isRecord(proposal.tally) ? proposal.tally : {}
      const tally = {
        yes: num(tallyRaw.yes, votes.filter((vote) => vote.vote === 'yes').length),
        no: num(tallyRaw.no, votes.filter((vote) => vote.vote === 'no').length),
        abstain: num(tallyRaw.abstain, votes.filter((vote) => vote.vote === 'abstain').length),
        affected: num(tallyRaw.affected, votes.length),
        total: num(tallyRaw.total, Math.max(num(tallyRaw.affected, votes.length), votes.length)),
      }
      return {
        id: str(proposal.id, '?'),
        at: parseTime(proposal.at),
        by: str(proposal.by, '?'),
        kind: str(proposal.kind, 'unknown'),
        itemId: str(proposal.itemId),
        text: str(proposal.text),
        status: str(proposal.status, 'open'),
        votes,
        tally,
        resolvedAt: parseTime(proposal.resolvedAt),
        resolution: str(proposal.resolution),
        // docs/14 §2: liveness fields (absent on older boards).
        deadline: parseTime(proposal.deadline),
        autoResolved: proposal.autoResolved === true,
        quorum: num(proposal.quorum, Number.NaN),
      }
    }

    function normalizeClaim(raw) {
      const claim = isRecord(raw) ? raw : {}
      const lease = num(claim.leaseMinutes, Number.NaN)
      return {
        by: str(claim.by),
        at: parseTime(claim.at),
        leaseMinutes: Number.isFinite(lease) ? lease : null,
        note: str(claim.note),
      }
    }

    /** @returns the claim, or null when the item is unclaimed/malformed. */
    function normalizeClaimOrNull(raw) {
      if (!isRecord(raw)) return null
      const claim = normalizeClaim(raw)
      return claim.by === '' ? null : claim
    }

    function normalizeReviewRequest(raw) {
      const request = isRecord(raw) ? raw : {}
      const status = str(request.status, 'open')
      return {
        by: str(request.by, '?'),
        at: parseTime(request.at),
        reviewer: str(request.reviewer),
        status: status === 'open' || status === 'accepted' || status === 'declined' ? status : 'open',
        respondedAt: parseTime(request.respondedAt),
        response: str(request.response),
      }
    }

    function normalizeHandoff(raw) {
      const handoff = isRecord(raw) ? raw : {}
      const status = str(handoff.status, 'offered')
      return {
        itemId: str(handoff.itemId),
        by: str(handoff.by, '?'),
        at: parseTime(handoff.at),
        to: str(handoff.to, '?'),
        reason: str(handoff.reason),
        status: status === 'offered' || status === 'accepted' || status === 'declined' ? status : 'offered',
        respondedAt: parseTime(handoff.respondedAt),
      }
    }

    function normalizePeerEdge(raw) {
      const edge = isRecord(raw) ? raw : {}
      return {
        from: str(edge.from, '?'),
        to: str(edge.to, '?'),
        count: Math.max(1, num(edge.count, 1)),
        kinds: toArray(edge.kinds).map((value) => str(value)).filter(Boolean),
      }
    }

    function normalizePendingReview(raw) {
      const pending = isRecord(raw) ? raw : {}
      return {
        itemId: str(pending.itemId),
        requestedBy: str(pending.requestedBy, '?'),
        reviewer: str(pending.reviewer),
        at: parseTime(pending.at),
      }
    }

    /** @returns the normalized `run.collaboration` block (`present=false` for v1). */
    function normalizeCollaboration(run) {
      const raw = isRecord(run) && isRecord(run.collaboration) ? run.collaboration : null
      if (raw === null) {
        return { channel: [], proposals: [], openQueue: [], pendingReviews: [], handoffs: [], edges: [], stops: [] }
      }
      return {
        channel: toArray(raw.channel).filter(isRecord).map(normalizeChannelEntry),
        proposals: toArray(raw.proposals).filter(isRecord).map(normalizeProposal),
        openQueue: toArray(raw.openQueue).map((value) => str(value)).filter(Boolean),
        pendingReviews: toArray(raw.pendingReviews).filter(isRecord).map(normalizePendingReview),
        handoffs: toArray(raw.handoffs).filter(isRecord).map(normalizeHandoff),
        edges: toArray(raw.edges).filter(isRecord).map(normalizePeerEdge),
        stops: toArray(raw.stops).filter(isRecord).map(normalizeStop),
      }
    }

    // ---------------------------------------------------------------------
    // Layout: execution flow (wave columns) and collaboration topology
    // ---------------------------------------------------------------------

    /**
     * Order the work items into columns: `run.waves` first (Host-computed),
     * then any item the Host did not place (dependency cycle / older board)
     * grouped by its own numeric wave so nothing silently disappears.
     * @returns `[{ label, items }]`.
     */
    function computeColumns(run) {
      const items = normalizeRunItems(run).slice(0, MAX_ITEMS)
      const byId = new Map()
      for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item)
      const columns = []
      const placed = new Set()
      toArray(run && run.waves).forEach((wave, waveIndex) => {
        const waveItems = []
        for (const rawId of toArray(wave)) {
          const id = str(rawId)
          const item = byId.get(id)
          if (item === undefined || placed.has(id)) continue
          placed.add(id)
          waveItems.push(item)
        }
        if (waveItems.length > 0) columns.push({ label: waveIndex + 1, items: waveItems })
      })
      const leftovers = items.filter((item) => !placed.has(item.id))
      if (leftovers.length > 0) {
        const groups = new Map()
        for (const item of leftovers) {
          const wave = num(item.wave, 0)
          const key = String(wave)
          if (!groups.has(key)) groups.set(key, { label: wave, items: [] })
          groups.get(key).items.push(item)
        }
        const sorted = [...groups.values()].sort((left, right) => left.label - right.label)
        for (const group of sorted) columns.push(group)
      }
      return columns
    }

    /**
     * Absolute layout of the flow canvas: one column per wave, one row per
     * item, cubic dependency arrows, and a review self-loop per reviewed item.
     * @returns `{ columns, cards, edges, loops, width, height }`.
     */
    function computeFlowLayout(run) {
      const columns = computeColumns(run)
      const cards = []
      const positions = new Map()
      let maxRows = 0
      columns.forEach((column, columnIndex) => {
        if (column.items.length > maxRows) maxRows = column.items.length
        column.items.forEach((item, rowIndex) => {
          const x = FLOW.padX + columnIndex * (FLOW.cardWidth + FLOW.columnGap)
          const y = FLOW.padTop + rowIndex * (FLOW.cardHeight + FLOW.rowGap)
          // Rows keep the full card height; a card without a Git row is simply
          // shorter, which removes the dead space above its bottom-anchored flags.
          const height = item.git === null ? FLOW.cardHeightNoGit : FLOW.cardHeight
          if (!positions.has(item.id)) positions.set(item.id, { x, y, height })
          cards.push({ key: 'card-' + item.id, item, x, y, height })
        })
      })
      const width = columns.length === 0 ? 0 : FLOW.padX * 2 + columns.length * FLOW.cardWidth + (columns.length - 1) * FLOW.columnGap + FLOW.loopWidth
      const height = columns.length === 0 ? 0 : FLOW.padTop + maxRows * FLOW.cardHeight + Math.max(0, maxRows - 1) * FLOW.rowGap + FLOW.padBottom
      const edges = []
      for (const card of cards) {
        for (const dependencyId of card.item.blockedBy) {
          const from = positions.get(dependencyId)
          if (from === undefined) continue
          edges.push({
            key: 'dep-' + card.item.id + '-' + dependencyId,
            className: 'atw-edge--dep',
            d: linkPath(
              from.x + FLOW.cardWidth / 2,
              from.y + (Number.isFinite(from.height) ? from.height : FLOW.cardHeight) + 1,
              card.x + FLOW.cardWidth / 2,
              card.y - 5,
            ),
          })
        }
      }
      const loops = []
      for (const card of cards) {
        const reviews = card.item.reviews
        const reviewed = reviews.submittedRounds > 0 || reviews.reworkRounds > 0 || reviews.pendingReviewer !== ''
        if (!reviewed) continue
        const startX = card.x + FLOW.cardWidth
        const cardHeight = Number.isFinite(card.height) ? card.height : FLOW.cardHeight
        const midY = card.y + cardHeight / 2
        loops.push({
          key: 'loop-' + card.item.id,
          d: 'M' + round1(startX) + ',' + round1(midY - 15) + ' C' + round1(startX + 26) + ',' + round1(midY - 15) + ' ' + round1(startX + 26) + ',' + round1(midY + 15) + ' ' + round1(startX) + ',' + round1(midY + 15),
          labelX: startX + 28,
          labelY: midY + 3,
          label: 'R' + reviews.submittedRounds + '/' + reviews.maxRounds,
        })
      }
      return { columns, cards, edges, loops, width, height }
    }

    /**
     * Distribute `count` nodes over one or two rows inside a percentage box.
     * @returns `{ nodes: [{ x, y }] (0..100 percentage coordinates), perRow }`.
     */
    function spreadNodes(count, singleRowY, firstRowY, secondRowY) {
      if (count <= 0) return { nodes: [], perRow: 1 }
      const rows = count > 6 ? 2 : 1
      const perRow = Math.ceil(count / rows)
      const nodes = []
      for (let index = 0; index < count; index += 1) {
        const row = Math.min(rows - 1, Math.floor(index / perRow))
        const inRow = index - row * perRow
        const countInRow = Math.min(perRow, count - row * perRow)
        const x = countInRow <= 1 ? 50 : 7 + (inRow * 86) / (countInRow - 1)
        const y = rows === 1 ? singleRowY : row === 0 ? firstRowY : secondRowY
        nodes.push({ x: round1(x), y })
      }
      return { nodes, perRow }
    }

    /**
     * Width cap (percentage) that keeps `perRow` nodes from overlapping.
     * @returns the `max-width` percentage for one node in the row.
     */
    function nodeWidth(perRow, cap, floor) {
      if (perRow <= 1) return cap
      const gap = 86 / (perRow - 1)
      return Math.min(cap, Math.max(floor, gap * 0.9))
    }

    /**
     * Percentage layout for the topology panel: Lead on top, members in the
     * middle band, work items at the bottom, with Lead→member, owner→item, and
     * reviewer→item links.
     * @returns `{ lead, memberNodes, itemNodes, edges }`.
     */
    /**
     * Split the roster into participants (members with work/review/channel
     * activity, plus anyone not idle) and the idle members to fold into one node.
     * @returns `{ participants, idle }` member records.
     */
    function splitParticipants(team, items, collaboration) {
      const leadName = team.me && team.me.name ? team.me.name : ''
      const active = new Set()
      const mark = (name) => {
        const value = str(name)
        if (value !== '') active.add(value)
      }
      for (const item of items) {
        mark(item.owner)
        for (const reviewer of item.reviewers) mark(reviewer)
        if (item.claim !== null) mark(item.claim.by)
        for (const request of item.reviewRequests) {
          mark(request.by)
          mark(request.reviewer)
        }
        for (const handoff of item.handoffs) {
          mark(handoff.by)
          mark(handoff.to)
        }
      }
      if (isRecord(collaboration)) {
        // Deliberately NOT `collaboration.edges`: a `to:"team"` broadcast fans
        // out into an edge to every roster member, so trusting edges would
        // promote silent/idle members back into the drawn set.
        for (const entry of collaboration.channel) {
          mark(entry.from)
          if (entry.to !== 'team') mark(entry.to)
        }
        for (const pending of collaboration.pendingReviews) mark(pending.requestedBy)
        for (const handoff of collaboration.handoffs) {
          mark(handoff.by)
          mark(handoff.to)
        }
        for (const proposal of collaboration.proposals) mark(proposal.by)
      }
      const participants = []
      const idle = []
      for (const member of team.members) {
        // The Lead already owns its own node; folding it into 「空闲 N 人」
        // would double-count the Lead and inflate the idle number.
        if (member.name === '' || (leadName !== '' && member.name === leadName)) continue
        const busy = member.status !== 'inactive' || active.has(member.name)
        if (busy) participants.push(member)
        else idle.push(member)
      }
      return { participants, idle }
    }

    function computeTopology(team, items, collaboration) {
      const leadName = team.me && team.me.name ? team.me.name : ''
      const lead = { x: 50, y: 12, name: leadName }
      const split = splitParticipants(team, items, collaboration)
      // Defensive cap: the layout supports two rows, so keep the drawn set bounded.
      const participants = split.participants.slice(0, 12)
      const memberSpread = spreadNodes(participants.length, 44, 36, 52)
      const memberRows = participants.length > 6 ? 2 : 1
      // docs/19 §2: a pending graceful stop marks its target with a warn dot.
      const pendingStops = new Map()
      for (const stop of toArray(isRecord(collaboration) ? collaboration.stops : [])) {
        if (stop.status === 'pending' && stop.target !== '') pendingStops.set(stop.target, stop)
      }
      const memberNodes = participants.map((member, index) => ({
        key: 'member-' + member.name + '-' + index,
        member,
        stop: pendingStops.get(member.name) || null,
        x: memberSpread.nodes[index].x,
        y: memberSpread.nodes[index].y,
      }))
      const idleNode =
        split.idle.length === 0
          ? null
          : {
              key: 'idle',
              count: split.idle.length,
              names: split.idle.map((member) => member.name).join(', '),
              x: 50,
              y: memberRows === 2 ? 64 : 54,
            }
      const itemSpread = spreadNodes(items.length, 84, 78, 92)
      const itemNodes = items.map((item, index) => ({
        key: 'item-' + item.id,
        item,
        x: itemSpread.nodes[index].x,
        y: itemSpread.nodes[index].y,
      }))
      const edges = []
      for (const node of memberNodes) {
        edges.push({
          key: 'lead-' + node.key,
          className: 'atw-edge--lead',
          d: linkPath(lead.x, lead.y + 4.5, node.x, node.y - 4.5),
        })
      }
      const byName = new Map()
      for (const node of memberNodes) if (!byName.has(node.member.name)) byName.set(node.member.name, node)
      // Peer links may target the Lead too (a member can message the Lead directly).
      if (leadName !== '' && !byName.has(leadName)) byName.set(leadName, { x: lead.x, y: lead.y, key: 'lead' })
      for (const node of itemNodes) {
        const owner = byName.get(node.item.owner)
        if (owner !== undefined) {
          edges.push({
            key: 'owns-' + node.key,
            className: 'atw-edge--owns',
            d: linkPath(owner.x, owner.y + 4.5, node.x, node.y - 4.5),
          })
        }
        for (const reviewer of node.item.reviewers) {
          const reviewNode = byName.get(reviewer)
          if (reviewNode === undefined) continue
          edges.push({
            key: 'reviews-' + node.key + '-' + reviewer,
            className: 'atw-edge--review',
            d: linkPath(reviewNode.x, reviewNode.y + 4.5, node.x, node.y - 4.5),
          })
        }
      }
      // Peer↔peer noise budget: only participants, only meaningful counts, top N.
      const candidates = []
      for (const edge of toArray(isRecord(collaboration) ? collaboration.edges : [])) {
        if (edge.from === edge.to) continue
        const fromNode = byName.get(edge.from)
        const toNode = byName.get(edge.to)
        if (fromNode === undefined || toNode === undefined) continue
        candidates.push({ edge, fromNode, toNode })
      }
      const nodeCount = memberNodes.length + 1
      const threshold = nodeCount <= 4 ? 1 : 2
      const ranked = candidates
        .filter((entry) => num(entry.edge.count, 1) >= threshold)
        .sort((left, right) => num(right.edge.count, 1) - num(left.edge.count, 1))
        .slice(0, PEER_EDGE_LIMIT)
      const counts = ranked.map((entry) => num(entry.edge.count, 1))
      const maxCount = counts.length === 0 ? 1 : Math.max(...counts)
      const minCount = counts.length === 0 ? 1 : Math.min(...counts)
      const peerEdges = ranked.map((entry) => {
        const count = num(entry.edge.count, 1)
        const ratio = maxCount === minCount ? 0.5 : (count - minCount) / (maxCount - minCount)
        return {
          key: 'peer-' + entry.edge.from + '-' + entry.edge.to,
          from: entry.edge.from,
          to: entry.edge.to,
          count,
          kinds: entry.edge.kinds,
          d: peerArc(entry.fromNode.x, entry.fromNode.y, entry.toNode.x, entry.toNode.y, entry.edge.from < entry.edge.to ? 1 : -1),
          width: round1(0.8 + ratio * 1.6),
          opacity: round2(0.25 + ratio * 0.3),
        }
      })
      // docs/12 §6: once peers talk to each other, de-emphasize the Lead spokes
      // so the board reads "peers collaborating", not only "Lead dispatching".
      const hasPeerEdges = peerEdges.length > 0
      if (hasPeerEdges) {
        for (const edge of edges) if (edge.className === 'atw-edge--lead') edge.className = 'atw-edge--lead atw-edge--lead-muted'
      }
      return {
        lead,
        memberNodes,
        idleNode,
        itemNodes,
        edges,
        peerEdges,
        hasPeerEdges,
        memberRows,
        participantCount: memberNodes.length,
        idleCount: split.idle.length,
        itemWidth: nodeWidth(itemSpread.perRow, 11, 5),
      }
    }

    // ---------------------------------------------------------------------
    // Styles: only the theme tokens enumerated by docs/09 §4 are used (the
    // alias palette: bg / border / label / brand / state), so the board follows
    // both light and dark themes; every class is `atw-` prefixed and dies with
    // the component.
    // ---------------------------------------------------------------------

    const STYLES = `
.atw-root{position:relative;display:flex;flex-direction:column;box-sizing:border-box;min-height:100%;padding:16px 20px 20px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.atw-scroll{display:flex;flex-direction:column;gap:12px;min-width:0}
.atw-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.atw-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.atw-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.atw-header-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 260px}
.atw-title{font-size:16px;line-height:24px;font-weight:600}
.atw-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(70vw,760px)}
.atw-header-side{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.atw-meta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.atw-btn{box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:2px 10px;cursor:pointer}
.atw-btn:hover{background:var(--dsw-alias-bg-overlay)}
.atw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.atw-badge{display:inline-flex;align-items:center;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;padding:1px 8px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.atw-badge--brand{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.atw-badge--success{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.atw-badge--warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.atw-badge--error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.atw-badge--idle{border-color:var(--dsw-alias-state-idle-primary);color:var(--dsw-alias-label-secondary)}
.atw-badge--member{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.atw-badge--auto{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.atw-progress{display:flex;align-items:center;gap:6px}
.atw-progress-track{width:84px;height:5px;border-radius:999px;background:var(--dsw-alias-bg-overlay);overflow:hidden}
.atw-progress-fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary)}
.atw-error-strip{display:flex;align-items:center;justify-content:space-between;gap:8px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:5px 10px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.atw-error-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atw-main{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1.4fr);gap:12px;align-items:start;min-width:0}
.atw-lower{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start;min-width:0}
@media (max-width:1180px){.atw-main,.atw-collab,.atw-lower{grid-template-columns:minmax(0,1fr)}}
.atw-panel{display:flex;flex-direction:column;box-sizing:border-box;min-width:0;min-height:240px;max-height:320px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.atw-panel--flow{max-height:520px}
.atw-panel-head{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px;min-width:0;height:32px;box-sizing:border-box;padding:0 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.atw-panel-title{font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}
.atw-panel-hint{min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atw-panel-body{padding:10px 12px;min-width:0;flex:1 1 auto;min-height:0;overflow:auto}
.atw-panel-body--flush{padding:0}
.atw-flow{overflow:auto}
.atw-flow-canvas{position:relative}
.atw-wave-label{position:absolute;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
.atw-svg{position:absolute;left:0;top:0;pointer-events:none;color:var(--dsw-alias-label-secondary)}
.atw-edge{fill:none;stroke:currentColor;stroke-width:1;opacity:.55;vector-effect:non-scaling-stroke}
.atw-edge--dep{color:var(--dsw-alias-brand-primary);opacity:.7}
.atw-edge--lead{opacity:.6}
.atw-edge--owns{opacity:.45}
.atw-edge--review{stroke-dasharray:4 3;color:var(--dsw-alias-brand-primary);opacity:.85}
.atw-edge--loop{stroke-dasharray:3 3;color:var(--dsw-alias-state-warn-primary);opacity:.9}
.atw-arrow{fill:currentColor}
.atw-loop-text{fill:var(--dsw-alias-state-warn-primary);font-size:9px}
.atw-card{position:absolute;display:flex;flex-direction:column;gap:3px;box-sizing:border-box;padding:6px 9px;border:0.5px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-idle-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer;overflow:hidden}
.atw-card:hover{background:var(--dsw-alias-bg-layer-2)}
.atw-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.atw-card--success{border-left-color:var(--dsw-alias-state-success-primary)}
.atw-card--brand{border-left-color:var(--dsw-alias-brand-primary)}
.atw-card--warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.atw-card--error{border-left-color:var(--dsw-alias-state-error-primary)}
.atw-card--idle{border-left-color:var(--dsw-alias-state-idle-primary)}
.atw-card--pending-review{outline:1px dashed var(--dsw-alias-state-warn-primary);outline-offset:1px}
.atw-card--selected{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.atw-card-head{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden}
.atw-card-head,.atw-card-subject,.atw-card-meta,.atw-card-git{flex:none}
.atw-card-id{flex:none;font-size:12px;font-weight:600}
.atw-card-subject{max-height:30px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;font-size:12px;line-height:15px}
.atw-card-meta{overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;white-space:nowrap;text-overflow:ellipsis}
.atw-card-flags{display:flex;align-items:center;gap:5px;flex-wrap:wrap;max-height:32px;margin-top:auto;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px}
.atw-card-pending{overflow:hidden;color:var(--dsw-alias-state-warn-primary);white-space:nowrap;text-overflow:ellipsis}
.atw-card-git{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;font-size:11px;line-height:15px;white-space:nowrap}
.atw-badge--git{max-width:132px;font-size:10px;line-height:14px}
.atw-badge--link{text-decoration:none;cursor:pointer}
.atw-link{color:var(--dsw-alias-brand-primary);text-decoration:underline;overflow-wrap:anywhere}
.atw-topo-canvas{position:relative;height:240px;border-radius:8px;background:var(--dsw-alias-bg-base);overflow:hidden}
.atw-topo-svg{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;color:var(--dsw-alias-label-secondary)}
.atw-node{position:absolute;z-index:1;display:flex;align-items:center;gap:4px;box-sizing:border-box;max-width:100%;padding:2px 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:16px;white-space:nowrap;transform:translate(-50%,-50%)}
.atw-node--idle{border-style:dashed;border-color:var(--dsw-alias-state-idle-primary);color:var(--dsw-alias-label-secondary);max-width:40%}
.atw-node--lead{max-width:52%;border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.atw-node-sub{max-width:110px;overflow:hidden;color:var(--dsw-alias-label-secondary);font-weight:400;text-overflow:ellipsis}
.atw-node--item{max-width:11%;padding:2px 6px;font-size:10px;line-height:14px}
.atw-node--st-running{border-color:var(--dsw-alias-brand-primary);animation:atw-pulse 1.6s ease-in-out infinite}
.atw-node--st-inactive{opacity:.5}
.atw-node--st-provisioning{border-style:dashed}
.atw-node--st-failed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.atw-node--tone-success{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.atw-node--tone-brand{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.atw-node--tone-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.atw-node--tone-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.atw-node--tone-idle{color:var(--dsw-alias-label-secondary)}
.atw-topo-empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dsw-alias-label-secondary);font-size:12px}
.atw-legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.atw-legend-item{display:inline-flex;align-items:center;gap:4px}
.atw-legend-line{display:inline-block;width:18px;height:0;border-top:1px solid var(--dsw-alias-label-secondary)}
.atw-legend-line--review{border-top-style:dashed;border-top-color:var(--dsw-alias-brand-primary)}
.atw-legend-line--owns{border-top-color:var(--dsw-alias-label-secondary);opacity:.6}
.atw-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.atw-filters{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.atw-filter{border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;padding:1px 8px;cursor:pointer}
.atw-filter:hover{background:var(--dsw-alias-bg-overlay)}
.atw-filter--active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.atw-events{display:flex;flex-direction:column}
.atw-event{display:flex;align-items:baseline;gap:6px;min-width:0;padding:3px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1);font-size:12px;line-height:17px}
.atw-event:last-child{border-bottom:none}
.atw-event-time{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.atw-event-type{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.atw-event-detail{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.atw-event-actor{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.atw-event--review .atw-event-type{color:var(--dsw-alias-brand-primary)}
.atw-event--escalation .atw-event-type{color:var(--dsw-alias-state-error-primary)}
.atw-event--repair .atw-event-type{color:var(--dsw-alias-state-warn-primary)}
.atw-event--report .atw-event-type{color:var(--dsw-alias-state-success-primary)}
.atw-gate{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px}
.atw-gate-item{display:flex;flex-direction:column;gap:2px;padding-bottom:5px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.atw-gate-item:last-child{border-bottom:none;padding-bottom:0}
.atw-gate-head{display:flex;align-items:center;gap:6px;min-width:0}
.atw-gate-id{flex:none;font-weight:600}
.atw-gate-line{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.atw-gate-line--error{color:var(--dsw-alias-state-error-primary)}
.atw-gate-line--warn{color:var(--dsw-alias-state-warn-primary)}
.atw-path{display:flex;align-items:center;gap:6px;min-width:0}
.atw-path-text{min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:nowrap;text-overflow:ellipsis;user-select:text}
.atw-esc-list{display:flex;flex-direction:column;gap:6px}
.atw-esc{display:flex;flex-direction:column;gap:3px;padding:7px 8px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:17px}
.atw-esc--blocking{border-color:var(--dsw-alias-state-error-primary)}
.atw-esc-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.atw-esc-subject{font-weight:600;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.atw-esc-detail{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.atw-esc-resolution{overflow-wrap:anywhere}
.atw-empty{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;border:0.5px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:18px 16px}
.atw-empty-title{font-size:14px;line-height:22px;font-weight:600}
.atw-member-list{display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:18px}
.atw-member-line{display:flex;align-items:center;gap:6px;min-width:0}
.atw-member-line--button{box-sizing:border-box;width:100%;padding:2px 0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.atw-member-line--button:hover{color:var(--dsw-alias-brand-primary)}
.atw-node-stop{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-warn-primary)}
.atw-member{position:fixed;top:80px;right:16px;z-index:41;display:flex;flex-direction:column;box-sizing:border-box;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 180px);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);overflow:hidden}
.atw-member-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;box-sizing:border-box;padding:10px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.atw-member-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.atw-member-title{font-size:13px;line-height:19px;font-weight:600;overflow-wrap:anywhere}
.atw-member-body{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow:auto;padding:10px 12px 16px}
.atw-member-item{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:12px;line-height:16px}
.atw-member-event{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:11px;line-height:16px}
.atw-member-text{min-width:0;overflow-wrap:anywhere;font-size:12px;line-height:16px}
.atw-member-message{display:flex;flex-direction:column;gap:2px;min-width:0;padding-bottom:6px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.atw-member-message:last-child{border-bottom:none;padding-bottom:0}
.atw-member-channel-text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:16px;overflow-wrap:anywhere}
.atw-member-role{display:flex;flex-direction:column;gap:4px;min-width:0}
.atw-member-transcript{display:flex;flex-direction:column;gap:4px;min-width:0}
.atw-member-transcript-list{display:flex;flex-direction:column;gap:6px;min-width:0}
.atw-member-transcript-item{display:flex;flex-direction:column;gap:2px;min-width:0;padding-bottom:6px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.atw-member-transcript-item:last-child{border-bottom:none;padding-bottom:0}
.atw-member-transcript-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.atw-member-transcript-text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.atw-member-transcript-item--button{cursor:pointer;border-radius:6px;padding:2px 4px 6px}
.atw-member-transcript-item--button:hover{background:var(--dsw-alias-bg-layer-1)}
.atw-member-transcript-item--button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.atw-member-transcript-text--expanded{display:block;overflow:visible}
.atw-member-transcript-toggle{color:var(--dsw-alias-brand-primary);font-size:11px;line-height:16px}
.atw-usage-wrap{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-width:0}
.atw-usage-table{display:flex;flex-direction:column;gap:2px;min-width:0}
.atw-usage-line{display:grid;grid-template-columns:minmax(96px,1.6fr) repeat(4,minmax(0,1fr));gap:8px;align-items:center;min-width:0;font-size:11px;line-height:16px;padding:2px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.atw-usage-line:last-child{border-bottom:none}
.atw-usage-head{color:var(--dsw-alias-label-secondary);font-weight:600}
.atw-usage-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atw-usage-cell{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.atw-usage-head .atw-usage-cell{color:var(--dsw-alias-label-secondary)}
.atw-usage-totals{border-top:0.5px solid var(--dsw-alias-border-l2);border-bottom:none;margin-top:4px;padding-top:4px;font-weight:600}
.atw-member-prompt{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.atw-member-composer{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:0.5px solid var(--dsw-alias-border-l1)}
.atw-member-input{box-sizing:border-box;width:100%;padding:4px 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px}
.atw-member-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.atw-member-status{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.atw-member-status--ok{color:var(--dsw-alias-state-success-primary)}
.atw-member-status--error{color:var(--dsw-alias-state-error-primary)}
.atw-member-error{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.atw-node--member{cursor:pointer}
.atw-error-card{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.atw-error-title{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-state-error-primary)}
.atw-error-detail{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.atw-drawer{position:fixed;top:80px;right:16px;z-index:40;display:flex;flex-direction:column;box-sizing:border-box;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 180px);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);overflow:hidden}
.atw-drawer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;box-sizing:border-box;padding:10px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.atw-drawer-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.atw-drawer-title{font-size:13px;line-height:19px;font-weight:600;overflow-wrap:anywhere}
.atw-drawer-body{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow:auto;padding:10px 12px 16px}
.atw-section{display:flex;flex-direction:column;gap:4px;min-width:0}
.atw-section-title{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.atw-list{display:flex;flex-direction:column;gap:2px;margin:0;padding-left:16px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.atw-kv{display:flex;gap:6px;min-width:0;font-size:12px;line-height:18px}
.atw-kv-key{flex:none;min-width:64px;color:var(--dsw-alias-label-secondary)}
.atw-kv-value{min-width:0;overflow-wrap:anywhere}
.atw-pre{margin:0;padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.atw-command{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:18px}
.atw-command-text{min-width:0;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px}
.atw-finding{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:17px}
.atw-finding-claim{overflow-wrap:anywhere}
.atw-record{display:flex;flex-direction:column;gap:4px;padding:7px 8px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:6px}
.atw-record-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.atw-record-summary{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.atw-right{min-width:0;margin-left:auto}
.atw-collab{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:12px;align-items:start;min-width:0}
.atw-flow-stack{display:flex;flex-direction:column;gap:8px;min-width:0}
.atw-open-queue{display:flex;flex-direction:column;gap:6px;min-width:0}
.atw-open-queue-label{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.atw-open-queue-cards{display:flex;gap:8px;flex-wrap:wrap;min-width:0}
.atw-open-card{display:flex;flex-direction:column;gap:2px;box-sizing:border-box;width:168px;padding:6px 9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer;min-width:0}
.atw-open-card:hover{background:var(--dsw-alias-bg-overlay)}
.atw-open-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.atw-open-card-head{display:flex;align-items:center;gap:4px;min-width:0}
.atw-open-card-subject{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.atw-open-card-meta{overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;white-space:nowrap;text-overflow:ellipsis}
.atw-channel{display:flex;flex-direction:column}
.atw-channel-item{display:flex;flex-direction:column;gap:2px;min-width:0;padding:5px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.atw-channel-item:last-child{border-bottom:none}
.atw-channel-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.atw-channel-from{min-width:0;max-width:46%;overflow:hidden;font-size:12px;line-height:17px;white-space:nowrap;text-overflow:ellipsis}
.atw-channel-time{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
.atw-channel-ref{box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11px;line-height:16px;padding:0 7px;cursor:pointer}
.atw-channel-ref:hover{background:var(--dsw-alias-bg-overlay)}
.atw-channel-ref:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.atw-channel-text{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:17px;overflow-wrap:anywhere}
.atw-channel-text--expanded{display:block;overflow:visible}
.atw-channel-toggle{align-self:flex-start;margin-top:1px;padding:0;border:0;background:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.atw-channel-toggle:hover{text-decoration:underline}
.atw-proposal-list{display:flex;flex-direction:column;gap:8px}
.atw-proposal{display:flex;flex-direction:column;gap:4px;box-sizing:border-box;min-width:0;padding:7px 8px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.atw-proposal--blocking{border-color:var(--dsw-alias-state-warn-primary)}
.atw-proposal-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.atw-proposal-by{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.atw-proposal-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:17px;overflow-wrap:anywhere}
.atw-proposal-tally{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.atw-proposal-meta{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.atw-proposal-deadline{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
.atw-proposal-voters{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.atw-proposal-resolution{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.atw-edge--peer{color:var(--dsw-alias-state-warn-primary);opacity:.6}
.atw-edge--lead-muted{opacity:.22}
.atw-legend-line--peer{border-top-color:var(--dsw-alias-state-warn-primary);opacity:.8}
.atw-collab-list{display:flex;flex-direction:column;gap:6px;min-width:0}
.atw-collab-row{display:flex;flex-direction:column;gap:2px;box-sizing:border-box;min-width:0;padding:5px 7px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1)}
.atw-collab-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.atw-collab-text{font-size:12px;line-height:17px;overflow-wrap:anywhere}
.atw-collab-sub{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
@keyframes atw-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.atw-node--st-running{animation:none}}
`

    // ---------------------------------------------------------------------
    // Small render helpers
    // ---------------------------------------------------------------------

    function badge(label, tone, key) {
      return h('span', { key, className: 'atw-badge' + (tone ? ' atw-badge--' + tone : '') }, label)
    }

    function panelHead(title, hint) {
      return h(
        'div',
        { className: 'atw-panel-head' },
        h('span', { className: 'atw-panel-title' }, title),
        hint ? h('span', { className: 'atw-panel-hint', title: hint }, hint) : null,
      )
    }

    function kvRow(key, label, value, element) {
      return h(
        'div',
        { key, className: 'atw-kv' },
        h('span', { className: 'atw-kv-key' }, label),
        h('span', { className: 'atw-kv-value' }, element === undefined ? value : element),
      )
    }

    function bulletList(key, title, entries) {
      if (entries.length === 0) return null
      return h(
        'div',
        { key, className: 'atw-section' },
        h('div', { className: 'atw-section-title' }, title),
        h('ul', { className: 'atw-list' }, entries.map((entry, index) => h('li', { key: key + '-' + index }, entry))),
      )
    }

    function legendLine(key, text, modifier) {
      return h(
        'span',
        { key, className: 'atw-legend-item' },
        h('span', { className: 'atw-legend-line' + (modifier ? ' ' + modifier : '') }),
        text,
      )
    }

    // ---------------------------------------------------------------------
    // Panels
    // ---------------------------------------------------------------------

    function renderHeader(view, run, team) {
      const tr = view.tr
      const items = run ? normalizeRunItems(run) : []
      const counts = run && run.counts && typeof run.counts === 'object' ? run.counts : null
      const total = counts === null ? items.length : num(counts.total, items.length)
      const approvedFromCounts = counts === null ? Number.NaN : num(counts.approved, Number.NaN)
      const approved = Number.isFinite(approvedFromCounts) ? approvedFromCounts : items.filter((item) => item.status === 'approved').length
      const ratio = total > 0 ? Math.max(0, Math.min(100, (approved / total) * 100)) : 0
      const updated = view.lastUpdated > 0 ? tr('header.updated', { when: relativeTime(view.lastUpdated, view.now, tr) }) : tr('header.never')
      const runId = run && run.id ? str(run.id) : ''
      return h(
        'div',
        { className: 'atw-header' },
        h(
          'div',
          { className: 'atw-header-main' },
          h('div', { className: 'atw-title' }, tr('board.title')),
          h(
            'div',
            { className: 'atw-subtitle', title: run && run.objective ? str(run.objective) : undefined },
            run ? str(run.objective, tr('header.noRun')) : tr('header.noRun'),
          ),
        ),
        h(
          'div',
          { className: 'atw-header-side' },
          runId ? badge(tr('header.run', { id: runId }), 'idle', 'run-id') : null,
          run ? badge(phaseLabel(tr, run.phase), phaseTone(run.phase), 'phase') : null,
          run
            ? h(
                'span',
                { key: 'progress', className: 'atw-progress', title: tr('header.progress', { done: approved, total }) },
                h('span', { className: 'atw-meta' }, tr('header.progress', { done: approved, total })),
                h(
                  'span',
                  { className: 'atw-progress-track' },
                  h('span', { className: 'atw-progress-fill', style: { width: ratio + '%' } }),
                ),
              )
            : null,
          h('span', { key: 'updated', className: 'atw-meta' }, updated),
          h('span', { key: 'members', className: 'atw-meta' }, tr('header.members', { n: team.members.length })),
          view.paused ? badge(tr('header.paused'), 'warn', 'paused') : null,
          h('button', { key: 'refresh', className: 'atw-btn', type: 'button', onClick: view.actions.refresh }, tr('header.refresh')),
          h(
            'button',
            { key: 'pause', className: 'atw-btn', type: 'button', onClick: view.actions.togglePaused },
            view.paused ? tr('header.resume') : tr('header.pause'),
          ),
        ),
      )
    }

    function renderOfflineStrip(view) {
      if (!view.error) return null
      const tr = view.tr
      const detail = str(view.error.message)
      return h(
        'div',
        { className: 'atw-error-strip', role: 'alert' },
        h('span', { className: 'atw-error-text', title: detail }, tr('header.offline') + (detail ? ' · ' + detail : '')),
        h('button', { className: 'atw-btn', type: 'button', onClick: view.actions.refresh }, tr('error.retry')),
      )
    }

    /** @returns one small Git/PR badge (kept on the shared `atw-badge` scale). */
    function gitBadge(label, tone, key) {
      return h('span', { key, className: 'atw-badge atw-badge--git' + (tone ? ' atw-badge--' + tone : '') }, label)
    }

    /** @returns the compact Git/PR badge row of one flow card, or null. */
    function renderGitBadges(view, git) {
      if (git === null) return null
      const tr = view.tr
      const badges = []
      if (git.branch !== '') {
        badges.push(h('span', { key: 'branch', className: 'atw-badge atw-badge--git', title: git.branch }, tr('git.branch', { branch: git.branch })))
      }
      if (git.pushed) badges.push(gitBadge(tr('git.pushed'), 'success', 'pushed'))
      if (git.verify !== null) badges.push(gitBadge(git.verify.ok ? tr('git.verifyOk') : tr('git.verifyFail'), git.verify.ok ? 'success' : 'error', 'verify'))
      if (git.pr !== null) {
        const label = Number.isFinite(git.pr.number) ? tr('git.pr', { number: git.pr.number }) : tr('git.prUnknown')
        const clickable = git.pr.mode === 'gh' && git.pr.url !== ''
        badges.push(
          clickable
            ? h(
                'a',
                { key: 'pr', className: 'atw-badge atw-badge--git atw-badge--brand atw-badge--link', href: git.pr.url, target: '_blank', rel: 'noreferrer noopener', title: git.pr.url },
                label,
              )
            : h('span', { key: 'pr', className: 'atw-badge atw-badge--git', title: git.pr.mode === 'manual' ? tr('git.prManual') : git.pr.url }, label),
        )
      }
      if (Number.isFinite(git.mergedAt)) badges.push(gitBadge(tr('git.merged'), 'success', 'merged'))
      if (badges.length === 0) return null
      return h('div', { className: 'atw-card-git' }, badges)
    }

    /** @returns the drawer's plan-first block (docs/19 §4), or null without a plan. */
    function renderPlanSection(view, item) {
      const tr = view.tr
      const plan = item.plan
      if (plan === null) return null
      const blocks = [
        kvRow(
          'plan-status',
          tr('plan.status'),
          badge(plan.status === null ? tr('plan.pending') : planStatusLabel(tr, plan.status), plan.status === null ? 'idle' : PLAN_STATUS_TONES[plan.status] || 'idle'),
        ),
      ]
      if (plan.decidedBy !== '') blocks.push(kvRow('plan-decided-by', tr('plan.decidedBy'), plan.decidedBy))
      if (plan.reason !== '') blocks.push(kvRow('plan-reason', tr('plan.reason'), plan.reason))
      const lists = [
        bulletList('plan-steps', tr('plan.steps'), plan.steps),
        bulletList('plan-files', tr('plan.files'), plan.files),
        bulletList('plan-risks', tr('plan.risks'), plan.risks),
      ].filter((block) => block !== null)
      return h('div', { key: 'plan', className: 'atw-section' }, h('div', { className: 'atw-section-title' }, tr('plan.title')), blocks, lists)
    }

    /** @returns the drawer's Git/PR detail block, or null when the item has no git record. */
    function renderGitSection(view, item) {
      const tr = view.tr
      const git = item.git
      if (git === null) return null
      const rows = []
      if (git.branch !== '') rows.push(kvRow('git-branch', tr('git.branchLabel'), git.branch))
      if (git.base !== '') rows.push(kvRow('git-base', tr('git.base'), git.base))
      if (git.sha !== '') rows.push(kvRow('git-sha', tr('git.sha'), git.sha))
      if (git.remote !== '') rows.push(kvRow('git-remote', tr('git.remote'), git.remote))
      rows.push(kvRow('git-push', tr('git.pushState'), badge(git.pushed ? tr('git.pushed') : tr('git.notPushed'), git.pushed ? 'success' : 'idle')))
      rows.push(
        kvRow(
          'git-verify',
          tr('git.verifyState'),
          git.verify === null
            ? tr('git.verifyMissing')
            : h(
                'span',
                { className: 'atw-row' },
                badge(git.verify.ok ? tr('git.verifyOk') : tr('git.verifyFail'), git.verify.ok ? 'success' : 'error'),
                Number.isFinite(git.verify.at) ? h('span', { className: 'atw-muted' }, relativeTime(git.verify.at, view.now, tr)) : null,
              ),
        ),
      )
      if (git.pr !== null) {
        const label = Number.isFinite(git.pr.number) ? tr('git.pr', { number: git.pr.number }) : tr('git.prUnknown')
        rows.push(
          kvRow(
            'git-pr',
            label,
            h(
              'span',
              { className: 'atw-row' },
              git.pr.url !== ''
                ? h('a', { className: 'atw-link', href: git.pr.url, target: '_blank', rel: 'noreferrer noopener' }, git.pr.url)
                : tr('git.prManual'),
              git.pr.mode !== '' ? h('span', { className: 'atw-muted' }, git.pr.mode) : null,
              git.pr.status !== '' ? h('span', { className: 'atw-muted' }, git.pr.status) : null,
            ),
          ),
        )
      }
      if (git.prReview !== null) {
        rows.push(kvRow('git-pr-review', tr('git.prReview'), badge(str(git.prReview.verdict, tr('common.unknown')), 'idle')))
      }
      if (git.verify !== null && git.verify.results.length > 0) {
        rows.push(
          h(
            'div',
            { key: 'git-verify-results', className: 'atw-section' },
            git.verify.results.map((result, index) =>
              h(
                'div',
                { key: 'git-verify-' + index, className: 'atw-command' },
                h('span', { className: 'atw-command-text' }, str(result.command, tr('drawer.none'))),
                badge(
                  tr('drawer.exitCode') + ' ' + (Number.isFinite(result.exitCode) ? String(result.exitCode) : '-'),
                  result.exitCode === 0 ? 'success' : Number.isFinite(result.exitCode) ? 'error' : 'idle',
                ),
              ),
            ),
          ),
        )
      }
      if (Number.isFinite(git.mergedAt)) rows.push(kvRow('git-merged', tr('git.mergedAt'), relativeTime(git.mergedAt, view.now, tr)))
      return h('div', { key: 'git', className: 'atw-section' }, h('div', { className: 'atw-section-title' }, tr('git.title')), rows)
    }

    function renderItemCard(view, card) {
      const tr = view.tr
      const item = card.item
      const tone = statusTone(item.status)
      const reviews = item.reviews
      const selected = view.selectedItemId !== null && view.selectedItemId === item.id
      let className = 'atw-card atw-card--' + tone
      if (reviews.pendingReviewer !== '') className += ' atw-card--pending-review'
      if (selected) className += ' atw-card--selected'
      const claimBy = item.claim === null ? '' : item.claim.by
      const claimable = item.assignment === 'open' && claimBy === '' && item.status === 'pending'
      const proposalsOpen = Number.isFinite(item.openProposals) && item.openProposals > 0
      const memberCreated = item.origin === 'member'
      return h(
        'div',
        {
          key: card.key,
          className,
          role: 'button',
          tabIndex: 0,
          'aria-pressed': selected,
          title: item.subject,
          style: {
            left: card.x + 'px',
            top: card.y + 'px',
            width: FLOW.cardWidth + 'px',
            height: (Number.isFinite(card.height) ? card.height : FLOW.cardHeight) + 'px',
          },
          onClick: () => view.actions.toggleItem(item.id),
          onKeyDown: (event) => {
            if (event && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
              view.actions.toggleItem(item.id)
            }
          },
        },
        h(
          'div',
          { className: 'atw-card-head' },
          h('span', { className: 'atw-card-id' }, item.id),
          badge(statusLabel(tr, item.status), tone, 'status'),
        ),
        h('div', { className: 'atw-card-subject' }, str(item.subject, tr('drawer.none'))),
        h('div', { className: 'atw-card-meta' }, tr('flow.owner', { name: str(item.owner, tr('common.unknown')) })),
        renderGitBadges(view, item.git),
        h(
          'div',
          { className: 'atw-card-flags' },
          h('span', { key: 'round' }, tr('flow.round', { submitted: reviews.submittedRounds, max: reviews.maxRounds })),
          // docs/19 §5.2: plan-first state rides on the card; the rest of the
          // flags stay in the detail drawer (docs/16 §3 noise budget).
          item.plan !== null && item.plan.status !== null
            ? badge(planStatusLabel(tr, item.plan.status), PLAN_STATUS_TONES[item.plan.status] || 'idle', 'plan')
            : null,
          memberCreated
            ? h(
                'span',
                {
                  key: 'origin',
                  className: 'atw-badge atw-badge--member',
                  title: item.createdBy === '' ? undefined : tr('flow.createdBy', { name: item.createdBy }),
                },
                tr('flow.memberItem'),
              )
            : claimBy !== ''
              ? badge(tr('flow.claimed', { name: claimBy }), 'brand', 'claim')
              : claimable
                ? badge(tr('flow.openAssignment'), 'warn', 'open')
                : proposalsOpen
                  ? badge(tr('flow.proposalsOpen', { n: item.openProposals }), 'warn', 'proposals')
                  : null,
        ),
      )
    }

    function renderOpenQueueCard(view, entry) {
      const tr = view.tr
      const item = entry.item
      const subject = item === null ? '' : item.subject
      return h(
        'div',
        {
          key: entry.key,
          className: 'atw-open-card',
          role: 'button',
          tabIndex: 0,
          title: entry.id + (subject !== '' ? ' · ' + subject : ''),
          onClick: () => view.actions.toggleItem(entry.id),
          onKeyDown: (event) => {
            if (event && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
              view.actions.toggleItem(entry.id)
            }
          },
        },
        h('div', { className: 'atw-open-card-head' }, h('span', { className: 'atw-card-id' }, entry.id), badge(tr('flow.openAssignment'), 'warn', 'open')),
        h('div', { className: 'atw-open-card-subject' }, str(subject, tr('drawer.none'))),
        h('div', { className: 'atw-open-card-meta' }, tr('flow.owner', { name: tr('drawer.none') })),
      )
    }

    function renderFlowPanel(view, run) {
      const tr = view.tr
      const layout = computeFlowLayout(run)
      const body =
        layout.cards.length === 0
          ? h('div', { className: 'atw-muted' }, tr('flow.empty'))
          : h(
              'div',
              { className: 'atw-flow' },
              h(
                'div',
                { className: 'atw-flow-canvas', style: { width: layout.width + 'px', height: layout.height + 'px' } },
                h(
                  'svg',
                  {
                    className: 'atw-svg',
                    width: layout.width,
                    height: layout.height,
                    viewBox: '0 0 ' + layout.width + ' ' + layout.height,
                    'aria-hidden': true,
                  },
                  h(
                    'defs',
                    null,
                    h(
                      'marker',
                      {
                        id: view.markerId,
                        viewBox: '0 0 8 8',
                        refX: 7,
                        refY: 4,
                        markerWidth: 7,
                        markerHeight: 7,
                        orient: 'auto-start-reverse',
                      },
                      h('path', { className: 'atw-arrow', d: 'M0,0 L8,4 L0,8 Z' }),
                    ),
                  ),
                  layout.edges.map((edge) =>
                    h('path', { key: edge.key, className: 'atw-edge ' + edge.className, d: edge.d, markerEnd: 'url(#' + view.markerId + ')' }),
                  ),
                  layout.loops.map((loop) =>
                    h('path', { key: loop.key, className: 'atw-edge atw-edge--loop', d: loop.d, markerEnd: 'url(#' + view.markerId + ')' }),
                  ),
                  layout.loops.map((loop) =>
                    h('text', { key: loop.key + '-text', className: 'atw-loop-text', x: loop.labelX, y: loop.labelY }, loop.label),
                  ),
                ),
                layout.columns.map((column, index) =>
                  h(
                    'div',
                    {
                      key: 'wave-' + index,
                      className: 'atw-wave-label',
                      style: { left: FLOW.padX + index * (FLOW.cardWidth + FLOW.columnGap) + 'px', top: '3px' },
                    },
                    column.label > 0 ? tr('flow.wave', { n: column.label }) : tr('flow.waveUnknown'),
                  ),
                ),
                layout.cards.map((card) => renderItemCard(view, card)),
              ),
            )
      const collaboration = normalizeCollaboration(run)
      const byId = new Map()
      for (const card of layout.cards) if (!byId.has(card.item.id)) byId.set(card.item.id, card.item)
      const queue = collaboration.openQueue.map((id, index) => ({ key: 'open-' + index + '-' + id, id, item: byId.get(id) || null }))
      const lane =
        queue.length === 0
          ? null
          : h(
              'div',
              { className: 'atw-open-queue' },
              h('div', { className: 'atw-open-queue-label' }, tr('flow.openQueue')),
              h('div', { className: 'atw-open-queue-cards' }, queue.map((entry) => renderOpenQueueCard(view, entry))),
            )
      return h(
        'section',
        { className: 'atw-panel atw-panel--flow' },
        panelHead(tr('flow.title'), tr('flow.hint')),
        h('div', { className: 'atw-panel-body' }, h('div', { className: 'atw-flow-stack' }, lane, body)),
      )
    }

    function renderTopologyPanel(view, team, run) {
      const tr = view.tr
      const items = run ? normalizeRunItems(run) : []
      const topology = computeTopology(team, items, normalizeCollaboration(run))
      const hint =
        tr('topology.members') +
        ' ' +
        topology.participantCount +
        ' · ' +
        tr('topology.items') +
        ' ' +
        items.length +
        (topology.idleCount > 0 ? ' · ' + tr('topology.idle', { n: topology.idleCount }) : '')
      const empty = team.members.length === 0 && items.length === 0
      return h(
        'section',
        { className: 'atw-panel' },
        panelHead(tr('topology.title'), hint),
        h(
          'div',
          { className: 'atw-panel-body' },
          h(
            'div',
            { className: 'atw-topo-canvas' },
            topology.edges.length > 0 || topology.peerEdges.length > 0
              ? h(
                  'svg',
                  { className: 'atw-topo-svg', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': true },
                  topology.peerEdges.map((edge) =>
                    h(
                      'path',
                      {
                        key: edge.key,
                        className: 'atw-edge atw-edge--peer',
                        d: edge.d,
                        style: { strokeWidth: edge.width, opacity: edge.opacity },
                        vectorEffect: 'non-scaling-stroke',
                      },
                      h('title', null, edge.from + ' ↔ ' + edge.to + ' · ' + edge.count),
                    ),
                  ),
                  topology.edges.map((edge) =>
                    h('path', { key: edge.key, className: 'atw-edge ' + edge.className, d: edge.d, vectorEffect: 'non-scaling-stroke' }),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'atw-node atw-node--lead', style: { left: topology.lead.x + '%', top: topology.lead.y + '%' } },
              h('span', { className: 'atw-dot' }),
              h('span', null, tr('topology.lead')),
              topology.lead.name ? h('span', { className: 'atw-node-sub', title: topology.lead.name }, topology.lead.name) : null,
            ),
            topology.memberNodes.map((node) =>
              h(
                'div',
                {
                  key: node.key,
                  className: 'atw-node atw-node--member atw-node--st-' + str(node.member.status, 'inactive'),
                  style: { left: node.x + '%', top: node.y + '%' },
                  role: 'button',
                  tabIndex: 0,
                  title: node.member.name + ' · ' + memberStatusLabel(tr, node.member.status),
                  onClick: () => view.actions.openMember(node.member.name),
                  onKeyDown: (event) => {
                    if (event && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault()
                      view.actions.openMember(node.member.name)
                    }
                  },
                },
                h('span', { className: 'atw-dot' }),
                h('span', null, node.member.name),
                badge(contextLabel(tr, node.member.context), node.member.context === 'fork' ? 'warn' : 'idle', 'ctx'),
                node.stop === null ? null : h('span', { key: 'stop', className: 'atw-node-stop', title: tr('member.stop.pending') }),
              ),
            ),
            topology.idleNode === null
              ? null
              : h(
                  'div',
                  {
                    key: 'idle',
                    className: 'atw-node atw-node--idle',
                    style: { left: topology.idleNode.x + '%', top: topology.idleNode.y + '%' },
                    title: tr('topology.idleNames', { names: topology.idleNode.names }),
                  },
                  h('span', { className: 'atw-dot' }),
                  h('span', null, tr('topology.idle', { n: topology.idleNode.count })),
                ),
            topology.itemNodes.map((node) =>
              h(
                'div',
                {
                  key: node.key,
                  className: 'atw-node atw-node--item atw-node--tone-' + statusTone(node.item.status),
                  style: { left: node.x + '%', top: node.y + '%', maxWidth: topology.itemWidth + '%' },
                  title: node.item.id + ' · ' + statusLabel(tr, node.item.status) + (node.item.subject ? ' · ' + node.item.subject : ''),
                },
                h('span', { className: 'atw-dot' }),
                h('span', null, node.item.id),
              ),
            ),
            empty ? h('div', { className: 'atw-topo-empty' }, tr('topology.empty')) : null,
          ),
          h(
            'div',
            { className: 'atw-legend' },
            legendLine('legend-lead', tr('topology.leadEdge')),
            legendLine('legend-owns', tr('topology.ownsEdge'), 'atw-legend-line--owns'),
            legendLine('legend-reviews', tr('topology.reviewsEdge'), 'atw-legend-line--review'),
            topology.hasPeerEdges ? legendLine('legend-peer', tr('topology.peerEdge'), 'atw-legend-line--peer') : null,
          ),
        ),
      )
    }

    function renderEventsPanel(view, run) {
      const tr = view.tr
      const all = toArray(run && run.events).map(normalizeEvent)
      const filtered = view.filter === 'all' ? all : all.filter((event) => eventFamily(event.type) === view.filter)
      const rows = filtered.slice(-EVENTS_LIMIT).reverse()
      const head = h(
        'div',
        { className: 'atw-panel-head' },
        h('span', { className: 'atw-panel-title' }, tr('events.title'), h('span', { className: 'atw-panel-hint' }, ' ' + tr('events.count', { n: rows.length }))),
        h(
          'div',
          { className: 'atw-filters' },
          EVENT_FAMILIES.map((family) =>
            h(
              'button',
              {
                key: family,
                type: 'button',
                className: 'atw-filter' + (view.filter === family ? ' atw-filter--active' : ''),
                onClick: () => view.actions.setFilter(family),
              },
              tr('events.filter.' + family),
            ),
          ),
        ),
      )
      const body =
        rows.length === 0
          ? h('div', { className: 'atw-panel-body' }, h('div', { className: 'atw-muted' }, tr('events.empty')))
          : h(
              'div',
              { className: 'atw-panel-body atw-panel-body--flush' },
              h(
                'div',
                { className: 'atw-events' },
                rows.map((event, index) =>
                  h(
                    'div',
                    {
                      key: 'event-' + index,
                      className: 'atw-event atw-event--' + eventFamily(event.type),
                    },
                    h('span', { className: 'atw-event-time' }, relativeTime(event.at, view.now, tr)),
                    h('span', { className: 'atw-event-type' }, event.type),
                    h('span', { className: 'atw-event-detail', title: event.detail }, event.detail),
                    event.actor ? h('span', { className: 'atw-event-actor' }, tr('events.actor', { name: event.actor })) : null,
                  ),
                ),
              ),
            )
      return h('section', { className: 'atw-panel' }, head, body)
    }

    function renderPathRow(view, key, label, path, copyKey) {
      const tr = view.tr
      if (!path) {
        return h(
          'div',
          { key, className: 'atw-kv' },
          h('span', { className: 'atw-kv-key' }, label),
          h('span', { className: 'atw-kv-value atw-muted' }, tr('gate.noReportPath')),
        )
      }
      const copied = view.copiedPath !== null && view.copiedPath === copyKey
      return h(
        'div',
        { key, className: 'atw-kv atw-path' },
        h('span', { className: 'atw-kv-key' }, label),
        h('span', { className: 'atw-path-text', title: path }, path),
        h('button', { className: 'atw-btn', type: 'button', onClick: () => view.actions.copy(path, copyKey) }, copied ? tr('gate.copied') : tr('gate.copy')),
      )
    }

    function renderGatePanel(view, run) {
      const tr = view.tr
      const gate = normalizeGate(run)
      const artifacts = normalizeArtifacts(run)
      const rows = []
      if (gate === null) {
        rows.push(h('div', { key: 'none', className: 'atw-muted' }, tr('gate.none')))
      } else {
        rows.push(
          h(
            'div',
            { key: 'overall', className: 'atw-row' },
            badge(gate.pass ? tr('gate.pass') : tr('gate.fail'), gate.pass ? 'success' : 'error', 'overall'),
            gate.evaluatedAt ? h('span', { className: 'atw-meta' }, tr('gate.evaluatedAt', { when: relativeTime(parseTime(gate.evaluatedAt), view.now, tr) })) : null,
          ),
        )
        for (const entry of gate.itemGates) {
          rows.push(
            h(
              'div',
              { key: 'gate-' + entry.id, className: 'atw-gate-item' },
              h(
                'div',
                { className: 'atw-gate-head' },
                h('span', { className: 'atw-gate-id' }, entry.id),
                badge(entry.pass ? tr('gate.pass') : tr('gate.fail'), entry.pass ? 'success' : 'error'),
                entry.overridden ? badge(tr('gate.overridden'), 'warn') : null,
                entry.waived.length > 0 ? badge(tr('gate.waived', { n: entry.waived.length }), 'warn') : null,
              ),
              entry.overrideReason ? h('div', { className: 'atw-gate-line atw-gate-line--warn' }, entry.overrideReason) : null,
              entry.failures.map((failure, index) =>
                h('div', { key: 'failure-' + index, className: 'atw-gate-line atw-gate-line--error' }, tr('gate.failures') + ': ' + failure),
              ),
              entry.warnings.map((warning, index) =>
                h('div', { key: 'warning-' + index, className: 'atw-gate-line atw-gate-line--warn' }, tr('gate.warnings') + ': ' + warning),
              ),
            ),
          )
        }
        if (gate.teamFailures.length > 0) {
          rows.push(
            h(
              'div',
              { key: 'team-failures', className: 'atw-gate-item' },
              h('div', { className: 'atw-gate-head' }, h('span', { className: 'atw-gate-id' }, tr('gate.teamFailures'))),
              gate.teamFailures.map((failure, index) =>
                h('div', { key: 'team-failure-' + index, className: 'atw-gate-line atw-gate-line--error' }, failure),
              ),
            ),
          )
        }
        if (gate.blockingEscalations.length > 0) {
          rows.push(
            h(
              'div',
              { key: 'blocking', className: 'atw-gate-item' },
              h('div', { className: 'atw-gate-head' }, h('span', { className: 'atw-gate-id' }, tr('gate.blockingEscalations'))),
              h('div', { className: 'atw-row' }, gate.blockingEscalations.map((id, index) => badge(id, 'error', 'blocking-' + index))),
            ),
          )
        }
      }
      rows.push(renderPathRow(view, 'report-path', tr('gate.reportPath'), artifacts.reportPath, 'report:' + artifacts.reportPath))
      if (artifacts.statePath) rows.push(renderPathRow(view, 'state-path', tr('gate.statePath'), artifacts.statePath, 'state:' + artifacts.statePath))
      return h(
        'section',
        { className: 'atw-panel' },
        panelHead(tr('gate.title'), null),
        h('div', { className: 'atw-panel-body' }, h('div', { className: 'atw-gate' }, rows)),
      )
    }

    function renderEscalationsPanel(view, run) {
      const tr = view.tr
      const escalations = toArray(run && run.escalations).map(normalizeEscalation)
      const body =
        escalations.length === 0
          ? h('div', { className: 'atw-muted' }, tr('escalations.empty'))
          : h(
              'div',
              { className: 'atw-esc-list' },
              escalations
                .slice()
                .reverse()
                .map((escalation, index) =>
                  h(
                    'div',
                    {
                      key: 'esc-' + escalation.id + '-' + index,
                      className: 'atw-esc' + (escalation.blocking && !escalation.resolved ? ' atw-esc--blocking' : ''),
                    },
                    h(
                      'div',
                      { className: 'atw-esc-head' },
                      badge(escalationKindLabel(tr, escalation.kind), escalation.blocking ? 'error' : 'idle'),
                      escalation.blocking ? badge(tr('escalations.blocking'), 'error') : null,
                      badge(escalation.resolved ? tr('escalations.resolved') : tr('escalations.unresolved'), escalation.resolved ? 'success' : escalation.blocking ? 'error' : 'warn'),
                      escalation.itemId ? h('span', { className: 'atw-meta' }, tr('escalations.item', { id: escalation.itemId })) : null,
                    ),
                    escalation.subject ? h('div', { className: 'atw-esc-subject', title: escalation.subject }, escalation.subject) : null,
                    escalation.detail ? h('div', { className: 'atw-esc-detail' }, escalation.detail) : null,
                    escalation.createdBy ? h('div', { className: 'atw-esc-detail' }, tr('escalations.by', { name: escalation.createdBy })) : null,
                    escalation.resolution
                      ? h('div', { className: 'atw-esc-resolution' }, tr('escalations.resolution') + ': ' + escalation.resolution)
                      : null,
                  ),
                ),
            )
      return h('section', { className: 'atw-panel' }, panelHead(tr('escalations.title'), null), h('div', { className: 'atw-panel-body' }, body))
    }

    function renderMemberLines(view, team, collaboration) {
      const tr = view.tr
      if (team.members.length === 0) return h('div', { className: 'atw-muted' }, tr('common.none'))
      const pendingStops = new Set()
      for (const stop of toArray(isRecord(collaboration) ? collaboration.stops : [])) {
        if (stop.status === 'pending' && stop.target !== '') pendingStops.add(stop.target)
      }
      return h(
        'div',
        { className: 'atw-member-list' },
        team.members.map((member, index) =>
          h(
            'button',
            {
              key: 'member-line-' + index,
              type: 'button',
              className: 'atw-member-line atw-member-line--button',
              onClick: () => view.actions.openMember(member.name),
            },
            h('span', { className: 'atw-node-sub', title: member.name }, member.name),
            h('span', { className: 'atw-muted' }, member.role),
            badge(memberStatusLabel(tr, member.status), memberTone(member.status)),
            badge(contextLabel(tr, member.context), member.context === 'fork' ? 'warn' : 'idle'),
            pendingStops.has(member.name) ? h('span', { key: 'stop', className: 'atw-node-stop', title: tr('member.stop.pending') }) : null,
          ),
        ),
      )
    }

    function renderEmptyState(view, team, diagnostics) {
      const tr = view.tr
      return h(
        'div',
        { className: 'atw-empty' },
        h('div', { className: 'atw-empty-title' }, tr('empty.title')),
        h('div', { className: 'atw-muted' }, tr('empty.hint')),
        diagnostics.boardSource === 'missing' ? h('div', { className: 'atw-muted' }, tr('empty.boardMissing')) : null,
        h('div', { className: 'atw-section-title' }, tr('empty.teamTitle')),
        renderMemberLines(view, team, null),
      )
    }

    function renderDiagnostics(view, diagnostics) {
      if (diagnostics.warnings.length === 0) return null
      return h(
        'div',
        { className: 'atw-section' },
        h('div', { className: 'atw-section-title' }, view.tr('diagnostics.title')),
        h('ul', { className: 'atw-list' }, diagnostics.warnings.map((warning, index) => h('li', { key: 'diag-' + index }, warning))),
      )
    }

    function renderErrorCard(tr, detail) {
      return h(
        'div',
        { className: 'atw-error-card' },
        h('div', { className: 'atw-error-title' }, tr('error.title')),
        detail ? h('div', { className: 'atw-error-detail' }, detail) : null,
        h('div', { className: 'atw-muted' }, tr('error.hint')),
      )
    }

    /**
     * @returns true when a channel body would exceed the four-line clamp.
     *   A visual-cell estimate keeps the board layout-free: CJK glyphs take two
     *   cells, and the toggle only needs to be roughly right for long bodies.
     */
    function channelNeedsToggle(text) {
      if (text === '') return false
      let visualLines = 0
      for (const line of text.split('\n')) {
        let cells = 0
        for (const char of line) cells += char.codePointAt(0) > 0x2e80 ? 2 : 1
        visualLines += Math.max(1, Math.ceil(cells / CHANNEL_LINE_CELLS))
      }
      return visualLines > CHANNEL_CLAMP_LINES
    }

    /** @returns a stable expand/collapse key for one channel entry. */
    function channelEntryKey(entry, index) {
      if (entry.id !== '') return 'id:' + entry.id
      if (Number.isFinite(entry.at)) return 'at:' + entry.at + ':' + entry.from
      return 'idx:' + index
    }

    function renderChannelRow(view, entry, index, options) {
      const tr = view.tr
      const to = entry.to === 'team' || entry.to === '' ? tr('collab.team') : entry.to
      const reply = entry.replyTo === '' ? undefined : tr('channel.replyTo', { id: entry.replyTo })
      const showRef = !(options !== undefined && options.hideRef === true)
      const text = str(entry.text)
      const messageKey = channelEntryKey(entry, index)
      const expandable = channelNeedsToggle(text)
      const expanded = toArray(view.expandedMessages).indexOf(messageKey) !== -1
      return h(
        'div',
        { key: 'channel-' + index + '-' + entry.id, className: 'atw-channel-item', title: reply },
        h(
          'div',
          { className: 'atw-channel-head' },
          badge(channelKindLabel(tr, entry.kind), CHANNEL_KIND_TONES[entry.kind] || 'idle', 'kind'),
          h('span', { className: 'atw-channel-from' }, tr('collab.fromTo', { from: entry.from, to })),
          showRef && entry.itemId !== ''
            ? h(
                'button',
                { key: 'ref', type: 'button', className: 'atw-channel-ref', title: entry.itemId, onClick: () => view.actions.toggleItem(entry.itemId) },
                entry.itemId,
              )
            : null,
          h('span', { className: 'atw-channel-time' }, relativeTime(entry.at, view.now, tr)),
        ),
        h('div', { className: 'atw-channel-text' + (expanded ? ' atw-channel-text--expanded' : '') }, text),
        expandable
          ? h(
              'button',
              { key: 'toggle', type: 'button', className: 'atw-channel-toggle', onClick: () => view.actions.toggleMessage(messageKey) },
              expanded ? tr('channel.collapse') : tr('channel.expand'),
            )
          : null,
      )
    }

    /** Newest-first channel stream with kind filters (docs/12 §6.1). */
    function renderChannelPanel(view, run) {
      const tr = view.tr
      const collaboration = normalizeCollaboration(run)
      const ordered = collaboration.channel.slice().sort((left, right) => {
        const a = Number.isFinite(left.at) ? left.at : 0
        const b = Number.isFinite(right.at) ? right.at : 0
        return a - b
      })
      const capped = ordered.slice(-CHANNEL_LIMIT).reverse()
      const active = view.channelFilter
      const filtered = active === 'all' ? capped : capped.filter((entry) => entry.kind === active)
      const head = h(
        'div',
        { className: 'atw-panel-head' },
        h(
          'span',
          { className: 'atw-panel-title' },
          tr('channel.title'),
          h('span', { className: 'atw-panel-hint' }, ' ' + tr('channel.count', { n: filtered.length })),
        ),
        h(
          'div',
          { className: 'atw-filters' },
          CHANNEL_FILTERS.map((family) =>
            h(
              'button',
              {
                key: family,
                type: 'button',
                className: 'atw-filter' + (active === family ? ' atw-filter--active' : ''),
                onClick: () => view.actions.setChannelFilter(family),
              },
              tr('channel.filter.' + family),
            ),
          ),
        ),
      )
      const body =
        filtered.length === 0
          ? h('div', { className: 'atw-panel-body' }, h('div', { className: 'atw-muted' }, tr('channel.empty')))
          : h(
              'div',
              { className: 'atw-panel-body atw-panel-body--flush' },
              h('div', { className: 'atw-channel' }, filtered.map((entry, index) => renderChannelRow(view, entry, index))),
            )
      return h('section', { className: 'atw-panel' }, head, body)
    }

    function renderProposalCard(view, proposal, index) {
      const tr = view.tr
      const tally = proposal.tally
      const blocking = proposal.status === 'open' && PROPOSAL_BLOCKING_KINDS.indexOf(proposal.kind) !== -1
      const deadline = deadlineLabel(proposal.deadline, view.now, tr)
      const quorumShown = Number.isFinite(proposal.quorum) && proposal.quorum > 0
      const overdue =
        Number.isFinite(proposal.deadline) && proposal.deadline > 0 && proposal.deadline < view.now && proposal.autoResolved !== true
      return h(
        'div',
        { key: 'proposal-' + index + '-' + proposal.id, className: 'atw-proposal' + (blocking ? ' atw-proposal--blocking' : '') },
        h(
          'div',
          { className: 'atw-proposal-head' },
          badge(proposalKindLabel(tr, proposal.kind), 'idle', 'kind'),
          badge(proposalStatusLabel(tr, proposal.status), PROPOSAL_STATUS_TONES[proposal.status] || 'idle', 'status'),
          proposal.autoResolved ? h('span', { key: 'auto', className: 'atw-badge atw-badge--auto' }, tr('proposal.autoResolved')) : null,
          overdue ? h('span', { key: 'overdue', className: 'atw-badge atw-badge--warn' }, tr('proposal.overdue')) : null,
          blocking ? badge(tr('proposal.blocking'), 'warn', 'blocking') : null,
          proposal.itemId !== ''
            ? h(
                'button',
                { key: 'ref', type: 'button', className: 'atw-channel-ref', title: proposal.itemId, onClick: () => view.actions.toggleItem(proposal.itemId) },
                proposal.itemId,
              )
            : null,
          h('span', { className: 'atw-proposal-by' }, tr('proposal.by', { name: proposal.by })),
          h('span', { className: 'atw-channel-time' }, relativeTime(proposal.at, view.now, tr)),
          deadline !== ''
            ? h('span', { key: 'deadline', className: 'atw-proposal-deadline', title: absoluteTime(proposal.deadline) }, deadline)
            : null,
        ),
        h('div', { className: 'atw-proposal-text' }, proposal.text),
        h(
          'div',
          { className: 'atw-proposal-tally' },
          badge(tr('proposal.vote.yes') + ' ' + tally.yes, 'success', 'yes'),
          badge(tr('proposal.vote.no') + ' ' + tally.no, 'error', 'no'),
          badge(tr('proposal.vote.abstain') + ' ' + tally.abstain, 'idle', 'abstain'),
          h('span', { className: 'atw-proposal-meta' }, tr('proposal.affected', { affected: tally.affected, total: tally.total })),
          quorumShown ? h('span', { key: 'quorum', className: 'atw-proposal-meta' }, tr('proposal.quorum', { n: proposal.quorum })) : null,
        ),
        proposal.votes.length === 0
          ? h('div', { className: 'atw-proposal-meta' }, tr('proposal.noVotes'))
          : h(
              'div',
              { className: 'atw-proposal-voters' },
              proposal.votes.map((vote, voterIndex) => badge(vote.by, VOTE_TONES[vote.vote] || 'idle', 'voter-' + voterIndex)),
            ),
        proposal.resolution !== '' ? h('div', { className: 'atw-proposal-resolution' }, tr('proposal.resolution') + ': ' + proposal.resolution) : null,
      )
    }

    /** Newest-first proposal list with tallies and voters (docs/12 §6.2). */
    function renderProposalsPanel(view, run) {
      const tr = view.tr
      const collaboration = normalizeCollaboration(run)
      const ordered = collaboration.proposals.slice().sort((left, right) => {
        const a = Number.isFinite(left.at) ? left.at : 0
        const b = Number.isFinite(right.at) ? right.at : 0
        return a - b
      })
      const proposals = ordered.slice(-PROPOSAL_LIMIT).reverse()
      const body =
        proposals.length === 0
          ? h('div', { className: 'atw-panel-body' }, h('div', { className: 'atw-muted' }, tr('proposal.empty')))
          : h(
              'div',
              { className: 'atw-panel-body' },
              h('div', { className: 'atw-proposal-list' }, proposals.map((proposal, index) => renderProposalCard(view, proposal, index))),
            )
      return h('section', { className: 'atw-panel' }, panelHead(tr('proposal.title'), tr('proposal.count', { n: proposals.length })), body)
    }

    /** Drawer block: this item's thread, review invitations, handoffs, proposals. */
    function renderCollabSection(view, item, collaboration) {
      const tr = view.tr
      const blocks = []
      const thread = item.thread.slice(-MAX_RECORDS)
      if (thread.length > 0) {
        blocks.push(
          h(
            'div',
            { key: 'thread', className: 'atw-section' },
            h('div', { className: 'atw-section-title' }, tr('drawer.thread')),
            h('div', { className: 'atw-collab-list' }, thread.map((entry, index) => renderChannelRow(view, entry, index, { hideRef: true }))),
          ),
        )
      }
      const reviewRequests =
        item.reviewRequests.length > 0
          ? item.reviewRequests
          : toArray(collaboration.pendingReviews)
              .filter((pending) => pending.itemId !== '' && pending.itemId === item.id)
              .map((pending) => ({ by: pending.requestedBy, at: pending.at, reviewer: pending.reviewer, status: 'open', respondedAt: Number.NaN, response: '' }))
      if (reviewRequests.length > 0) {
        blocks.push(
          h(
            'div',
            { key: 'review-requests', className: 'atw-section' },
            h('div', { className: 'atw-section-title' }, tr('drawer.reviewRequests')),
            h(
              'div',
              { className: 'atw-collab-list' },
              reviewRequests.map((request, index) =>
                h(
                  'div',
                  { key: 'review-request-' + index, className: 'atw-collab-row' },
                  h(
                    'div',
                    { className: 'atw-collab-head' },
                    h(
                      'span',
                      { className: 'atw-collab-text' },
                      tr('collab.fromTo', { from: request.by, to: request.reviewer === '' ? tr('drawer.review.openInvite') : request.reviewer }),
                    ),
                    badge(reviewRequestStatusLabel(tr, request.status), REVIEW_REQUEST_TONES[request.status] || 'idle'),
                    h('span', { className: 'atw-collab-sub' }, relativeTime(request.at, view.now, tr)),
                  ),
                  request.response !== '' ? h('div', { className: 'atw-collab-sub' }, request.response) : null,
                ),
              ),
            ),
          ),
        )
      }
      const handoffs =
        item.handoffs.length > 0
          ? item.handoffs
          : toArray(collaboration.handoffs).filter((handoff) => handoff.itemId !== '' && handoff.itemId === item.id)
      if (handoffs.length > 0) {
        blocks.push(
          h(
            'div',
            { key: 'handoffs', className: 'atw-section' },
            h('div', { className: 'atw-section-title' }, tr('drawer.handoffs')),
            h(
              'div',
              { className: 'atw-collab-list' },
              handoffs.map((handoff, index) =>
                h(
                  'div',
                  { key: 'handoff-' + index, className: 'atw-collab-row' },
                  h(
                    'div',
                    { className: 'atw-collab-head' },
                    h('span', { className: 'atw-collab-text' }, tr('collab.fromTo', { from: handoff.by, to: handoff.to })),
                    badge(handoffStatusLabel(tr, handoff.status), HANDOFF_TONES[handoff.status] || 'idle'),
                    h('span', { className: 'atw-collab-sub' }, relativeTime(handoff.at, view.now, tr)),
                  ),
                  handoff.reason !== '' ? h('div', { className: 'atw-collab-sub' }, tr('drawer.handoff.reason') + ': ' + handoff.reason) : null,
                ),
              ),
            ),
          ),
        )
      }
      const related = collaboration.proposals.filter((proposal) => proposal.itemId !== '' && proposal.itemId === item.id)
      if (related.length > 0) {
        blocks.push(
          h(
            'div',
            { key: 'related-proposals', className: 'atw-section' },
            h('div', { className: 'atw-section-title' }, tr('drawer.relatedProposals')),
            h(
              'div',
              { className: 'atw-collab-list' },
              related.map((proposal, index) =>
                h(
                  'div',
                  { key: 'related-proposal-' + index, className: 'atw-collab-row' },
                  h(
                    'div',
                    { className: 'atw-collab-head' },
                    badge(proposalKindLabel(tr, proposal.kind), 'idle'),
                    badge(proposalStatusLabel(tr, proposal.status), PROPOSAL_STATUS_TONES[proposal.status] || 'idle'),
                    h(
                      'span',
                      { className: 'atw-collab-sub' },
                      tr('proposal.vote.yes') +
                        ' ' +
                        proposal.tally.yes +
                        ' · ' +
                        tr('proposal.vote.no') +
                        ' ' +
                        proposal.tally.no +
                        ' · ' +
                        tr('proposal.vote.abstain') +
                        ' ' +
                        proposal.tally.abstain,
                    ),
                  ),
                  h('div', { className: 'atw-collab-text' }, proposal.text),
                  proposal.resolution !== ''
                    ? h('div', { className: 'atw-collab-sub' }, tr('proposal.resolution') + ': ' + proposal.resolution)
                    : null,
                ),
              ),
            ),
          ),
        )
      }
      if (blocks.length === 0) {
        return h(
          'div',
          { key: 'collab', className: 'atw-section' },
          h('div', { className: 'atw-section-title' }, tr('drawer.collab')),
          h('div', { className: 'atw-muted' }, tr('drawer.noCollab')),
        )
      }
      return h('div', { key: 'collab', className: 'atw-section' }, h('div', { className: 'atw-section-title' }, tr('drawer.collab')), blocks)
    }

    function renderDrawer(view, item, collaboration) {
      const tr = view.tr
      const report = normalizeReport(item.report)
      const sections = []
      const meta = [
        kvRow('subject', tr('drawer.subject'), str(item.subject, tr('drawer.none'))),
        kvRow('owner', tr('drawer.owner'), str(item.owner, tr('common.unknown'))),
        kvRow('role', tr('drawer.role'), str(item.role, tr('common.unknown'))),
        kvRow(
          'origin',
          tr('drawer.origin'),
          item.origin === 'member'
            ? tr('flow.memberItem') + (item.createdBy === '' ? '' : ' · ' + item.createdBy)
            : tr('drawer.originPlan'),
        ),
        kvRow('assignment', tr('drawer.assignment'), tr('drawer.assignment.' + item.assignment, undefined, item.assignment)),
        kvRow(
          'claim',
          tr('drawer.claim'),
          item.claim === null
            ? tr('common.none')
            : item.claim.by + (Number.isFinite(item.claim.at) ? ' · ' + relativeTime(item.claim.at, view.now, tr) : ''),
        ),
        kvRow('status', tr('drawer.status'), badge(statusLabel(tr, item.status), statusTone(item.status))),
        kvRow('wave', tr('drawer.wave'), item.wave > 0 ? String(item.wave) : tr('drawer.none')),
        kvRow('reviewers', tr('drawer.reviewers'), item.reviewers.length > 0 ? item.reviewers.join(', ') : tr('drawer.none')),
        kvRow('writeScopes', tr('drawer.writeScopes'), item.writeScopes.length > 0 ? item.writeScopes.join(', ') : tr('drawer.none')),
        kvRow('blockedBy', tr('drawer.blockedBy'), item.blockedBy.length > 0 ? item.blockedBy.join(', ') : tr('drawer.none')),
      ]
      if (item.task) {
        meta.push(
          kvRow(
            'task',
            tr('drawer.task', { id: str(item.task.id, '?'), revision: str(item.task.revision, '?') }),
            str(item.task.status, tr('common.unknown')),
          ),
        )
      } else {
        meta.push(kvRow('task', tr('drawer.noTask'), tr('common.none')))
      }
      sections.push(h('div', { key: 'meta', className: 'atw-section' }, meta))
      const planSection = renderPlanSection(view, item)
      if (planSection !== null) sections.push(planSection)
      const gitSection = renderGitSection(view, item)
      if (gitSection !== null) sections.push(gitSection)
      sections.push(bulletList('dod', tr('drawer.dod'), item.definitionOfDone))
      if (item.override !== null) {
        sections.push(
          h(
            'div',
            { key: 'override', className: 'atw-section' },
            h('div', { className: 'atw-section-title' }, tr('drawer.override')),
            h('div', { className: 'atw-pre' }, item.override),
          ),
        )
      }
      const reportRows = []
      if (report === null) {
        reportRows.push(h('div', { key: 'no-report', className: 'atw-muted' }, tr('drawer.noReport')))
      } else {
        if (report.summary) {
          reportRows.push(
            h(
              'div',
              { key: 'summary', className: 'atw-kv' },
              h('span', { className: 'atw-kv-key' }, tr('drawer.summary')),
              h('span', { className: 'atw-kv-value' }, report.summary),
            ),
          )
        }
        if (report.submittedAt) {
          reportRows.push(
            h(
              'div',
              { key: 'submitted', className: 'atw-muted' },
              tr('drawer.submittedAt', { when: relativeTime(parseTime(report.submittedAt), view.now, tr) }),
            ),
          )
        }
        if (report.files.length > 0) {
          reportRows.push(
            h(
              'div',
              { key: 'files', className: 'atw-section' },
              h('div', { className: 'atw-section-title' }, tr('drawer.files')),
              h('ul', { className: 'atw-list' }, report.files.map((file, index) => h('li', { key: 'file-' + index }, file))),
            ),
          )
        }
        if (report.commands.length > 0) {
          reportRows.push(
            h(
              'div',
              { key: 'commands', className: 'atw-section' },
              h('div', { className: 'atw-section-title' }, tr('drawer.commands')),
              h(
                'div',
                { className: 'atw-list' },
                report.commands.map((command, index) =>
                  h(
                    'div',
                    { key: 'command-' + index, className: 'atw-command' },
                    h('span', { className: 'atw-command-text' }, str(command.command, tr('drawer.none'))),
                    badge(
                      tr('drawer.exitCode') + ' ' + (Number.isFinite(command.exitCode) ? String(command.exitCode) : '-'),
                      command.exitCode === 0 ? 'success' : Number.isFinite(command.exitCode) ? 'error' : 'idle',
                    ),
                  ),
                ),
              ),
            ),
          )
        }
        reportRows.push(bulletList('evidence', tr('drawer.evidence'), report.evidence))
        reportRows.push(bulletList('risks', tr('drawer.risks'), report.risks))
        reportRows.push(bulletList('questions', tr('drawer.openQuestions'), report.openQuestions))
        if (report.deviation) {
          reportRows.push(
            h(
              'div',
              { key: 'deviation', className: 'atw-section' },
              h('div', { className: 'atw-section-title' }, tr('drawer.deviation')),
              h('div', { className: 'atw-pre' }, report.deviation),
            ),
          )
        }
      }
      sections.push(h('div', { key: 'report', className: 'atw-section' }, h('div', { className: 'atw-section-title' }, tr('drawer.report')), reportRows))

      const reviews = item.reviews
      const reviewRows = [
        h(
          'div',
          { key: 'rounds', className: 'atw-muted' },
          tr('drawer.rounds', { submitted: reviews.submittedRounds, rework: reviews.reworkRounds, max: reviews.maxRounds }),
        ),
      ]
      if (reviews.pendingReviewer !== '') {
        reviewRows.push(h('div', { key: 'pending', className: 'atw-card-pending' }, tr('drawer.pendingReviewer', { name: reviews.pendingReviewer })))
      }
      if (reviews.verdicts.length > 0) {
        reviewRows.push(
          h(
            'div',
            { key: 'verdicts', className: 'atw-row' },
            reviews.verdicts.map((verdict, index) => {
              const value = verdict && typeof verdict === 'object' ? verdict : {}
              const label = str(value.verdict, tr('common.unknown'))
              const round = num(value.round, 0)
              return badge((round > 0 ? 'R' + round + ' ' : '') + label, VERDICT_TONES[label] || 'idle', 'verdict-' + index)
            }),
          ),
        )
      }
      const records = reviews.records.map(normalizeRecord)
      if (records.length === 0) {
        reviewRows.push(h('div', { key: 'no-records', className: 'atw-muted' }, tr('drawer.noFindings')))
      }
      for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
        const record = records[recordIndex]
        const findings = record.findings
        reviewRows.push(
          h(
            'div',
            { key: 'record-' + recordIndex + '-' + record.round, className: 'atw-record' },
            h(
              'div',
              { className: 'atw-record-head' },
              badge('R' + record.round, 'idle'),
              h('span', { className: 'atw-kv-value' }, record.reviewer || tr('common.unknown')),
              h('span', { className: 'atw-muted' }, tr('drawer.verdict') + ':'),
              badge(str(record.verdict, tr('common.unknown')), VERDICT_TONES[record.verdict] || 'idle'),
            ),
            record.summary ? h('div', { className: 'atw-record-summary' }, record.summary) : null,
            h(
              'div',
              { className: 'atw-section' },
              h('div', { className: 'atw-section-title' }, tr('drawer.findings') + (findings.length > 0 ? ' · ' + findings.length : '')),
              findings.length === 0
                ? h('div', { className: 'atw-muted' }, tr('drawer.noFindings'))
                : findings.map((finding, index) =>
                    h(
                      'div',
                      { key: 'finding-' + index, className: 'atw-finding' },
                      h(
                        'div',
                        { className: 'atw-row' },
                        badge(str(finding.severity, tr('drawer.severity')), SEVERITY_TONES[finding.severity] || 'idle'),
                        finding.id ? h('span', { className: 'atw-muted' }, tr('drawer.finding', { id: finding.id })) : null,
                        finding.file
                          ? h('span', { className: 'atw-muted' }, finding.file + (Number.isFinite(finding.line) ? ':' + finding.line : ''))
                          : null,
                        h('span', { className: 'atw-muted atw-right' }, tr('drawer.resolution') + ': ' + resolutionLabel(tr, finding.resolution)),
                      ),
                      h('div', { className: 'atw-finding-claim' }, finding.claim),
                      finding.suggestion ? h('div', { className: 'atw-muted' }, finding.suggestion) : null,
                    ),
                  ),
            ),
          ),
        )
      }
      sections.push(h('div', { key: 'reviews', className: 'atw-section' }, h('div', { className: 'atw-section-title' }, tr('drawer.reviews')), reviewRows))

      const repairEntries = item.repairLog.slice(-MAX_RECORDS)
      const repairRows = []
      if (repairEntries.length === 0) {
        repairRows.push(h('div', { key: 'no-repair', className: 'atw-muted' }, tr('drawer.noRepairLog')))
      }
      for (const entry of repairEntries) {
        const value = entry && typeof entry === 'object' ? entry : {}
        const lines = []
        if (value.at) lines.push(tr('drawer.repair.at') + ': ' + str(value.at))
        if (value.action) lines.push(tr('drawer.repair.action') + ': ' + str(value.action))
        if (value.owner) lines.push(tr('drawer.repair.owner') + ': ' + str(value.owner))
        if (value.reason) lines.push(tr('drawer.repair.reason') + ': ' + str(value.reason))
        repairRows.push(
          h(
            'div',
            { key: 'repair-' + repairRows.length, className: 'atw-pre' },
            lines.length > 0 ? lines.join('\n') : stringify(value),
          ),
        )
      }
      sections.push(h('div', { key: 'repair', className: 'atw-section' }, h('div', { className: 'atw-section-title' }, tr('drawer.repairLog')), repairRows))
      sections.push(renderCollabSection(view, item, isRecord(collaboration) ? collaboration : { proposals: [] }))

      return h(
        'aside',
        { className: 'atw-drawer', role: 'dialog', 'aria-label': tr('drawer.title'), 'aria-modal': false },
        h(
          'div',
          { className: 'atw-drawer-head' },
          h(
            'div',
            { className: 'atw-drawer-heading' },
            h('div', { className: 'atw-drawer-title' }, item.id + ' · ' + str(item.subject, tr('drawer.title'))),
            h('div', { className: 'atw-row' }, badge(statusLabel(tr, item.status), statusTone(item.status)), item.reviewers.length > 0 ? h('span', { className: 'atw-meta' }, item.reviewers.join(', ')) : null),
          ),
          h('button', { className: 'atw-btn', type: 'button', onClick: view.actions.closeItem }, tr('drawer.close')),
        ),
        h('div', { className: 'atw-drawer-body' }, sections),
      )
    }

    /** Best-effort serialization of one unknown repair entry (never throws). */
    function stringify(value) {
      try {
        return JSON.stringify(value)
      } catch (ignored) {
        return String(value)
      }
    }

    /** @returns a stable expand/collapse key for one transcript message. */
    function transcriptMessageKey(message, index) {
      return Number.isFinite(message.seq) ? 'seq:' + message.seq : 'idx:' + index
    }

    /** @returns true when one transcript body is likely to exceed three lines. */
    function transcriptNeedsToggle(text) {
      if (text === '') return false
      let visualLines = 0
      for (const line of text.split('\n')) {
        let cells = 0
        for (const char of line) cells += char.codePointAt(0) > 0x2e80 ? 2 : 1
        visualLines += Math.max(1, Math.ceil(cells / CHANNEL_LINE_CELLS))
      }
      return visualLines > 3
    }

    /** @returns the normalized `run.usage` block (docs/19 §6), or null. */
    function normalizeUsage(raw) {
      if (!isRecord(raw)) return null
      const bucket = (value) =>
        isRecord(value)
          ? {
              input: num(value.uncachedInputTokens, 0),
              output: num(value.outputTokens, 0),
              cacheRead: num(value.cacheReadTokens, 0),
              cacheWrite: num(value.cacheWriteTokens, 0),
            }
          : null
      const members = []
      if (isRecord(raw.members)) {
        for (const name of Object.keys(raw.members)) {
          const entry = bucket(raw.members[name])
          if (entry !== null) members.push({ name: name, input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite })
        }
      }
      members.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      const totals = bucket(raw.totals)
      if (totals === null && members.length === 0) return null
      return { capturedAt: parseTime(raw.capturedAt), members, totals }
    }

    /** @returns a grouping-separated integer (1234567 -> "1,234,567"). */
    function formatCount(value) {
      return String(Math.round(num(value, 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** @returns local HH:mm:ss for one timestamp, or ''. */
    function clockTime(atMs) {
      if (!Number.isFinite(atMs) || atMs <= 0) return ''
      try {
        const date = new Date(atMs)
        const pad = (value) => (value < 10 ? '0' + value : String(value))
        return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
      } catch (ignored) {
        return ''
      }
    }

    /** @returns the token usage panel (docs/19 §6): numbers only, never faked. */
    function renderUsagePanel(view, run) {
      const tr = view.tr
      const usage = normalizeUsage(run === null || run === undefined ? null : run.usage)
      const captured = usage !== null ? clockTime(usage.capturedAt) : ''
      const head = panelHead(tr('board.usage'), captured === '' ? null : tr('board.usageCapturedAt', { time: captured }))
      if (usage === null) {
        return h(
          'section',
          { className: 'atw-panel atw-usage' },
          head,
          h('div', { className: 'atw-panel-body' }, h('div', { className: 'atw-muted' }, tr('board.usageEmpty'))),
        )
      }
      const columns = ['input', 'output', 'cacheRead', 'cacheWrite']
      const row = (key, className, name, values, raw) =>
        h(
          'div',
          { key: key, className: className },
          h('span', { key: 'name', className: 'atw-usage-name', title: name }, name),
          columns.map((column) => h('span', { key: column, className: 'atw-usage-cell' }, raw === true ? values[column] : formatCount(values[column]))),
        )
      const lines = [
        row('usage-head', 'atw-usage-line atw-usage-head', '', { input: tr('board.usageInput'), output: tr('board.usageOutput'), cacheRead: tr('board.usageCacheRead'), cacheWrite: tr('board.usageCacheWrite') }, true),
      ]
      for (const member of usage.members) lines.push(row('usage-' + member.name, 'atw-usage-line', member.name, member))
      if (usage.totals !== null) lines.push(row('usage-totals', 'atw-usage-line atw-usage-totals', tr('board.usageTotals'), usage.totals))
      return h('section', { className: 'atw-panel atw-usage' }, head, h('div', { className: 'atw-panel-body' }, h('div', { className: 'atw-usage-table' }, lines)))
    }

    /** @returns the composer status line: sending / sent / error / empty. */
    function memberStatusLine(view) {
      const tr = view.tr
      const state = view.memberSendState
      if (state === 'sending') return h('span', { key: 'member-status', className: 'atw-member-status' }, tr('member.sending'))
      if (state === 'sent') return h('span', { key: 'member-status', className: 'atw-member-status atw-member-status--ok' }, tr('member.sent'))
      if (isRecord(state) && state.error !== undefined) {
        return h('span', { key: 'member-status', className: 'atw-member-status atw-member-status--error' }, tr('member.error', { message: state.error }))
      }
      if (isRecord(state) && state.empty === true) {
        return h('span', { key: 'member-status', className: 'atw-member-status atw-member-status--error' }, tr('member.emptyMessage'))
      }
      return null
    }

    /**
     * Member panel (docs/19 §5.2): the roster data is always available from the
     * snapshot, while the richer view comes from the member route.
     */
    function renderMemberDrawer(view, team, collaboration) {
      const tr = view.tr
      const name = view.memberName
      if (name === null) return null
      const roster = team.members.find((member) => member.name === name) || null
      const detail = view.memberView
      const known = roster !== null || detail !== null
      const runStops = toArray(isRecord(collaboration) ? collaboration.stops : []).filter((stop) => stop.target === name)
      const runStop = runStops.length === 0 ? null : runStops[runStops.length - 1]
      const stop =
        detail !== null && detail.stop !== null
          ? detail.stop
          : runStop === null
            ? null
            : { id: runStop.id, status: runStop.status, at: runStop.at, reason: runStop.reason, mode: runStop.mode }
      const sections = []

      if (!known && view.memberLoading) {
        sections.push(h('div', { key: 'member-loading', className: 'atw-muted' }, tr('member.loading')))
      }
      if (view.memberError !== null) {
        sections.push(
          h(
            'div',
            { key: 'member-error', className: 'atw-member-error' },
            tr('member.fetchError') + (view.memberError.message ? ': ' + view.memberError.message : ''),
          ),
        )
      }
      if (!known && !view.memberLoading) {
        sections.push(h('div', { key: 'member-unknown', className: 'atw-muted' }, tr('member.unknown')))
      }

      const role = detail !== null && detail.role !== '' ? detail.role : roster === null ? '' : roster.role
      const status = detail !== null && detail.status !== '' ? detail.status : roster === null ? '' : roster.status
      const context = detail !== null && detail.context !== '' ? detail.context : roster === null ? '' : roster.context
      const identityRows = [kvRow('member-name', tr('member.title'), name)]
      if (role !== '') identityRows.push(kvRow('member-role', tr('member.role'), role))
      if (status !== '') identityRows.push(kvRow('member-status', tr('member.status'), badge(memberStatusLabel(tr, status), memberTone(status))))
      if (context !== '') identityRows.push(kvRow('member-context', tr('member.context'), badge(contextLabel(tr, context), context === 'fork' ? 'warn' : 'idle')))
      sections.push(h('div', { key: 'member-identity', className: 'atw-section' }, identityRows))

      sections.push(
        h(
          'div',
          { key: 'member-stop', className: 'atw-section' },
          h('div', { className: 'atw-section-title' }, tr('member.stopState')),
          stop === null
            ? h('div', { className: 'atw-muted' }, tr('member.noStop'))
            : h(
                'div',
                { className: 'atw-row' },
                badge(stopStatusLabel(tr, stop.status), STOP_STATUS_TONES[stop.status] || 'idle'),
                stop.mode !== '' ? h('span', { className: 'atw-muted' }, stop.mode) : null,
                stop.reason !== '' ? h('span', { className: 'atw-member-text' }, stop.reason) : null,
              ),
        ),
      )

      const plan = detail === null ? null : detail.plan
      sections.push(
        h(
          'div',
          { key: 'member-plan', className: 'atw-section' },
          h('div', { className: 'atw-section-title' }, tr('member.plan')),
          plan === null
            ? h('div', { className: 'atw-muted' }, tr('member.noPlan'))
            : h(
                'div',
                { className: 'atw-row' },
                badge(planStatusLabel(tr, plan.status), PLAN_STATUS_TONES[plan.status] || 'idle'),
                plan.itemId !== '' ? h('span', { className: 'atw-muted' }, plan.itemId) : null,
              ),
        ),
      )

      if (detail !== null) {
        sections.push(
          h(
            'div',
            { key: 'member-items', className: 'atw-section' },
            h('div', { className: 'atw-section-title' }, tr('member.items')),
            detail.currentItems.length === 0
              ? h('div', { className: 'atw-muted' }, tr('member.noItems'))
              : detail.currentItems.map((item, index) =>
                  h(
                    'div',
                    { key: 'member-item-' + index, className: 'atw-member-item' },
                    h('span', { className: 'atw-card-id' }, item.id),
                    h('span', { className: 'atw-member-text' }, item.subject),
                    item.status !== '' ? badge(statusLabel(tr, item.status), statusTone(item.status)) : null,
                    item.role !== '' ? h('span', { className: 'atw-muted' }, item.role) : null,
                  ),
                ),
          ),
        )
        sections.push(
          h(
            'div',
            { key: 'member-activity', className: 'atw-section' },
            h('div', { className: 'atw-section-title' }, tr('member.activity')),
            detail.recentActivity.length === 0
              ? h('div', { className: 'atw-muted' }, tr('member.noActivity'))
              : detail.recentActivity.map((event, index) =>
                  h(
                    'div',
                    { key: 'member-event-' + index, className: 'atw-member-event' },
                    h('span', { className: 'atw-muted' }, relativeTime(event.at, view.now, tr)),
                    h('span', { className: 'atw-muted' }, event.type),
                    h('span', { className: 'atw-member-text' }, event.detail),
                  ),
                ),
          ),
        )
        sections.push(
          h(
            'div',
            { key: 'member-channel', className: 'atw-section' },
            h('div', { className: 'atw-section-title' }, tr('member.channel')),
            detail.channel.length === 0
              ? h('div', { className: 'atw-muted' }, tr('member.noChannel'))
              : detail.channel.map((entry, index) =>
                  h(
                    'div',
                    { key: 'member-message-' + index, className: 'atw-member-message' },
                    h(
                      'div',
                      { className: 'atw-row' },
                      badge(channelKindLabel(tr, entry.kind), CHANNEL_KIND_TONES[entry.kind] || 'idle'),
                      h('span', { className: 'atw-muted' }, entry.from + ' → ' + (entry.to === 'team' || entry.to === '' ? tr('collab.team') : entry.to)),
                      h('span', { className: 'atw-channel-time' }, relativeTime(entry.at, view.now, tr)),
                    ),
                    h('div', { className: 'atw-member-channel-text' }, entry.text),
                  ),
                ),
          ),
        )
        const transcript = detail.transcript
        const transcriptTitle =
          transcript.truncated && transcript.messages.length > 0
            ? tr('member.transcript') + ' · ' + tr('member.transcriptTruncated', { n: transcript.messages.length })
            : tr('member.transcript')
        let transcriptBody
        if (!transcript.available) {
          transcriptBody = h(
            'div',
            { key: 'member-transcript-unavailable', className: 'atw-muted', title: transcript.error !== '' ? transcript.error : undefined },
            tr('member.transcriptUnavailable'),
          )
        } else if (transcript.messages.length === 0) {
          transcriptBody = h('div', { key: 'member-transcript-empty', className: 'atw-muted' }, tr('member.transcriptEmpty'))
        } else {
          transcriptBody = h(
            'div',
            { key: 'member-transcript-list', className: 'atw-member-transcript-list' },
            transcript.messages.map((message, index) => {
              const messageKey = transcriptMessageKey(message, index)
              const expanded = toArray(view.expandedTranscript).indexOf(messageKey) !== -1
              const expandable = transcriptNeedsToggle(message.text)
              return h(
                'div',
                {
                  key: 'member-transcript-' + index,
                  className: 'atw-member-transcript-item atw-member-transcript-item--button' + (expanded ? ' atw-member-transcript-item--expanded' : ''),
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => view.actions.toggleTranscript(messageKey),
                  onKeyDown: (event) => {
                    if (event && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault()
                      view.actions.toggleTranscript(messageKey)
                    }
                  },
                },
                h(
                  'div',
                  { className: 'atw-member-transcript-head' },
                  badge(transcriptRoleLabel(tr, message.role), TRANSCRIPT_ROLE_TONES[message.role] || 'idle'),
                  Number.isFinite(message.seq) ? h('span', { className: 'atw-muted' }, '#' + message.seq) : null,
                  expandable
                    ? h(
                        'span',
                        { key: 'toggle', className: 'atw-member-transcript-toggle' },
                        expanded ? tr('member.transcriptCollapse') : tr('member.transcriptExpand'),
                      )
                    : null,
                ),
                h('div', { className: 'atw-member-transcript-text' + (expanded ? ' atw-member-transcript-text--expanded' : '') }, message.text),
              )
            }),
          )
        }
        sections.push(
          h('div', { key: 'member-transcript', className: 'atw-section atw-member-transcript' }, h('div', { className: 'atw-section-title' }, transcriptTitle), transcriptBody),
        )
        sections.push(
          h(
            'div',
            { key: 'member-role-def', className: 'atw-section' },
            h('div', { className: 'atw-section-title' }, tr('member.roleDefinition')),
            detail.roleDefinition === null
              ? h('div', { className: 'atw-muted' }, tr('member.noRoleDefinition'))
              : h(
                  'div',
                  { className: 'atw-member-role' },
                  detail.roleDefinition.role !== '' ? h('div', { className: 'atw-row' }, badge(detail.roleDefinition.role, 'brand')) : null,
                  detail.roleDefinition.provider !== '' ? kvRow('member-provider', tr('member.provider'), detail.roleDefinition.provider) : null,
                  detail.roleDefinition.prompt !== ''
                    ? h(
                        'div',
                        { className: 'atw-member-role' },
                        h('div', { className: 'atw-kv-key' }, tr('member.prompt')),
                        h('div', { className: 'atw-member-prompt' }, detail.roleDefinition.prompt),
                      )
                    : null,
                ),
          ),
        )
      }

      if (known) {
        sections.push(
          h(
            'div',
            { key: 'member-composer', className: 'atw-member-composer' },
            h('div', { className: 'atw-section-title' }, tr('member.message')),
            h('input', {
              className: 'atw-member-input',
              type: 'text',
              value: view.memberMessage,
              placeholder: tr('member.messagePlaceholder'),
              onChange: (event) => view.actions.setMemberMessage(event && event.target ? event.target.value : ''),
            }),
            h(
              'div',
              { className: 'atw-row' },
              h(
                'button',
                { className: 'atw-btn atw-member-send', type: 'button', onClick: () => view.actions.sendMemberMessage() },
                view.memberSendState === 'sending' ? tr('member.sending') : tr('member.send'),
              ),
              memberStatusLine(view),
            ),
          ),
        )
      }

      return h(
        'aside',
        { className: 'atw-member', role: 'dialog', 'aria-label': tr('member.title'), 'aria-modal': false },
        h(
          'div',
          { className: 'atw-member-head' },
          h(
            'div',
            { className: 'atw-member-heading' },
            h('div', { className: 'atw-member-title' }, tr('member.title') + ' · ' + name),
            h('div', { className: 'atw-muted' }, role),
          ),
          h('button', { className: 'atw-btn', type: 'button', onClick: () => view.actions.closeMember() }, tr('member.close')),
        ),
        h('div', { className: 'atw-member-body' }, sections),
      )
    }

    function renderBoard(view, snapshot) {
      const tr = view.tr
      const team = normalizeTeam(snapshot)
      const diagnostics = normalizeDiagnostics(snapshot)
      const run = snapshot && typeof snapshot === 'object' && snapshot.run && typeof snapshot.run === 'object' ? snapshot.run : null
      const content = [renderHeader(view, run, team)]
      const offline = renderOfflineStrip(view)
      if (offline !== null) content.push(offline)
      if (run === null) {
        content.push(renderEmptyState(view, team, diagnostics))
        content.push(renderTopologyPanel(view, team, run))
        if (view.memberName !== null) content.push(renderMemberDrawer(view, team, null))
        const notes = renderDiagnostics(view, diagnostics)
        if (notes !== null) content.push(notes)
        return h('div', { className: 'atw-scroll' }, content)
      }
      const collaboration = normalizeCollaboration(run)
      content.push(h('div', { className: 'atw-main' }, renderFlowPanel(view, run), renderTopologyPanel(view, team, run)))
      content.push(h('div', { className: 'atw-collab' }, renderChannelPanel(view, run), renderProposalsPanel(view, run)))
      content.push(h('div', { className: 'atw-usage-wrap' }, renderUsagePanel(view, run)))
      content.push(
        h(
          'div',
          { className: 'atw-lower' },
          renderEventsPanel(view, run),
          renderGatePanel(view, run),
          renderEscalationsPanel(view, run),
        ),
      )
      const notes = renderDiagnostics(view, diagnostics)
      if (notes !== null) content.push(notes)
      const items = normalizeRunItems(run)
      const selected = view.selectedItemId === null ? null : items.find((item) => item.id === view.selectedItemId) || null
      if (selected !== null) content.push(renderDrawer(view, selected, collaboration))
      if (view.memberName !== null) content.push(renderMemberDrawer(view, team, collaboration))
      return h('div', { className: 'atw-scroll' }, content)
    }

    // ---------------------------------------------------------------------
    // Error boundary: catches a child crash so the slot never renders blank
    // ---------------------------------------------------------------------

    class BoardBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        if (typeof console !== 'undefined' && console !== null && typeof console.error === 'function') {
          console.error('[agent-team-workflow] board render failed', error)
        }
      }

      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    // ---------------------------------------------------------------------
    // The view: polling store lives in component state (docs/09 §4)
    // ---------------------------------------------------------------------

    let markerSequence = 0

    function nextMarkerId() {
      markerSequence += 1
      return 'atw-flow-arrow-' + String(markerSequence)
    }

    function DashboardView(props) {
      const source = props && typeof props === 'object' ? props : {}
      const sessionId = source.sessionId === null || source.sessionId === undefined ? '' : String(source.sessionId)
      const tr = makeTr(source.t)

      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [lastUpdated, setLastUpdated] = React.useState(0)
      const [paused, setPaused] = React.useState(false)
      const [selectedItemId, setSelectedItemId] = React.useState(null)
      const [filter, setFilter] = React.useState('all')
      const [channelFilter, setChannelFilter] = React.useState('all')
      const [expandedMessages, setExpandedMessages] = React.useState([])
      const [expandedTranscript, setExpandedTranscript] = React.useState([])
      const [memberName, setMemberName] = React.useState(null)
      const [memberView, setMemberView] = React.useState(null)
      const [memberError, setMemberError] = React.useState(null)
      const [memberLoading, setMemberLoading] = React.useState(false)
      const [memberMessage, setMemberMessage] = React.useState('')
      const [memberSendState, setMemberSendState] = React.useState(null)
      const [memberReload, setMemberReload] = React.useState(0)
      const [copiedPath, setCopiedPath] = React.useState(null)

      /** Newest snapshot, so event handlers never read a stale closure. */
      const snapshotRef = React.useRef(null)
      /** Current in-flight poll, so a refresh can supersede it. */
      const loadRef = React.useRef(null)
      /** Marker-id seat: stable per mount, unique across mounted boards. */
      const markerRef = React.useRef(null)
      const copyTimerRef = React.useRef(null)
      /** Guards against a second POST while the first message is in flight. */
      const memberSendRef = React.useRef(null)
      /** Board root, used to reach the conversation scrollport on mount. */
      const rootRef = React.useRef(null)
      if (markerRef.current === null) markerRef.current = nextMarkerId()

      // A View switch reuses the conversation scrollport, which keeps the chat
      // scroll offset; without this the board would mount scrolled out of view.
      React.useEffect(() => {
        const node = rootRef.current
        if (node === null || node === undefined || node.parentElement === null) return
        let cursor = node.parentElement
        while (cursor !== null && cursor !== undefined) {
          const style = typeof getComputedStyle === 'function' ? getComputedStyle(cursor) : null
          const overflowY = style === null || style === undefined ? '' : style.overflowY
          if ((overflowY === 'auto' || overflowY === 'scroll') && cursor.scrollHeight > cursor.clientHeight) {
            cursor.scrollTop = 0
            return
          }
          cursor = cursor.parentElement
        }
      }, [])

      React.useEffect(() => {
        if (sessionId === '') return undefined
        let disposed = false
        let timer = null
        let controller = null

        const load = async (force) => {
          if (disposed) return
          if (!force && paused) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          if (controller !== null) {
            try {
              controller.abort()
            } catch (ignored) {
              /* already settled */
            }
          }
          controller = new AbortController()
          const signal = controller.signal
          try {
            const url = SNAPSHOT_PATH + '?session=' + encodeURIComponent(sessionId)
            const response = await fetch(url, {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
              signal,
            })
            if (!response || response.ok !== true) {
              throw new Error('HTTP ' + String(response && response.status !== undefined ? response.status : '?'))
            }
            const data = await response.json()
            if (disposed) return
            if (!data || typeof data !== 'object' || data.ok !== true) {
              throw new Error(str(data && data.error, 'snapshot unavailable'))
            }
            snapshotRef.current = data
            setSnapshot(data)
            setError(null)
            setLastUpdated(Date.now())
          } catch (cause) {
            if (disposed) return
            if (cause && cause.name === 'AbortError') return
            setError({ message: messageOf(cause) })
          }
        }

        loadRef.current = () => {
          void load(true)
        }
        void load(false)
        timer = setInterval(() => {
          void load(false)
        }, POLL_MS)
        const onVisibilityChange = () => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load(false)
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibilityChange)
        }
        return () => {
          disposed = true
          loadRef.current = null
          if (timer !== null) clearInterval(timer)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibilityChange)
          }
          if (controller !== null) {
            try {
              controller.abort()
            } catch (ignored) {
              /* already settled */
            }
          }
          controller = null
        }
      }, [sessionId, paused])

      // The member view is not part of the snapshot, so it is fetched from the
      // member route and refreshed on every poll tick while the drawer is open.
      React.useEffect(() => {
        if (memberName === null || sessionId === '') return undefined
        let disposed = false
        setMemberLoading(true)
        const url = MEMBER_PATH + '?session=' + encodeURIComponent(sessionId) + '&name=' + encodeURIComponent(memberName)
        fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response || response.ok !== true) {
              throw new Error('HTTP ' + String(response && response.status !== undefined ? response.status : '?'))
            }
            return response.json()
          })
          .then((data) => {
            if (disposed) return
            if (!data || typeof data !== 'object' || data.ok !== true || !isRecord(data.member)) {
              throw new Error(str(data && data.error, 'member view unavailable'))
            }
            setMemberView(normalizeMemberView(data.member))
            setMemberError(null)
            setMemberLoading(false)
          })
          .catch((cause) => {
            if (disposed) return
            if (cause && cause.name === 'AbortError') return
            setMemberError({ message: messageOf(cause) })
            setMemberLoading(false)
          })
        return () => {
          disposed = true
        }
      }, [memberName, sessionId, lastUpdated, memberReload])

      React.useEffect(() => {
        if (selectedItemId === null && memberName === null) return undefined
        const onKeyDown = (event) => {
          if (!event || event.key !== 'Escape') return
          setSelectedItemId(null)
          setMemberName(null)
          setMemberView(null)
          setMemberError(null)
          setMemberLoading(false)
          setMemberMessage('')
          setMemberSendState(null)
          setExpandedTranscript([])
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKeyDown)
        }
        return () => {
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('keydown', onKeyDown)
          }
        }
      }, [selectedItemId, memberName])

      React.useEffect(
        () => () => {
          if (copyTimerRef.current !== null) {
            window.clearTimeout(copyTimerRef.current)
            copyTimerRef.current = null
          }
        },
        [],
      )

      const actions = {
        refresh: () => {
          if (loadRef.current !== null) loadRef.current()
        },
        togglePaused: () => setPaused((value) => !value),
        toggleItem: (id) => {
          setSelectedItemId((value) => (value === id ? null : id))
          setMemberName(null)
          setMemberView(null)
          setMemberError(null)
          setMemberLoading(false)
        },
        openMember: (name) => {
          const value = str(name)
          if (value === '') return
          setSelectedItemId(null)
          setMemberName(value)
          setMemberView(null)
          setMemberError(null)
          setMemberLoading(true)
          setMemberMessage('')
          setMemberSendState(null)
          setExpandedTranscript([])
        },
        closeMember: () => {
          setMemberName(null)
          setMemberView(null)
          setMemberError(null)
          setMemberLoading(false)
          setMemberMessage('')
          setMemberSendState(null)
          setExpandedTranscript([])
        },
        setMemberMessage: (value) => setMemberMessage(str(value)),
        sendMemberMessage: () => {
          const name = memberName
          const message = str(memberMessage).trim()
          if (name === null) return
          // Empty input never reaches the route: it answers 400 by contract.
          if (message === '') {
            setMemberSendState({ empty: true })
            return
          }
          if (memberSendRef.current !== null) return
          memberSendRef.current = true
          setMemberSendState('sending')
          const url = MEMBER_PATH + '?session=' + encodeURIComponent(sessionId)
          fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ name, message }),
          })
            .then((response) => {
              if (response && response.ok === true) return response.json()
              const status = response && response.status !== undefined ? String(response.status) : '?'
              if (response && typeof response.json === 'function') {
                return response.json().then(
                  (data) => {
                    throw new Error(str(data && data.error, 'HTTP ' + status))
                  },
                  () => {
                    throw new Error('HTTP ' + status)
                  },
                )
              }
              throw new Error('HTTP ' + status)
            })
            .then((data) => {
              if (!data || typeof data !== 'object' || data.ok !== true) {
                throw new Error(str(data && data.error, 'the message was not delivered'))
              }
              memberSendRef.current = null
              setMemberSendState('sent')
              setMemberMessage('')
              setMemberReload((value) => value + 1)
            })
            .catch((cause) => {
              memberSendRef.current = null
              if (cause && cause.name === 'AbortError') return
              setMemberSendState({ error: messageOf(cause) })
            })
        },
        closeItem: () => setSelectedItemId(null),
        setFilter: (value) => setFilter(value),
        setChannelFilter: (value) => setChannelFilter(value),
        toggleMessage: (key) =>
          setExpandedMessages((value) => (value.indexOf(key) === -1 ? value.concat([key]) : value.filter((entry) => entry !== key))),
        toggleTranscript: (key) =>
          setExpandedTranscript((value) => (value.indexOf(key) === -1 ? value.concat([key]) : value.filter((entry) => entry !== key))),
        copy: (text, key) => {
          const value = str(text)
          if (value === '') return
          const markCopied = () => {
            setCopiedPath(key)
            if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
            copyTimerRef.current = window.setTimeout(() => {
              copyTimerRef.current = null
              setCopiedPath(null)
            }, 1500)
          }
          try {
            const clipboard = typeof navigator !== 'undefined' && navigator !== null ? navigator.clipboard : undefined
            if (!clipboard || typeof clipboard.writeText !== 'function') return
            const pending = clipboard.writeText(value)
            if (pending && typeof pending.then === 'function') pending.then(markCopied, () => undefined)
            else markCopied()
          } catch (ignored) {
            /* clipboard unavailable in this context */
          }
        },
      }

      const data = snapshot !== null ? snapshot : snapshotRef.current
      const view = {
        tr,
        paused,
        filter,
        channelFilter,
        expandedMessages,
        expandedTranscript,
        memberName,
        memberView,
        memberError,
        memberLoading,
        memberMessage,
        memberSendState,
        selectedItemId,
        copiedPath,
        lastUpdated,
        error,
        now: Date.now(),
        markerId: markerRef.current,
        actions,
      }

      let content
      try {
        content = sessionId === '' ? renderErrorCard(tr, tr('error.noSession')) : renderBoard(view, data)
      } catch (cause) {
        content = renderErrorCard(tr, messageOf(cause))
      }
      return h(
        'div',
        { className: 'atw-root', 'data-atw-board': 'v1', ref: rootRef },
        h('style', { key: 'atw-style', dangerouslySetInnerHTML: { __html: STYLES } }),
        h(BoardBoundary, { fallback: renderErrorCard(tr, tr('error.boundary')) }, content),
      )
    }

    // ---------------------------------------------------------------------
    // Registration (docs/09 §4): everything is unwound on plugin unload
    // ---------------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-team-workflow: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'agent-team-workflow',
            order: 30,
            locale: NS,
            label: () => t('view.label'),
            inject: (sessionId) => ({ sessionId }),
          },
          DashboardView,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
