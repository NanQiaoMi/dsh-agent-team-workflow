/**
 * Configuration resolution for the Agent Team Workflow plugin.
 *
 * The plugin deliberately exports no Cordis `Config` (schemastery) so that it
 * has zero package dependencies and installs as a plain linked directory. All
 * defaults and range checks therefore live here, and the effective settings are
 * reported by `team_flow_status` so a deployment can verify what it got.
 */

/** Re-exported so callers can read the workflow version from either module. */
export { WORKFLOW_VERSION } from './workflow.js'

/** Named workflow presets selectable via `team_flow_plan { preset }`. */
export const WORKFLOW_PRESET_NAMES = Object.freeze(['fast-fix', 'feature', 'pr-review', 'deep-audit'])

/** Preset overrides for run settings and per-item defaults. */
export const WORKFLOW_PRESETS = Object.freeze({
  'fast-fix': Object.freeze({
    settings: Object.freeze({
      maxReviewRounds: 1,
      defaultReviewDepth: 'light',
      thinkingDefaultBias: 'low',
      strictReviewRubric: false,
      parallelReviews: true,
    }),
    itemDefaults: Object.freeze({
      complexity: 'trivial',
      reviewDepth: 'light',
    }),
  }),
  feature: Object.freeze({
    settings: Object.freeze({
      maxReviewRounds: 2,
      defaultReviewDepth: 'auto',
      thinkingDefaultBias: 'low',
      strictReviewRubric: false,
      parallelReviews: true,
    }),
    itemDefaults: Object.freeze({
      complexity: 'normal',
      reviewDepth: 'auto',
    }),
  }),
  'pr-review': Object.freeze({
    settings: Object.freeze({
      maxReviewRounds: 2,
      defaultReviewDepth: 'standard',
      thinkingDefaultBias: 'high',
      strictReviewRubric: true,
      parallelReviews: true,
    }),
    itemDefaults: Object.freeze({
      complexity: 'normal',
      reviewDepth: 'auto',
    }),
  }),
  'deep-audit': Object.freeze({
    settings: Object.freeze({
      maxReviewRounds: 3,
      defaultReviewDepth: 'deep',
      thinkingDefaultBias: 'high',
      strictReviewRubric: true,
      parallelReviews: true,
    }),
    itemDefaults: Object.freeze({
      complexity: 'complex',
      reviewDepth: 'deep',
    }),
  }),
})

/**
 * Apply an optional named workflow preset to run settings and normalized items
 * without overriding explicit per-item complexity or review_depth values.
 *
 * @param {object} effectiveSettings
 * @param {Array<object>} items
 * @param {Array<object>} rawItems
 * @param {string|null|undefined} presetName
 * @returns {{ preset: string|null, settings: object, items: Array<object> }}
 */
export function applyWorkflowPreset(effectiveSettings, items, rawItems = [], presetName = null) {
  const normalized = typeof presetName === 'string' ? presetName.trim().toLowerCase() : ''
  if (normalized.length === 0) {
    return { preset: null, settings: effectiveSettings, items }
  }
  const spec = WORKFLOW_PRESETS[normalized]
  if (spec === undefined) {
    throw new Error(`unknown workflow preset "${presetName}"; expected one of ${WORKFLOW_PRESET_NAMES.join(' | ')}`)
  }
  const patchedItems = items.map((item, idx) => {
    const raw = rawItems[idx] ?? {}
    return {
      ...item,
      complexity: raw.complexity === undefined ? spec.itemDefaults.complexity : item.complexity,
      reviewDepth: raw.review_depth === undefined ? spec.itemDefaults.reviewDepth : item.reviewDepth,
    }
  })
  return {
    preset: normalized,
    settings: { ...effectiveSettings, ...spec.settings },
    items: patchedItems,
  }
}

