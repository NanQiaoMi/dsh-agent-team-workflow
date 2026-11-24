/**
 * Shared helpers, validators, and execution wrapper for Agent Team Workflow tools.
 */
import { execFile } from 'node:child_process'

import { fireHooks } from '../hooks.js'
import * as W from '../workflow.js'
import { getWorktreeDiffSummary } from '../worktree-manager.js'

export const REPEATED_FAILURE_THRESHOLD = 3
const FAILURE_TRACKER_MAX = 256

/** Round-trip a tool result to plain lossless JSON (drops `undefined` members). */
export function compactJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Declare one canonical output schema with compact model-facing JSON. */
export function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Recover the caller Agent guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent, toolName) {
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** @returns `{agent, membership}` for one tool execution. */
export function resolveCaller(ctx, exec, toolName) {
  const agent = callingAgent(exec.agent, toolName)
  const membership = ctx.agentTeams.membership(agent)
  return { agent, membership }
}

export function requireLead(membership, toolName) {
  if (membership.role !== 'lead') {
    throw new Error(`${toolName} is Lead-only; you are teammate "${membership.name}". Report the need to the Lead with send_message instead.`)
  }
}

export async function requireRun(store, agent, toolName) {
  const state = await store.readState(agent)
  if (state === null) {
    throw new Error(`no Agent Team Workflow run exists yet; the Lead must call team_flow_plan first (${toolName})`)
  }
  return state
}

/** Refuse to mutate a run that already converged. */
export function requireWritableRun(state, toolName) {
  if (state.phase === W.RUN_PHASE.FINALIZED) {
    throw new Error(`run ${state.runId} is finalized; ${toolName} cannot change it. Start a new run with team_flow_plan {replace:true} if more work is needed.`)
  }
}

/** Format a structured tool validation error with optional missing fields and copyable fix example. */
export function formatToolValidationError({ tool, reason, missing = [], example = null }) {
  const parts = [`${tool} rejected: ${reason}`]
  if (Array.isArray(missing) && missing.length > 0) {
    parts.push(`Missing/invalid: ${missing.join(', ')}`)
  }
  if (example !== null && example !== undefined) {
    const rendered = typeof example === 'string' ? example : JSON.stringify(example)
    parts.push(`Fix example: ${rendered}`)
  }
  return parts.join('\n')
}

/** Read current git HEAD SHA for a directory, or null if unavailable. */
export function readHeadSha(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd, timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null)
      const sha = String(stdout ?? '').trim()
      resolve(sha.length > 0 ? sha : null)
    })
  })
}

/** Validate a spawnable member name (lower-kebab-case, never the Lead). */
export function assertMemberName(name, field) {
  const value = String(name ?? '').trim()
  if (value === 'lead') throw new Error(`${field} cannot be "lead"; the Lead coordinates and gates`)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`${field} "${value}" is not a spawnable member name (lower-kebab-case, digits allowed)`)
  return value
}

