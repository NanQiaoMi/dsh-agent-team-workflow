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
})

function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.trunc(parsed)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function readCommands(value) {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter((entry) => entry.length > 0).slice(0, 16)
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
  }
}