/** Default plugin settings; every field is overridable from `cordis.patch.yml`. */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Artifact directory, absolute or relative to the Team working directory. */
  artifactsDir: '.agentteam',
  /** Submitted reviews allowed per work item before Lead arbitration is required. */
  maxReviewRounds: 2,
  /** Maximum work items allowed in one execution wave. */
  maxParallelItems: 4,
  /** Maximum work items in one run. */
  maxItems: 12,
  /** Context mode used for spawned workers (`fresh` keeps execution independent). */
  workerContext: 'fresh',
  /** Inject the workflow protocol into every Team member system prompt. */
  injectPolicy: true,
  /** Persist run state and reports under the artifact directory. */
  writeArtifacts: true,
  /** Treat reported files outside declared write scopes as a hard gate failure. */
  strictScopes: false,
  /** Treat contract mismatches in handoff packets as a hard gate failure. */
  strictContracts: false,
  /** Deny native write/edit calls outside the caller's declared write scopes at runtime. */
  enforceWriteScopes: false,
  /** Allow overlapping write scopes inside one wave (recorded as a warning). */
  allowScopeOverlap: false,
  /** Notify the assigned reviewer automatically when a report is submitted. */
  autoNotify: true,
  /** Reject an approving review that declares no inspection evidence at all. */
  requireReviewEvidence: true,
  /** Minutes an open proposal waits for votes before lazy settlement; 0 disables it. */
  proposalTimeoutMinutes: 15,
  /** Spawn/wake the members a plan needs instead of only returning spawn prompts. */
  autoStaff: true,
  /** Enable the git/PR workflow tools (branch, commit, verify, push, PR, merge). */
  gitEnabled: false,
  /** Base branch the PR workflow branches from and merges into. */
  gitBaseBranch: 'main',
  /** Remote pushed to by the git workflow. */
  gitRemote: 'origin',
  /** Prefix for per-item branches. */
  gitBranchPrefix: 'agentteam/',
  /** Verification commands the `verify` action runs. */
  gitVerifyCommands: [],
  /** Verification commands executed on runBranch after all item worktrees merge and before finalization. */
  integrationVerifyCommands: [],
  /** Require item git verification to pass before the gate accepts it. */
  gitRequireVerify: false,
  /** DSH provider name used when spawning a fresh teammate. */
  freshProvider: 'spawn',
  /** DSH provider name used when spawning a teammate that inherits the Lead. */
  forkProvider: 'fork',
  /**
   * Reusable role definitions: `{ name: { provider?, prompt? } }`.
   * A role selects the DSH provider used to spawn that member (DSH picks the
   * model from the provider configuration) and appends a domain prompt to the
   * member's brief.
   */
  roles: {},
  /**
   * Lifecycle hooks: `{ taskCreated: [], taskCompleted: [], teammateIdle: [] }`
   * where every handler is `{ command, timeoutMs?, cwd? }`. Exit code 2 vetoes
   * the action; the event JSON arrives on stdin.
   */
  hooks: {},
  /** Require a short implementation plan (and its approval) before work starts. */
  planFirst: false,
  /** Auto-approve a submitted plan when nobody reviews it (official default). */
  autoApprovePlan: true,
  /** Who approves plans: the Lead or the item's first peer reviewer. */
  planApprover: 'lead',
  /** Token budget per member for the whole run; 0 disables the check. */
  tokenBudgetPerMember: 0,
  /** Token budget for the whole run; 0 disables the check. */
  tokenBudgetPerRun: 0,
  /** Per-item git worktree isolation: 'off' | 'serial' | 'parallel'. */
  worktreeIsolation: 'off',
  /** Automatically provision worktrees for planned/created items when worktreeIsolation is active. */
  autoWorktree: true,
  /** Provision worktrees only for unblocked items upfront; defer downstream waves until upstream merges. */
  lazyWorktreeProvision: true,
  /** Automatically commit dirty changes inside writeScopes when team_flow_report is called. */
  autoCommitOnReport: true,
  /** Automatically merge an approved item's worktree branch into the run branch. */
  autoMergeWorktree: true,
  /** Automatically clean up temporary worktrees when the run is finalized. */
  autoCleanupWorktrees: true,
  /** Automatically reconcile team workflow events and wake inactive workers/reviewers. */
  autoOrchestrate: true,
  /** Wake assigned workers when their task dependencies are satisfied. */
  autoWakeUnblocked: true,
  /** Wake assigned reviewers when an item has been reported. */
  autoWakeReviewers: true,
  /** Notify the Lead when all items in the plan are approved. */
  autoNotifyConverged: true,
  /** Automatically evaluate quality gates and finalize run when all items are approved without manual Lead command. */
  autoFinalize: false,
  /** Interval in seconds for the liveness watchdog timer (0 disables the timer). */
  watchdogIntervalSeconds: 30,
  /** Maximum interval in seconds for adaptive watchdog backoff when run rev is idle. */
  watchdogMaxIntervalSeconds: 180,
  /** Max automatic nudges for an inactive member with no item progress before escalating to Lead (0 disables). */
  maxStallNudges: 2,
  /** Minimum seconds elapsed since last wake/nudge before treating an inactive member as stalled. */
  stallNudgeDelaySeconds: 45,
  /** Subscribe to agent/status idle events for near-instant orchestration. */
  eventDrivenOrchestrator: true,
  /** Spawn Wave 1 workers upfront and defer Wave 2+/pure reviewers until ready/reported. */
  lazyStaffing: false,
  /** Default model-facing status projection: `full` (compatible) or `brief` (token-efficient). */
  statusView: 'full',
  /** Maximum diff lines attached to a review/wake notification. */
  reviewDiffLines: 120,
  /** Maximum diff bytes attached to a review/wake notification. */
  reviewDiffBytes: 12288,
  /** Base board poll interval in milliseconds; clients back off when nothing changes. */
  boardPollMs: 1200,
  /** Legacy mode: register all 17 tools to every member regardless of role. */
  legacyAllTools: false,
  /** Filter registered tools by role to reduce model prompt schema overhead. */
  roleToolScoping: true,
  /** Prune redundant collaboration/devkit tools in lightweight presets (e.g. fast-fix) when inactive. */
  presetToolPruning: true,
  /** Pre-flight check in team_flow_report: fail fast on non-zero exit codes. */
  preReportCheck: true,
  /** Require at least one minor/major finding for request_changes (disallows pure nit rework). */
  nitTolerance: true,
  /** Archive full reports and reviews of approved items to disk to reduce state payload. */
  archiveApprovedItems: false,
  /** Thinking / reasoning-effort routing mode: 'auto' | 'role' | 'off'. */
  thinkingRouting: 'auto',
  /** Default semantic bias for normal implementation items on models without 'medium' effort: 'low' | 'high'. */
  thinkingDefaultBias: 'low',
  /** Notify and accept multiple independent reviewers in parallel on the same report. */
  parallelReviews: true,
  /** Default review depth when not specified or auto-escalated: 'auto' | 'light' | 'standard' | 'deep'. */
  defaultReviewDepth: 'auto',
  /** Require explicit dod_checks on deep-depth approvals. */
  strictReviewRubric: false,
})