/** Send one peer message, converting transport failures into a warning. */
export async function sendPeer(ctx, agent, target, text, signal) {
  try {
    await ctx.agentTeams.sendMessage(agent, { target, content: [{ type: 'text', text }], signal })
    return null
  } catch (error) {
    return `could not notify "${target}": ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Maximum Team members including the Lead; the native roster refuses more. */
const TEAM_MEMBER_LIMIT = 8

/**
 * Spawn or wake every member one plan needs.
 *
 * The Lead should publish a mission and let the plugin build the Team: this
 * helper reuses a live member, wakes an inactive one with its brief, and only
 * spawns when the name is genuinely absent. Capacity failures are returned as
 * data instead of killed work so the Lead can decide what to drop.
 * @param options - `{ ctx, agent, entries, signal }`.
 * @returns `{ spawned, woken, skipped, failed, needs_spawn }`.
 */
export async function staffEntries({ ctx, agent, entries, settings, signal }) {
  const outcome = { spawned: [], woken: [], skipped: [], failed: [], needs_spawn: [] }
  let roster = []
  try {
    roster = ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, status: member.status }))
  } catch {
    roster = []
  }
  const known = new Map(roster.map((member) => [member.name, member.status]))
  let memberCount = roster.length
  const seen = new Set()
  for (const entry of entries) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    if (known.has(name)) {
      if (known.get(name) === 'inactive') {
        const failure = await sendPeer(ctx, agent, name, `[RESUME] ${entry.description ?? entry.kind ?? 'work'}

${entry.prompt ?? ''}`, signal)
        if (failure === null) outcome.woken.push(name)
        else outcome.failed.push({ name, error: failure })
      } else {
        outcome.skipped.push(name)
      }
      continue
    }
    if (memberCount >= TEAM_MEMBER_LIMIT) {
      outcome.needs_spawn.push({ name, kind: entry.kind ?? 'worker', reason: `team member limit ${TEAM_MEMBER_LIMIT} reached` })
      continue
    }
    try {
      // The native roster requires an explicit provider on every spawn; the
      // defaults mirror the native team tool so a missing setting cannot break
      // auto-staffing.
      const context = entry.context === 'fork' ? 'fork' : 'fresh'
      const provider = typeof entry.provider === 'string' && entry.provider.length > 0
        ? entry.provider
        : context === 'fork'
          ? (settings?.forkProvider ?? 'fork')
          : (settings?.freshProvider ?? 'spawn')
      await ctx.agentTeams.spawnTeammate(agent, {
        name,
        description: String(entry.description ?? `${entry.kind ?? 'worker'} for the Agent Team workflow`).slice(0, 200),
        prompt: [{ type: 'text', text: String(entry.prompt ?? '') }],
        context,
        provider,
        signal,
      })
      known.set(name, 'provisioning')
      memberCount += 1
      outcome.spawned.push({ name, kind: entry.kind ?? 'worker' })
    } catch (error) {
      outcome.failed.push({ name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcome
}


/**
 * Members that actually take part in the current run.
 *
 * Channel broadcasts used to fan out to every roster member, which woke idle
 * members that then answered stale messages (run-20261102052850-il6f). The
 * board still records team messages for everyone; only participants get a
 * direct notification.
 * @returns deduplicated participant names without the Lead and the caller.
 */
export function audienceFor(state, callerName) {
  const names = new Set()
  for (const item of Array.isArray(state?.items) ? state.items : []) {
    if (typeof item.owner === 'string' && item.owner.length > 0) names.add(item.owner)
    for (const reviewer of Array.isArray(item.reviewers) ? item.reviewers : []) names.add(reviewer)
    if (item.claim !== null && typeof item.claim === 'object' && typeof item.claim.by === 'string') names.add(item.claim.by)
    if (typeof item.pendingReviewer === 'string' && item.pendingReviewer.length > 0) names.add(item.pendingReviewer)
    for (const request of Array.isArray(item.reviewRequests) ? item.reviewRequests : []) {
      if (typeof request?.reviewer === 'string' && request.reviewer.length > 0) names.add(request.reviewer)
    }
    for (const handoff of Array.isArray(item.handoffs) ? item.handoffs : []) {
      if (typeof handoff?.to === 'string' && handoff.to.length > 0) names.add(handoff.to)
      if (typeof handoff?.by === 'string' && handoff.by.length > 0) names.add(handoff.by)
    }
  }
  for (const proposal of Array.isArray(state?.proposals) ? state.proposals : []) {
    if (typeof proposal?.by === 'string' && proposal.by.length > 0) names.add(proposal.by)
  }
  for (const name of Array.isArray(state?.staffPool) ? state.staffPool : []) names.add(name)
  names.delete('lead')
  if (typeof callerName === 'string') names.delete(callerName)
  return [...names]
}


/**
 * Fire one lifecycle hook set and throw a readable error when it vetoes.
 * Hooks receive the event payload as JSON on stdin; exit code 2 blocks.
 */
export async function runHook(event, payload, { agent, settings, store }) {
  const handlers = settings.hooks?.[event] ?? []
  if (handlers.length === 0) return
  let cwd = process.cwd()
  try {
    cwd = store.workingDir(agent)
  } catch {
    /* fall back to the process cwd when the workspace cannot resolve */
  }
  const outcome = await fireHooks({ handlers, event, payload, cwd, env: process.env })
  if (!outcome.blocked) return
  const last = outcome.results.at(-1)
  throw new Error(`${event} hook blocked the action: ${last?.command ?? ''}${last?.output ? `: ${last.output}` : ''}`)
}


/**
 * Reject a workflow action the caller's role denies (docs/19 §6).
 *
 * This is a workflow-level guard, not a filesystem sandbox: DSH still owns the
 * session's real permissions. A member with no configured role is never
 * restricted.
 */
/**
 * Workflow tools a read-only role may not call. Reporting, reviewing, talking
 * and escalating are collaboration duties, not workspace mutations, so they
 * stay available — otherwise a read-only owner could never hand off a report.
 */
const READ_ONLY_DENIED_TOOLS = new Set([
  'team_flow_plan', 'team_flow_work', 'team_flow_item', 'team_flow_git', 'team_flow_gate',
  'team_flow_repair', 'team_flow_staff', 'team_flow_stop', 'team_flow_decide', 'team_flow_plan_approval',
])

export function assertRoleAllowed(settings, state, memberName, toolName, action) {
  if (state === null || state === undefined) return
  const roles = settings.roles ?? {}
  const explicit = state.roleAssignments?.[memberName]
  let role = typeof explicit === 'string' && roles[explicit] !== undefined ? explicit : undefined
  if (role === undefined) {
    const ownedRoles = new Set(
      (Array.isArray(state.items) ? state.items : [])
        .filter((item) => item.owner === memberName && typeof item.role === 'string' && roles[item.role] !== undefined)
        .map((item) => item.role),
    )
    if (ownedRoles.size === 1) role = [...ownedRoles][0]
  }
  if (role === undefined) return
  const policy = roles[role]
  const describe = `${toolName}${typeof action === 'string' ? ` ${action}` : ''}`
  if (policy.readOnly === true && READ_ONLY_DENIED_TOOLS.has(toolName)) {
    throw new Error(`role "${role}" is read-only and may not use ${describe} (see roles.${role}.readOnly in the plugin config)`)
  }
  const deny = Array.isArray(policy.deny) ? policy.deny : []
  const denied = deny.includes(toolName) || (typeof action === 'string' && deny.includes(`${toolName}:${action}`))
  if (denied) throw new Error(`role "${role}" may not use ${describe} (see roles.${role}.deny in the plugin config)`)
  const allow = Array.isArray(policy.allow) ? policy.allow : []
  if (allow.length > 0) {
    const allowed = allow.includes(toolName) || (typeof action === 'string' && allow.includes(`${toolName}:${action}`))
    if (!allowed) throw new Error(`role "${role}" may only use ${allow.join(', ')}; ${describe} is outside its allow list (see roles.${role}.allow)`)
  }
}

/** @returns whether one member name is currently in the roster. */
export function isLiveMember(ctx, agent, name) {
  try {
    return ctx.agentTeams.listMembers(agent).some((member) => member.name === name)
  } catch {
    return false
  }
}

/**
 * Drive one backing Team task to completed, repairing any intermediate state.
 * @returns status text or a warning.
 */
export async function syncTaskComplete(ctx, agent, taskId) {
  if (taskId === null) return null
  try {
    let task = ctx.agentTeams.getTask(agent, taskId)
    if (task.status === 'deleted') return null
    if (task.status === 'completed') {
      task = await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'reopen' })
    }
    if (task.status === 'pending') {
      task = await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'claim' })
    }
    if (task.status === 'in_progress') {
      await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'complete' })
    }
    return null
  } catch (error) {
    return `backing Team task ${taskId} not synchronized: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Reopen one backing Team task so a rework round is visible on the shared board.
 * @returns status text or a warning.
 */
export async function syncTaskReopen(ctx, agent, taskId) {
  if (taskId === null) return null
  try {
    const task = ctx.agentTeams.getTask(agent, taskId)
    if (task.status !== 'completed') return null
    // The reviewer may reopen the item, but the native shared task only accepts
    // mutations from its owner or the Team Lead. Run the reopen as the Lead so
    // a request_changes round does not leave the backing task stuck completed.
    const membership = ctx.agentTeams.tryMembership(agent)
    const caller = membership !== undefined && membership !== null && membership.root !== undefined ? membership.root : agent
    await ctx.agentTeams.updateTask(caller, { taskId, expectedRevision: task.revision, action: 'reopen' })
    return null
  } catch (error) {
    return `backing Team task ${taskId} was not reopened: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Build a bounded diff for review notifications (settings-controlled). */
export async function reviewDiffFor({ ctx, cwd, state, item, settings, sinceSha = null }) {
  const raw = await getWorktreeDiffSummary({ cwd, state, item, maxLines: settings.reviewDiffLines, sinceSha }).catch(() => null)
  if (raw === null) return null
  const limit = settings.reviewDiffBytes
  if (!Number.isFinite(limit) || limit <= 0) return ''
  return raw.length > limit ? `${raw.slice(0, limit)}\n… (diff truncated to ${limit} bytes)` : raw
}

/** Resolve the current HEAD SHA inside an item's isolated worktree, if any. */
export function resolveWorktreeHead(item) {
  const wtPath = item?.git?.worktreePath
  if (typeof wtPath !== 'string' || wtPath.length === 0) return Promise.resolve(item?.git?.sha ?? null)
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd: wtPath, timeout: 2000, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(item?.git?.sha ?? null)
      const sha = typeof stdout === 'string' ? stdout.trim() : ''
      resolve(sha.length > 0 ? sha : (item?.git?.sha ?? null))
    })
  })
}

/** Truncate one model-supplied string before it enters the board. */
export function clip(value, max) {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max) : text
}

/** Build a fresh run id. */
export function makeRunId(now) {
  const stamp = now.replace(/[-:.TZ]/g, '').slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 6)
  return `run-${stamp}-${suffix}`
}

/** Normalize one requested work item into engine shape. */
export function normalizeItem(raw, index) {
  const subject = String(raw?.subject ?? '').trim()
  const owner = String(raw?.owner ?? '').trim()
  const definitionOfDone = Array.isArray(raw?.definition_of_done) ? raw.definition_of_done.map((entry) => String(entry).trim()).filter(Boolean) : []
  const reviewers = Array.isArray(raw?.reviewers) ? [...new Set(raw.reviewers.map((entry) => String(entry).trim()).filter(Boolean))] : []
  const blockedBy = Array.isArray(raw?.blocked_by) ? [...new Set(raw.blocked_by.map((entry) => String(entry).trim()).filter(Boolean))] : []
  const writeScopes = Array.isArray(raw?.write_scopes) ? [...new Set(raw.write_scopes.map((entry) => W.normalizeScope(entry)).filter((entry) => entry.length > 0))] : []
  const assignment = raw?.assignment === 'open' ? 'open' : 'lead'
  const rawComplexity = typeof raw?.complexity === 'string' ? raw.complexity.trim().toLowerCase() : 'normal'
  const complexity = ['trivial', 'normal', 'complex'].includes(rawComplexity) ? rawComplexity : 'normal'
  const rawTier = typeof raw?.thinking_tier === 'string' ? raw.thinking_tier.trim().toLowerCase() : ''
  const thinkingTier = ['off', 'low', 'medium', 'high', 'max', 'inherit'].includes(rawTier) ? rawTier : null
  const rawDepth = typeof raw?.review_depth === 'string' ? raw.review_depth.trim().toLowerCase() : 'auto'
  const reviewDepth = ['light', 'standard', 'deep'].includes(rawDepth) ? rawDepth : 'auto'
  const rawProfile = typeof raw?.review_profile === 'string' ? raw.review_profile.trim().toLowerCase() : 'auto'
  const reviewProfile = ['code', 'security', 'api', 'docs', 'tests', 'refactor'].includes(rawProfile) ? rawProfile : 'auto'
  return {
    id: String(raw?.id ?? `W${index + 1}`).trim(),
    subject,
    owner: assignment === 'open' ? '' : owner,
    assignment,
    claim: null,
    reviewRequests: [],
    handoffs: [],
    pendingReviewer: null,
    pendingReviewers: [],
    role: String(raw?.role ?? 'implementer').trim() || 'implementer',
    complexity,
    thinkingTier,
    reviewDepth,
    reviewProfile,
    resolvedReview: null,
    writeScopes,
    blockedBy,
    definitionOfDone,
    needsReview: raw?.needs_review !== false,
    reviewers,
    evidenceOptional: raw?.evidence_optional === true,
    status: W.ITEM_STATUS.PENDING,
    taskId: null,
    report: null,
    reportSeq: 0,
    reviews: [],
    reviewSeq: 0,
    overrideReason: null,
    repairLog: [],
    createdAt: null,
    updatedAt: null,
    reportedAt: null,
    approvedAt: null,
    approvedBy: null,
    planFirst: raw?.planFirst === true,
  }
}

/** Render the shared-task description for one item. */
export function taskDescription(state, item) {
  return [
    `Workflow run ${state.runId} — item ${item.id} (${item.role}).`,
    item.assignment === 'open' ? `Owner: (open queue — claim it with team_flow_work {action:"claim", item_id:"${item.id}"}).` : `Owner: ${item.owner}. Reviewers: ${item.reviewers.join(', ') || '(none)'}.`,
    '',
    'Definition of done:',
    ...item.definitionOfDone.map((entry) => `- ${entry}`),
    '',
    'Report with team_flow_report; do not complete this task before reporting.',
  ].join('\n')
}

/** Compact report shape returned to the model. */
export function reportView(item) {
  return {
    item_id: item.id,
    status: item.status,
    reported: item.report !== null,
    files: item.report?.files ?? [],
    commands: (item.report?.commands ?? []).map((command) => ({ command: command.command, exit_code: command.exitCode })),
    next_actions: [],
  }
}

/**
 * Build every tool definition for one plugin instance.
/**
 * Wrap raw tool definitions with JSON compaction and consecutive-failure breaker guidance.
 * @param {Array<object>} definitions
 * @returns {Array<object>}
 */
export function wrapToolDefinitions(definitions) {
  const consecutiveFailures = new Map()
  return definitions.map((definition) => ({
    ...definition,
    execute: async (args, exec) => {
      const callerId = exec?.agent?.id ?? exec?.agent?.session?.id ?? 'anonymous'
      const key = `${callerId}:${definition.name}`
      try {
        const result = await definition.execute(args, exec)
        consecutiveFailures.delete(key)
        return compactJson(result)
      } catch (err) {
        const count = (consecutiveFailures.get(key) ?? 0) + 1
        if (!consecutiveFailures.has(key) && consecutiveFailures.size >= FAILURE_TRACKER_MAX) {
          const oldest = consecutiveFailures.keys().next().value
          if (oldest !== undefined) consecutiveFailures.delete(oldest)
        }
        consecutiveFailures.set(key, count)
        if (count >= REPEATED_FAILURE_THRESHOLD) {
          const baseMsg = err instanceof Error ? err.message : String(err)
          const guided = new Error(
            `${baseMsg}\n\n[REPEATED_FAILURE_GUIDANCE] ${definition.name} has failed ${count} consecutive times for this member. Stop retrying identical calls; call team_flow_status to inspect current board state or team_flow_escalate { kind: "blocker", ... } if blocked.`,
            { cause: err },
          )
          if (err && typeof err === 'object' && 'code' in err && err.code !== undefined) {
            guided.code = err.code
          }
          throw guided
        }
        throw err
      }
    },
  }))
}
