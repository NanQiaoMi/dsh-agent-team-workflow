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
  /** Automatically reconcile team workflow events and wake inactive workers/reviewers. */
  autoOrchestrate: true,
  /** Wake assigned workers when their task dependencies are satisfied. */
  autoWakeUnblocked: true,
  /** Wake assigned reviewers when an item has been reported. */
  autoWakeReviewers: true,
  /** Notify the Lead when all items in the plan are approved. */
  autoNotifyConverged: true,
  /** Interval in seconds for the liveness watchdog timer (0 disables the timer). */
  watchdogIntervalSeconds: 30,
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
    autoOrchestrate: readBool(config.autoOrchestrate, DEFAULT_SETTINGS.autoOrchestrate),
    autoWakeUnblocked: readBool(config.autoWakeUnblocked, DEFAULT_SETTINGS.autoWakeUnblocked),
    autoWakeReviewers: readBool(config.autoWakeReviewers, DEFAULT_SETTINGS.autoWakeReviewers),
    autoNotifyConverged: readBool(config.autoNotifyConverged, DEFAULT_SETTINGS.autoNotifyConverged),
    watchdogIntervalSeconds: clampInt(config.watchdogIntervalSeconds, DEFAULT_SETTINGS.watchdogIntervalSeconds, 0, 3600),
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
    autoOrchestrate: settings.autoOrchestrate,
    autoWakeUnblocked: settings.autoWakeUnblocked,
    autoWakeReviewers: settings.autoWakeReviewers,
    autoNotifyConverged: settings.autoNotifyConverged,
    watchdogIntervalSeconds: settings.watchdogIntervalSeconds,
  }
}