function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.trunc(parsed)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function readHooks(value) {
  const safe = { taskCreated: [], taskCompleted: [], teammateIdle: [] }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return safe
  for (const event of Object.keys(safe)) {
    const handlers = Array.isArray(value[event]) ? value[event] : []
    for (const handler of handlers) {
      const command = readString(handler?.command, '', 4000)
      if (command.length === 0) continue
      const entry = { command }
      if (Number.isInteger(handler?.timeoutMs)) entry.timeoutMs = handler.timeoutMs
      const cwd = readString(handler?.cwd, '', 1024)
      if (cwd.length > 0) entry.cwd = cwd
      safe[event].push(entry)
      if (safe[event].length >= 8) break
    }
  }
  return safe
}

function readRoles(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const roles = {}
  for (const [rawName, rawRole] of Object.entries(value)) {
    const name = String(rawName).trim().toLowerCase()
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue
    if (rawRole === null || typeof rawRole !== 'object') continue
    const role = {}
    const provider = readString(rawRole.provider, '', 200)
    if (provider.length > 0) role.provider = provider
    const llmProvider = readString(rawRole.llmProvider, '', 200)
    if (llmProvider.length > 0) role.llmProvider = llmProvider
    const model = readString(rawRole.model, '', 200)
    if (model.length > 0) role.model = model
    const thinking = readString(rawRole.thinking, '', 16).toLowerCase()
    if (['off', 'low', 'medium', 'high', 'max', 'inherit'].includes(thinking)) role.thinking = thinking
    if (rawRole.maxTokens !== undefined && rawRole.maxTokens !== null) {
      const parsedTokens = Number.isInteger(rawRole.maxTokens) ? rawRole.maxTokens : Number.parseInt(String(rawRole.maxTokens), 10)
      if (Number.isFinite(parsedTokens) && parsedTokens > 0) role.maxTokens = Math.min(1_000_000, Math.max(256, Math.trunc(parsedTokens)))
    }
    const prompt = readString(rawRole.prompt, '', 4000)
    if (prompt.length > 0) role.prompt = prompt
    if (Array.isArray(rawRole.deny)) {
      const deny = normalizeToolPolicyList(rawRole.deny)
      if (deny.length > 0) role.deny = deny
    }
    if (Array.isArray(rawRole.allow)) {
      const allow = normalizeToolPolicyList(rawRole.allow)
      if (allow.length > 0) role.allow = allow
    }
    if (rawRole.readOnly === true) role.readOnly = true
    if (Object.keys(role).length > 0) roles[name] = role
    if (Object.keys(roles).length >= 32) break
  }
  return roles
}

/**
 * Normalize one role's tool-policy list to `tool` or `tool:action` entries.
 * @param value - raw array from the role config.
 * @returns deduplicated, bounded entries.
 */
function normalizeToolPolicyList(value) {
  if (!Array.isArray(value)) return []
  const entries = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => /^[a-z_]+(:[a-z_]+)?$/.test(entry))
  return [...new Set(entries)].slice(0, 64)
}

function readCommands(value) {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter((entry) => entry.length > 0).slice(0, 16)
}

/** @returns one of 'off' | 'serial' | 'parallel' (booleans kept for compat). */
export function readWorktreeMode(value) {
  if (value === true) return 'parallel'
  if (value === false || value === undefined) return 'off'
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === 'parallel' || text === 'serial' || text === 'off') return text
  return 'off'
}

function readBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function readString(value, fallback, maxLength = 4096) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0) return fallback
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

/**
 * Resolve raw Loader config into effective settings.
 * @param raw - raw `config` object from the plugin row.
 * @returns frozen effective settings.
 */
export function resolveSettings(raw = {}) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const context = readString(config.workerContext, DEFAULT_SETTINGS.workerContext, 16)
  return Object.freeze({
    artifactsDir: readString(config.artifactsDir, DEFAULT_SETTINGS.artifactsDir, 1024),
    maxReviewRounds: clampInt(config.maxReviewRounds, DEFAULT_SETTINGS.maxReviewRounds, 1, 5),
    maxParallelItems: clampInt(config.maxParallelItems, DEFAULT_SETTINGS.maxParallelItems, 1, 8),
    maxItems: clampInt(config.maxItems, DEFAULT_SETTINGS.maxItems, 1, 32),
    workerContext: context === 'fork' ? 'fork' : 'fresh',
    injectPolicy: readBool(config.injectPolicy, DEFAULT_SETTINGS.injectPolicy),
    writeArtifacts: readBool(config.writeArtifacts, DEFAULT_SETTINGS.writeArtifacts),
    strictScopes: readBool(config.strictScopes, DEFAULT_SETTINGS.strictScopes),
    strictContracts: readBool(config.strictContracts, DEFAULT_SETTINGS.strictContracts),
    enforceWriteScopes: readBool(config.enforceWriteScopes, DEFAULT_SETTINGS.enforceWriteScopes),
    allowScopeOverlap: readBool(config.allowScopeOverlap, DEFAULT_SETTINGS.allowScopeOverlap),
    autoNotify: readBool(config.autoNotify, DEFAULT_SETTINGS.autoNotify),
    requireReviewEvidence: readBool(config.requireReviewEvidence, DEFAULT_SETTINGS.requireReviewEvidence),
    proposalTimeoutMinutes: clampInt(config.proposalTimeoutMinutes, DEFAULT_SETTINGS.proposalTimeoutMinutes, 0, 1440),
    autoStaff: readBool(config.autoStaff, DEFAULT_SETTINGS.autoStaff),
    gitEnabled: readBool(config.gitEnabled, DEFAULT_SETTINGS.gitEnabled),
    gitBaseBranch: readString(config.gitBaseBranch, DEFAULT_SETTINGS.gitBaseBranch, 200),
    gitRemote: readString(config.gitRemote, DEFAULT_SETTINGS.gitRemote, 200),
    gitBranchPrefix: readString(config.gitBranchPrefix, DEFAULT_SETTINGS.gitBranchPrefix, 200),
    gitVerifyCommands: readCommands(config.gitVerifyCommands),
    integrationVerifyCommands: readCommands(config.integrationVerifyCommands),
    gitRequireVerify: readBool(config.gitRequireVerify, DEFAULT_SETTINGS.gitRequireVerify),
    freshProvider: readString(config.freshProvider, DEFAULT_SETTINGS.freshProvider, 200),
    forkProvider: readString(config.forkProvider, DEFAULT_SETTINGS.forkProvider, 200),
    roles: readRoles(config.roles),
    hooks: readHooks(config.hooks),
    planFirst: readBool(config.planFirst, DEFAULT_SETTINGS.planFirst),
    autoApprovePlan: readBool(config.autoApprovePlan, DEFAULT_SETTINGS.autoApprovePlan),
    planApprover: readString(config.planApprover, DEFAULT_SETTINGS.planApprover, 16) === 'peer' ? 'peer' : 'lead',
    tokenBudgetPerMember: clampInt(config.tokenBudgetPerMember, DEFAULT_SETTINGS.tokenBudgetPerMember, 0, 1_000_000_000),
    tokenBudgetPerRun: clampInt(config.tokenBudgetPerRun, DEFAULT_SETTINGS.tokenBudgetPerRun, 0, 1_000_000_000),
    worktreeIsolation: readWorktreeMode(config.worktreeIsolation),
    autoWorktree: readBool(config.autoWorktree, DEFAULT_SETTINGS.autoWorktree),
    lazyWorktreeProvision: readBool(config.lazyWorktreeProvision, DEFAULT_SETTINGS.lazyWorktreeProvision),
    autoCommitOnReport: readBool(config.autoCommitOnReport, DEFAULT_SETTINGS.autoCommitOnReport),
    autoMergeWorktree: readBool(config.autoMergeWorktree, DEFAULT_SETTINGS.autoMergeWorktree),
    autoCleanupWorktrees: readBool(config.autoCleanupWorktrees, DEFAULT_SETTINGS.autoCleanupWorktrees),
    autoOrchestrate: readBool(config.autoOrchestrate, DEFAULT_SETTINGS.autoOrchestrate),
    autoWakeUnblocked: readBool(config.autoWakeUnblocked, DEFAULT_SETTINGS.autoWakeUnblocked),
    autoWakeReviewers: readBool(config.autoWakeReviewers, DEFAULT_SETTINGS.autoWakeReviewers),
    autoNotifyConverged: readBool(config.autoNotifyConverged, DEFAULT_SETTINGS.autoNotifyConverged),
    autoFinalize: readBool(config.autoFinalize, DEFAULT_SETTINGS.autoFinalize),
    watchdogIntervalSeconds: clampInt(config.watchdogIntervalSeconds, DEFAULT_SETTINGS.watchdogIntervalSeconds, 0, 3600),
    watchdogMaxIntervalSeconds: clampInt(config.watchdogMaxIntervalSeconds, DEFAULT_SETTINGS.watchdogMaxIntervalSeconds, 30, 3600),
    maxStallNudges: clampInt(config.maxStallNudges, DEFAULT_SETTINGS.maxStallNudges, 0, 5),
    stallNudgeDelaySeconds: clampInt(config.stallNudgeDelaySeconds, DEFAULT_SETTINGS.stallNudgeDelaySeconds, 0, 3600),
    eventDrivenOrchestrator: readBool(config.eventDrivenOrchestrator, DEFAULT_SETTINGS.eventDrivenOrchestrator),
    lazyStaffing: readBool(config.lazyStaffing, DEFAULT_SETTINGS.lazyStaffing),
    statusView: readString(config.statusView, DEFAULT_SETTINGS.statusView, 16) === 'brief' ? 'brief' : 'full',
    reviewDiffLines: clampInt(config.reviewDiffLines, DEFAULT_SETTINGS.reviewDiffLines, 0, 500),
    reviewDiffBytes: clampInt(config.reviewDiffBytes, DEFAULT_SETTINGS.reviewDiffBytes, 0, 65536),
    boardPollMs: clampInt(config.boardPollMs, DEFAULT_SETTINGS.boardPollMs, 500, 60000),
    legacyAllTools: readBool(config.legacyAllTools, DEFAULT_SETTINGS.legacyAllTools),
    roleToolScoping: readBool(config.roleToolScoping, DEFAULT_SETTINGS.roleToolScoping),
    presetToolPruning: readBool(config.presetToolPruning, DEFAULT_SETTINGS.presetToolPruning),
    preReportCheck: readBool(config.preReportCheck, DEFAULT_SETTINGS.preReportCheck),
    nitTolerance: readBool(config.nitTolerance, DEFAULT_SETTINGS.nitTolerance),
    archiveApprovedItems: readBool(config.archiveApprovedItems, DEFAULT_SETTINGS.archiveApprovedItems),
    thinkingRouting: (() => {
      const mode = readString(config.thinkingRouting, DEFAULT_SETTINGS.thinkingRouting, 16).toLowerCase()
      return mode === 'role' || mode === 'off' ? mode : 'auto'
    })(),
    thinkingDefaultBias: readString(config.thinkingDefaultBias, DEFAULT_SETTINGS.thinkingDefaultBias, 16).toLowerCase() === 'high' ? 'high' : 'low',
    parallelReviews: readBool(config.parallelReviews, DEFAULT_SETTINGS.parallelReviews),
    defaultReviewDepth: (() => {
      const d = readString(config.defaultReviewDepth, DEFAULT_SETTINGS.defaultReviewDepth, 16).toLowerCase()
      return d === 'light' || d === 'standard' || d === 'deep' ? d : 'auto'
    })(),
    strictReviewRubric: readBool(config.strictReviewRubric, DEFAULT_SETTINGS.strictReviewRubric),
  })
}

/**
 * The subset of settings frozen into one run, so a later config change cannot
 * silently rewrite the rules a run was planned under.
 * @param settings - effective settings.
 * @returns run-scoped settings record.
 */
export function runSettings(settings) {
  return {
    maxReviewRounds: settings.maxReviewRounds,
    maxParallelItems: settings.maxParallelItems,
    workerContext: settings.workerContext,
    strictScopes: settings.strictScopes,
    strictContracts: settings.strictContracts,
    enforceWriteScopes: settings.enforceWriteScopes,
    allowScopeOverlap: settings.allowScopeOverlap,
    requireReviewEvidence: settings.requireReviewEvidence,
    proposalTimeoutMinutes: settings.proposalTimeoutMinutes,
    autoStaff: settings.autoStaff,
    gitEnabled: settings.gitEnabled,
    gitBaseBranch: settings.gitBaseBranch,
    gitRemote: settings.gitRemote,
    gitBranchPrefix: settings.gitBranchPrefix,
    gitVerifyCommands: [...settings.gitVerifyCommands],
    integrationVerifyCommands: [...settings.integrationVerifyCommands],
    gitRequireVerify: settings.gitRequireVerify,
    freshProvider: settings.freshProvider,
    forkProvider: settings.forkProvider,
    roles: { ...settings.roles },
    hooks: { taskCreated: [...settings.hooks.taskCreated], taskCompleted: [...settings.hooks.taskCompleted], teammateIdle: [...settings.hooks.teammateIdle] },
    planFirst: settings.planFirst,
    autoApprovePlan: settings.autoApprovePlan,
    planApprover: settings.planApprover,
    tokenBudgetPerMember: settings.tokenBudgetPerMember,
    tokenBudgetPerRun: settings.tokenBudgetPerRun,
    worktreeIsolation: settings.worktreeIsolation,
    autoWorktree: settings.autoWorktree,
    lazyWorktreeProvision: settings.lazyWorktreeProvision,
    autoCommitOnReport: settings.autoCommitOnReport,
    autoMergeWorktree: settings.autoMergeWorktree,
    autoCleanupWorktrees: settings.autoCleanupWorktrees,
    autoOrchestrate: settings.autoOrchestrate,
    autoWakeUnblocked: settings.autoWakeUnblocked,
    autoWakeReviewers: settings.autoWakeReviewers,
    autoNotifyConverged: settings.autoNotifyConverged,
    autoFinalize: settings.autoFinalize,
    watchdogIntervalSeconds: settings.watchdogIntervalSeconds,
    watchdogMaxIntervalSeconds: settings.watchdogMaxIntervalSeconds,
    maxStallNudges: settings.maxStallNudges,
    stallNudgeDelaySeconds: settings.stallNudgeDelaySeconds,
    eventDrivenOrchestrator: settings.eventDrivenOrchestrator,
    lazyStaffing: settings.lazyStaffing,
    boardPollMs: settings.boardPollMs,
    legacyAllTools: settings.legacyAllTools,
    roleToolScoping: settings.roleToolScoping,
    presetToolPruning: settings.presetToolPruning,
    preReportCheck: settings.preReportCheck,
    nitTolerance: settings.nitTolerance,
    archiveApprovedItems: settings.archiveApprovedItems,
    thinkingRouting: settings.thinkingRouting,
    thinkingDefaultBias: settings.thinkingDefaultBias,
    parallelReviews: settings.parallelReviews,
    defaultReviewDepth: settings.defaultReviewDepth,
    strictReviewRubric: settings.strictReviewRubric,
  }
}
