/**
 * Model-facing tools of the Agent Team Workflow plugin.
 *
 * Each tool is a thin adapter: validate arguments, check Team identity and
 * role, then delegate to the pure engine in `workflow.js` and to the run store.
 * `team_*` tools owned by the shipped Agent Teams package keep their meaning;
 * this layer adds the workflow state machine, review ledger, and gates.
 */

import fs from 'node:fs'
import path from 'node:path'

import { runSettings } from './config.js'
import * as G from './git.js'
import { fireHooks } from './hooks.js'
import * as W from './workflow.js'
import {
  autoProvisionWorktrees,
  autoMergeApprovedWorktree,
  autoCleanupRunWorktrees,
  getWorktreeDiffSummary,
} from './worktree-manager.js'
import {
  approvedMessage,
  changesRequestedMessage,
  renderQueueBrief,
  renderReportMarkdown,
  renderReviewerBrief,
  renderWorkerBrief,
  roleGuidance,
  reviewRequestMessage,
} from './protocol.js'

/** Round-trip a tool result to plain lossless JSON (drops `undefined` members). */
function compactJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Declare one canonical output schema with compact model-facing JSON. */
function jsonOutput(schema) {
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
function resolveCaller(ctx, exec, toolName) {
  const agent = callingAgent(exec.agent, toolName)
  const membership = ctx.agentTeams.membership(agent)
  return { agent, membership }
}

function requireLead(membership, toolName) {
  if (membership.role !== 'lead') {
    throw new Error(`${toolName} is Lead-only; you are teammate "${membership.name}". Report the need to the Lead with send_message instead.`)
  }
}

async function requireRun(store, agent, toolName) {
  const state = await store.readState(agent)
  if (state === null) {
    throw new Error(`no Agent Team Workflow run exists yet; the Lead must call team_flow_plan first (${toolName})`)
  }
  return state
}

/** Refuse to mutate a run that already converged. */
function requireWritableRun(state, toolName) {
  if (state.phase === W.RUN_PHASE.FINALIZED) {
    throw new Error(`run ${state.runId} is finalized; ${toolName} cannot change it. Start a new run with team_flow_plan {replace:true} if more work is needed.`)
  }
}

/** Validate a spawnable member name (lower-kebab-case, never the Lead). */
function assertMemberName(name, field) {
  const value = String(name ?? '').trim()
  if (value === 'lead') throw new Error(`${field} cannot be "lead"; the Lead coordinates and gates`)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`${field} "${value}" is not a spawnable member name (lower-kebab-case, digits allowed)`)
  return value
}

/** Send one peer message, converting transport failures into a warning. */
async function sendPeer(ctx, agent, target, text, signal) {
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
async function staffEntries({ ctx, agent, entries, settings, signal }) {
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
function audienceFor(state, callerName) {
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
async function runHook(event, payload, { agent, settings, store }) {
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

function assertRoleAllowed(settings, state, memberName, toolName, action) {
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
function isLiveMember(ctx, agent, name) {
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
async function syncTaskComplete(ctx, agent, taskId) {
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
async function syncTaskReopen(ctx, agent, taskId) {
  if (taskId === null) return null
  try {
    const task = ctx.agentTeams.getTask(agent, taskId)
    if (task.status !== 'completed') return null
    await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'reopen' })
    return null
  } catch (error) {
    return `backing Team task ${taskId} was not reopened: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Truncate one model-supplied string before it enters the board. */
function clip(value, max) {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max) : text
}

/** Build a fresh run id. */
function makeRunId(now) {
  const stamp = now.replace(/[-:.TZ]/g, '').slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 6)
  return `run-${stamp}-${suffix}`
}

/** Normalize one requested work item into engine shape. */
function normalizeItem(raw, index) {
  const subject = String(raw?.subject ?? '').trim()
  const owner = String(raw?.owner ?? '').trim()
  const definitionOfDone = Array.isArray(raw?.definition_of_done) ? raw.definition_of_done.map((entry) => String(entry).trim()).filter(Boolean) : []
  const reviewers = Array.isArray(raw?.reviewers) ? [...new Set(raw.reviewers.map((entry) => String(entry).trim()).filter(Boolean))] : []
  const blockedBy = Array.isArray(raw?.blocked_by) ? [...new Set(raw.blocked_by.map((entry) => String(entry).trim()).filter(Boolean))] : []
  const writeScopes = Array.isArray(raw?.write_scopes) ? [...new Set(raw.write_scopes.map((entry) => W.normalizeScope(entry)).filter((entry) => entry.length > 0))] : []
  const assignment = raw?.assignment === 'open' ? 'open' : 'lead'
  return {
    id: String(raw?.id ?? `W${index + 1}`).trim(),
    subject,
    owner: assignment === 'open' ? '' : owner,
    assignment,
    claim: null,
    reviewRequests: [],
    handoffs: [],
    pendingReviewer: null,
    role: String(raw?.role ?? 'implementer').trim() || 'implementer',
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
function taskDescription(state, item) {
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
function reportView(item) {
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
 * @param options - `{ ctx, settings, store, version, tokenUsage?, orchestrator? }`.
 * @returns array of ToolDefinition-compatible objects.
 */
export function buildTools({ ctx, settings, store, version, tokenUsage = () => null, orchestrator = null }) {
  function triggerOrchestrator(agent) {
    if (orchestrator && typeof orchestrator.reconcile === 'function') {
      void orchestrator.reconcile(agent).catch(() => {})
    }
  }
  const definitions = [
    // ---------------------------------------------------------------- plan
    {
      name: 'team_flow_plan',
      description:
        'Lead-only. Create the standard workflow run: turn the objective into work items with disjoint write scopes, a definition of done, dependencies, and independent reviewers. Returns each item backing Team task id plus the exact spawn prompt and reviewer prompt to pass to spawn_teammate. Refuses dependency cycles, self-review, and write-scope overlap inside one execution wave.',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'The team-level objective, including what "done" means for the user.' },
          acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Verifiable team-level acceptance criteria (at least one).' },
          constraints: { type: 'array', items: { type: 'string' }, description: 'Hard constraints every member must respect.' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable short id such as W1; auto-assigned when omitted.' },
                subject: { type: 'string', description: 'One-line deliverable title.' },
                owner: { type: 'string', description: 'Teammate name that will do the work (never "lead"); omit when assignment is "open" so a peer claims it.' },
                assignment: { type: 'string', enum: ['lead', 'open'], description: 'Who picks the item: "lead" assigns owner now (default), "open" publishes it to the queue for a peer to claim.' },
                role: { type: 'string', description: 'implementer | verifier | researcher | architect | writer.' },
                write_scopes: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths this owner may modify. Must be disjoint from other items in the same wave.' },
                blocked_by: { type: 'array', items: { type: 'string' }, description: 'Item ids that must be approved first.' },
                definition_of_done: { type: 'array', items: { type: 'string' }, description: 'Checkable completion conditions (at least one).' },
                needs_review: { type: 'boolean', description: 'Default true. Set false only with reviewers empty and an articulated reason.' },
                reviewers: { type: 'array', items: { type: 'string' }, description: 'Independent reviewer member names; must not include the owner.' },
                evidence_optional: { type: 'boolean', description: 'Set true only for read-only/research items where no command can be run.' },
              },
              required: ['subject', 'definition_of_done'],
            },
            description: 'Work items; each becomes one shared Team task plus one owner brief (or an open-queue entry a peer claims).',
          },
          workers: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' } }, required: ['name'] },
              ],
            },
            description: 'Workers for the open-queue pool: a member name, or {name, role} to pick a configured role (provider/model + role prompt).',
          },
          replace: { type: 'boolean', description: 'Archive the existing run and start a new one.' },
        },
        required: ['objective', 'acceptance_criteria', 'items'],
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          phase: { type: 'string' },
          waves: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          items: { type: 'array', items: {} },
          spawn: { type: 'array', items: {} },
          queue_spawn: { type: 'array', items: {} },
          staffed: {},
          open_queue: { type: 'array', items: { type: 'string' } },
          reviewer_spawn: { type: 'array', items: {} },
          warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_plan')
        requireLead(membership, 'team_flow_plan')
        const now = new Date().toISOString()
        const rawItems = Array.isArray(args.items) ? args.items : []
        const items = rawItems.map((raw, index) => normalizeItem(raw, index))
        const roleAssignments = {}
        const poolNames = []
        const poolEntries = (Array.isArray(args.workers) ? args.workers : []).map((entry) => {
          const name = typeof entry === 'string' ? entry.trim() : typeof entry?.name === 'string' ? entry.name.trim() : ''
          const role = typeof entry === 'object' && entry !== null && typeof entry.role === 'string' ? entry.role.trim() : ''
          if (name.length === 0) throw new Error('workers[] entries need a member name')
          assertMemberName(name, 'workers[]')
          if (role.length > 0) {
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role)) throw new Error(`worker role "${role}" is not lower-kebab-case`)
            if (settings.roles[role] === undefined) throw new Error(`unknown role "${role}"; configure it under roles in the plugin config`)
            roleAssignments[name] = role
          }
          return { name, role }
        })
        for (const entry of poolEntries) {
          if (!poolNames.includes(entry.name)) poolNames.push(entry.name)
        }
        if (poolEntries.filter((entry) => entry.name.length > 0).length !== new Set(poolEntries.map((entry) => entry.name)).size) {
          throw new Error('workers repeats a member name')
        }
        const providerFor = (role) => {
          const configured = typeof role === 'string' && role.length > 0 ? settings.roles[role]?.provider : undefined
          return typeof configured === 'string' && configured.length > 0 ? configured : settings.freshProvider
        }
        const effective = runSettings(settings)
        for (const item of items) {
          await runHook('taskCreated', {
            item: { id: item.id, subject: item.subject, role: item.role, owner: item.owner ?? null, assignment: item.assignment, writeScopes: item.writeScopes },
            objective: String(args.objective ?? ''),
            actor: membership.name,
          }, { agent, settings: effective, store })
        }
        const plan = {
          objective: String(args.objective ?? '').trim(),
          acceptanceCriteria: (Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria : []).map((entry) => String(entry).trim()).filter(Boolean),
          constraints: (Array.isArray(args.constraints) ? args.constraints : []).map((entry) => String(entry).trim()).filter(Boolean),
          items,
        }
        const validation = W.validatePlan(plan, effective)
        if (validation.errors.length > 0) {
          throw new Error(`the plan violates the workflow rules:\n- ${validation.errors.join('\n- ')}`)
        }

        const outcome = await store.lock(agent, async () => {
          const existing = await store.readState(agent)
          if (existing !== null && args.replace !== true) {
            throw new Error(`run ${existing.runId} already exists (phase ${existing.phase}). Call team_flow_status to resume it, or pass replace:true to archive it and start a new run.`)
          }
          const archivedPaths = []
          if (existing !== null) {
            existing.phase = W.RUN_PHASE.ABORTED
            const saved = await store.writeArtifact(agent, `teams/${store.teamIdOf(agent)}/runs/${existing.runId}.json`, `${JSON.stringify(existing, null, 2)}\n`)
            if (saved !== null) archivedPaths.push(saved)
          }

          const runId = makeRunId(now)
          const state = W.createRun({
            workflowVersion: W.WORKFLOW_VERSION,
            runId,
            teamId: store.teamIdOf(agent),
            objective: plan.objective,
            acceptanceCriteria: plan.acceptanceCriteria,
            constraints: plan.constraints,
            settings: effective,
            items,
            actor: membership.name,
            now,
            artifacts: { statePath: store.statePath(agent), reportPath: null, root: store.describeRoot(agent) },
          })
          state.staffPool = [...poolNames]

          // Create backing shared tasks in wave order so dependencies exist first.
          const created = []
          const taskIdByItem = new Map()
          try {
            for (const wave of validation.waves) {
              for (const itemId of wave) {
                const item = items.find((candidate) => candidate.id === itemId)
                const blockedBy = item.blockedBy.map((blocker) => taskIdByItem.get(blocker)).filter((value) => typeof value === 'string')
                const task = await ctx.agentTeams.createTask(agent, {
                  subject: item.subject.slice(0, 200),
                  description: taskDescription(state, item).slice(0, 16_384),
                  ...(blockedBy.length === 0 ? {} : { blockedBy }),
                  ...(item.writeScopes.length === 0 ? {} : { writeScopes: item.writeScopes }),
                  signal: exec.signal,
                })
                taskIdByItem.set(item.id, task.id)
                item.taskId = task.id
                created.push(task.id)
              }
            }
          } catch (error) {
            for (const taskId of created.reverse()) {
              try {
                const task = ctx.agentTeams.getTask(agent, taskId)
                await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'delete' })
              } catch {
                /* rollback is best effort */
              }
            }
            throw new Error(`could not create the backing Team tasks: ${error instanceof Error ? error.message : String(error)}`)
          }
          for (const item of items) {
            item.createdAt = now
            item.updatedAt = now
          }
          W.appendEvent(state, { at: now, type: 'run/tasks-created', actor: membership.name, detail: `${created.length} backing task(s)` })
          await store.writeState(agent, state)

          // Only after the new board is durable may the archived run's tasks be
          // removed. Retried in passes because the board refuses to delete a
          // blocker that still has dependents.
          if (existing !== null) {
            let pendingTasks = existing.items.map((item) => item.taskId).filter((taskId) => typeof taskId === 'string')
            for (let pass = 0; pass < 4 && pendingTasks.length > 0; pass += 1) {
              const remaining = []
              for (const taskId of pendingTasks) {
                try {
                  const task = ctx.agentTeams.getTask(agent, taskId)
                  if (task.status === 'deleted') continue
                  await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'delete' })
                } catch {
                  remaining.push(taskId)
                }
              }
              if (remaining.length === pendingTasks.length) break
              pendingTasks = remaining
            }
          }
          return { state, archivedPaths }
        })
        let state = outcome.state
        const archived = outcome.archivedPaths

        // Auto-provision worktrees if enabled
        const cwd = store.workingDir(agent)
        await autoProvisionWorktrees({ cwd, state, agent, store }).catch(() => {})
        state = (await store.readState(agent)) ?? state

        const openItems = items.filter((item) => item.assignment === 'open')
        const assignedItems = items.filter((item) => item.assignment !== 'open')
        const workerNames = new Set(assignedItems.map((item) => item.owner))
        const workerSpawn = assignedItems.map((item) => {
          const reviewing = items.filter((other) => other.reviewers.includes(item.owner)).map((other) => other.id)
          const brief = renderWorkerBrief(state, item, reviewing, settings.workerContext)
          const role = roleAssignments[item.owner] ?? (settings.roles[item.role] === undefined ? '' : item.role)
          return {
            kind: 'worker',
            item_id: item.id,
            name: brief.name,
            description: brief.description,
            context: brief.context,
            provider: providerFor(role),
            prompt: brief.prompt + roleGuidance(settings, role),
          }
        })
        const queueSpawn = openItems.length === 0 ? [] : poolEntries.map((entry) => {
          const brief = renderQueueBrief(state, entry.name, openItems)
          const role = roleAssignments[entry.name] ?? entry.role ?? ''
          return {
            kind: 'worker-pool',
            name: brief.name,
            description: brief.description,
            context: brief.context,
            provider: providerFor(role),
            prompt: brief.prompt + roleGuidance(settings, role),
          }
        })
        const allReviewers = W.collectReviewers(items)
        const reviewerSpawn = allReviewers
          .filter((reviewer) => reviewer !== 'lead' && !workerNames.has(reviewer) && !poolNames.includes(reviewer))
          .map((reviewer) => {
            const reviewed = items.filter((item) => item.reviewers.includes(reviewer))
            const brief = renderReviewerBrief(state, reviewer, reviewed)
            const role = roleAssignments[reviewer] ?? (settings.roles.reviewer === undefined ? '' : 'reviewer')
            return {
              kind: 'reviewer',
              reviews: reviewed.map((item) => item.id),
              name: brief.name,
              description: brief.description,
              context: brief.context,
              provider: providerFor(role),
              prompt: brief.prompt + roleGuidance(settings, role),
            }
          })
        const autoSpawn = args.auto_spawn === undefined ? settings.autoStaff === true : args.auto_spawn === true
        const staffInputs = [
          ...workerSpawn.map((entry) => ({ ...entry, kind: 'worker' })),
          ...queueSpawn.map((entry) => ({ ...entry, kind: 'worker-pool' })),
          ...reviewerSpawn.map((entry) => ({ ...entry, kind: 'reviewer' })),
        ]
        const staffed = autoSpawn
          ? await staffEntries({ ctx, agent, entries: staffInputs, settings, signal: exec.signal })
          : { spawned: [], woken: [], skipped: [], failed: [], needs_spawn: staffInputs.map((entry) => ({ name: entry.name, kind: entry.kind, reason: 'auto_staff disabled' })) }
        const dualRole = allReviewers.filter((reviewer) => workerNames.has(reviewer))
        const leadReviews = allReviewers.includes('lead')
        const reviewerNotes = [
          ...(dualRole.length === 0 ? [] : [`Spawn ${dualRole.join(', ')} once: they own work items and also review, so their review duty is already inside their worker brief.`]),
          ...(leadReviews ? ['The Lead itself reviews at least one item; no extra spawn is needed for that.'] : []),
        ]
        const spawnContexts = [...new Set(workerSpawn.map((entry) => entry.context))].join('/')
        const nextActions = [
          ...(staffed.spawned.length > 0 || staffed.woken.length > 0
            ? [`Team staffed automatically: spawned ${staffed.spawned.map((entry) => `${entry.name}(${entry.kind})`).join(', ') || '(none)'}; woke ${staffed.woken.join(', ') || '(none)'}.`]
            : []),
          ...(staffed.needs_spawn.length > 0
            ? [`Capacity limit: ${staffed.needs_spawn.map((entry) => entry.name).join(', ')} need manual handling (${staffed.needs_spawn[0].reason}).`]
            : []),
          ...(staffed.failed.length > 0
            ? [`Staffing failures: ${staffed.failed.map((entry) => `${entry.name}: ${entry.error}`).join('; ')}`]
            : []),
          ...(workerSpawn.length > 0
            ? [`Spawn wave 1 owners now: ${(validation.waves[0] ?? []).filter((id) => assignedItems.some((item) => item.id === id)).join(', ') || '(none)'}. Pass each returned spawn prompt verbatim with spawn_teammate and its own context value (${spawnContexts || settings.workerContext}).`]
            : []),
          ...(openItems.length === 0
            ? []
            : [queueSpawn.length > 0
                ? `Open queue: ${openItems.map((item) => item.id).join(', ')}. Spawn the worker pool (${poolNames.join(', ')}) with the returned queue prompts and let them claim items with team_flow_work {action:"claim"}; do not assign by hand.`
                : `Open queue: ${openItems.map((item) => item.id).join(', ')}. Spawn workers yourself (pass workers:[...] next time for ready-made queue prompts) and tell them to claim with team_flow_work {action:"claim"}.`]),
          ...(reviewerSpawn.length > 0 ? [`Spawn reviewers upfront so review notifications can reach them: ${reviewerSpawn.map((entry) => entry.name).join(', ')}.`] : []),
          ...reviewerNotes,
          'Then call wait_agent and re-read team_flow_status after each change; do not do the workers\' edits yourself.',
          ...validation.warnings,
        ]
        triggerOrchestrator(agent)
        return {
          run_id: state.runId,
          phase: state.phase,
          waves: validation.waves,
          items: items.map((item) => ({ id: item.id, subject: item.subject, owner: item.owner, task_id: item.taskId, reviewers: item.reviewers, write_scopes: item.writeScopes })),
          spawn: workerSpawn,
          queue_spawn: queueSpawn,
          staffed,
          open_queue: openItems.map((item) => item.id),
          reviewer_spawn: reviewerSpawn,
          warnings: [...archived.map((path) => `archived previous run state to ${path}`), ...validation.warnings],
          next_actions: nextActions,
        }
      },
    },

    // -------------------------------------------------------------- status
    {
      name: 'team_flow_status',
      description:
        'Read the workflow board: run phase, every work item with review state, your assigned actions, open escalations, and Team member status. Call this first, and re-read it after every peer message. next_actions is the authoritative assignment for the calling member.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Optional work item id; when given, its full report and review records are included.' },
        },
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          workflow_version: { type: 'integer' },
          run_id: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
          phase: { type: 'string' },
          objective: { type: 'string' },
          acceptance_criteria: { type: 'array', items: { type: 'string' } },
          me: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' } } },
          counts: { type: 'object' },
          items: { type: 'array', items: {} },
          escalations: { type: 'array', items: {} },
          team: { type: 'array', items: {} },
          collaboration: {},
          next_actions: { type: 'array', items: { type: 'string' } },
          artifacts: {},
          settings: {},
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_status')
        let state = await store.readState(agent)
        if (state !== null) {
          const members = (() => { try { return ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, role: member.role })) } catch { return [] } })()
          const settled = W.settleExpiredProposals(state, { now: new Date().toISOString(), settings: state.settings, members })
          if (settled.length > 0) await store.writeState(agent, state)
        }
        let members = []
        try {
          members = ctx.agentTeams.listMembers(agent).map((member) => ({
            name: member.name,
            role: member.role,
            status: member.status,
            context: member.context,
            agent: (() => {
              try {
                return ctx.agents.get(member.id)
              } catch {
                return undefined
              }
            })(),
          }))
        } catch {
          members = []
        }
        const artifacts = {
          root: store.describeRoot(agent),
          team_dir: store.teamDir(agent),
          state_path: settings.writeArtifacts ? store.statePath(agent) : null,
          report_path: state?.artifacts?.reportPath ?? null,
        }
        const detailItemId = typeof args?.item_id === 'string' && args.item_id.length > 0 ? args.item_id : undefined
        if (state !== null && detailItemId !== undefined) W.findItem(state, detailItemId)
        const tasksById = new Map()
        try {
          for (const task of ctx.agentTeams.listTasks(agent)) tasksById.set(task.id, { id: task.id, revision: task.revision, status: task.status })
        } catch {
          /* a missing board only removes revision detail */
        }
        if (state === null) {
          return {
            workflow_version: W.WORKFLOW_VERSION,
            run_id: null,
            phase: 'none',
            objective: '',
            acceptance_criteria: [],
            me: { name: membership.name, role: membership.role },
            counts: { total: 0, approved: 0, pending: 0, in_review: 0, changes_requested: 0, escalated: 0 },
            items: [],
            escalations: [],
            team: members,
            next_actions:
              membership.role === 'lead'
                ? [`No workflow run exists. Call team_flow_plan to create one; keep the team at 1 implementation + 1 review + 1 verification item unless parallelism is justified.`]
                : ['No workflow run exists yet. Wait for the Lead to call team_flow_plan and send your spawn brief.'],
            artifacts,
            settings,
          }
        }
        const status = W.buildStatus(state, {
          me: { name: membership.name, role: membership.role },
          role: membership.role,
          settings: state.settings,
          members,
          artifacts,
          tasksById,
          detailItemId,
        })
        return { ...status, workflow_version: W.WORKFLOW_VERSION, artifacts, settings }
      },
    },

    // -------------------------------------------------------------- report
    {
      name: 'team_flow_report',
      description:
        'Owner-only. Submit the structured work report for your item: summary, changed files, verification commands with integer exit codes, quoted evidence, open questions, and risks. This is the deliverable a reviewer inspects; it also completes the backing Team task and hands the item to its reviewer.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Your workflow item id, e.g. W1.' },
          summary: { type: 'string', description: 'What you did and what is now true, in plain language.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files you created or modified.' },
          commands: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'Exact command line.' },
                exit_code: { type: 'integer', description: 'Observed exit code.' },
                note: { type: 'string', description: 'Optional one-line interpretation.' },
              },
              required: ['command', 'exit_code'],
            },
            description: 'Verification commands you actually ran.',
          },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Quoted output, test names, or artifact paths that prove the claims.' },
          open_questions: { type: 'array', items: { type: 'string' }, description: 'Anything still unresolved, including assumptions you need confirmed.' },
          risks: { type: 'array', items: { type: 'string' }, description: 'Known risks, residual defects, or follow-up work.' },
          deviation: { type: 'string', description: 'Any deviation from the brief (scope, approach, DoD) and why.' },
        },
        required: ['item_id', 'summary', 'files'],
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          status: { type: 'string' },
          reported: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } },
          commands: { type: 'array', items: {} },
          review_round: {},
          reviewer: {},
          scope_warnings: { type: 'array', items: { type: 'string' } },
          sequence_warnings: { type: 'array', items: { type: 'string' } },
          sync_warnings: { type: 'array', items: { type: 'string' } },
          notified: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_report')
        let outcome = null
        const now = new Date().toISOString()
        const commands = (Array.isArray(args.commands) ? args.commands : []).map((command) => ({
          command: String(command?.command ?? '').trim(),
          exitCode: Number.isInteger(command?.exit_code) ? command.exit_code : null,
          note: command?.note === undefined ? null : String(command.note),
        }))
        const files = (Array.isArray(args.files) ? args.files : []).map((file) => W.normalizePath(file)).filter((file) => file.length > 0)
        const report = {
          summary: clip(String(args.summary ?? '').trim(), 4000),
          files,
          commands,
          evidence: (Array.isArray(args.evidence) ? args.evidence : []).map((entry) => clip(entry, 1000)),
          openQuestions: (Array.isArray(args.open_questions) ? args.open_questions : []).map((entry) => clip(entry, 1000)),
          risks: (Array.isArray(args.risks) ? args.risks : []).map((entry) => clip(entry, 1000)),
          deviation: args.deviation === undefined ? null : clip(args.deviation, 2000),
        }
        const state = await store.mutateState(agent, (current) => {
          if (current === null) throw new Error('no workflow run exists yet; the Lead must call team_flow_plan first')
          requireWritableRun(current, 'team_flow_report')
          assertRoleAllowed(settings, current, membership.name, 'team_flow_report')
          const item = W.findItem(current, String(args.item_id ?? ''))
          if (item.owner !== membership.name) {
            throw new Error(`item "${item.id}" belongs to "${item.owner}"; only its owner may report it. If the owner is stuck, message it or escalate.`)
          }
          if (item.status === W.ITEM_STATUS.APPROVED) throw new Error(`item "${item.id}" is already approved; do not report it again`)
          const applied = W.applyReport(current, { itemId: item.id, caller: membership.name, report, now, settings: current.settings })
          outcome = applied
          return current
        })
        const item = outcome.item
        const scopeWarnings = item.report.files.filter((file) => item.writeScopes.length > 0 && !item.writeScopes.some((scope) => W.pathInScope(file, scope)))
        const syncWarnings = []
        const completed = await syncTaskComplete(ctx, agent, item.taskId)
        if (completed !== null) syncWarnings.push(completed)
        const notified = []
        if (item.status === W.ITEM_STATUS.ESCALATED) {
          const escalation = state.escalations.at(-1)
          const failure = await sendPeer(
            ctx,
            agent,
            'lead',
            `[BLOCKER] ${item.id} "${item.subject}" needs arbitration after reporting (escalation ${escalation?.id ?? 'unknown'}).\n${escalation?.detail ?? ''}\nCall team_flow_status, then resolve it with team_flow_escalate or record a gate override.`,
            exec.signal,
          )
          if (failure === null) notified.push('lead')
          else syncWarnings.push(failure)
        } else if (outcome.review !== null && outcome.nextReviewer !== null) {
          if (!isLiveMember(ctx, agent, outcome.nextReviewer)) {
            syncWarnings.push(`reviewer "${outcome.nextReviewer}" is not in the roster; spawn it with the reviewer prompt from team_flow_plan, then the author can re-report or the Lead can re-notify.`)
          } else if (settings.autoNotify) {
            const cwd = store.workingDir(agent)
            const diff = await getWorktreeDiffSummary({ cwd, state, item }).catch(() => null)
            const failure = await sendPeer(ctx, agent, outcome.nextReviewer, reviewRequestMessage(state, item, diff), exec.signal)
            if (failure === null) notified.push(outcome.nextReviewer)
            else syncWarnings.push(failure)
          }
        }
        const status = W.buildStatus(state, {
          me: { name: membership.name, role: membership.role },
          role: membership.role,
          settings: state.settings,
          members: [],
          artifacts: {},
        })
        triggerOrchestrator(agent)
        return {
          ...reportView(item),
          status: item.status,
          review_round: outcome.review?.round ?? null,
          reviewer: outcome.nextReviewer,
          scope_warnings: scopeWarnings,
          sequence_warnings: item.report?.sequenceWarnings ?? [],
          sync_warnings: syncWarnings,
          notified,
          next_actions: item.status === W.ITEM_STATUS.IN_REVIEW ? ['Stop and let the reviewer work; the Lead will message you if changes are requested.'] : status.next_actions,
        }
      },
    },

    // ------------------------------------------------------- review submit
    {
      name: 'team_flow_review_submit',
      description:
        'Reviewer-only. Submit one verdict for the review assigned to you: approve | approve_with_nits | request_changes | block, with severity-tagged findings that name a file and line, plus the evidence you personally checked. A non-approving verdict must carry at least one finding.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Item id you were asked to review.' },
          verdict: { type: 'string', enum: ['approve', 'approve_with_nits', 'request_changes', 'block'], description: 'Review verdict.' },
          summary: { type: 'string', description: 'Two or three sentences a busy Lead can act on.' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Short id such as F1; required for the author to respond.' },
                severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'], description: 'Severity of the finding.' },
                file: { type: 'string', description: 'Workspace-relative file the finding is about.' },
                line: { type: 'integer', description: 'Line number when applicable.' },
                claim: { type: 'string', description: 'Precise statement of the defect, with the reasoning or reproduction.' },
                suggestion: { type: 'string', description: 'Concrete fix direction.' },
              },
              required: ['id', 'severity', 'claim'],
            },
            description: 'Findings; every non-approving verdict needs at least one.',
          },
          evidence_checked: { type: 'array', items: { type: 'string' }, description: 'What you actually inspected or re-ran: files read, commands run, tests executed.' },
        },
        required: ['item_id', 'verdict', 'summary', 'findings', 'evidence_checked'],
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          verdict: { type: 'string' },
          item_status: { type: 'string' },
          next_reviewer: {},
          notified: { type: 'array', items: { type: 'string' } },
          sync_warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_review_submit')
        const now = new Date().toISOString()
        const findings = (Array.isArray(args.findings) ? args.findings : []).map((finding, index) => ({
          id: finding?.id === undefined ? `F${index + 1}` : String(finding.id),
          severity: String(finding?.severity ?? 'major'),
          file: finding?.file === undefined ? null : String(finding.file),
          line: Number.isInteger(finding?.line) ? finding.line : null,
          claim: clip(String(finding?.claim ?? '').trim(), 2000),
          suggestion: finding?.suggestion === undefined ? null : clip(finding.suggestion, 1000),
        }))
        for (const finding of findings) {
          if (!W.SEVERITIES.includes(finding.severity)) throw new Error(`finding "${finding.id}" has severity "${finding.severity}"; use one of ${W.SEVERITIES.join('/')}`)
          if (finding.claim.length === 0) throw new Error(`finding "${finding.id}" needs a non-empty claim`)
        }
        if (!W.VERDICTS.includes(args.verdict)) throw new Error(`verdict must be one of ${W.VERDICTS.join('/')}`)
        let outcome = null
        let state = await store.mutateState(agent, async (current) => {
          if (current === null) throw new Error('no workflow run exists yet')
          requireWritableRun(current, 'team_flow_review_submit')
          const item = W.findItem(current, String(args.item_id ?? ''))
          const pending = W.pendingReview(item)
          if (pending === null) throw new Error(`item "${item.id}" has no pending review for you`)
          if (pending.reviewer !== membership.name) {
            throw new Error(`the pending review of "${item.id}" is assigned to "${pending.reviewer}", not "${membership.name}". Do not review items assigned to a peer.`)
          }
          const evidenceChecked = (Array.isArray(args.evidence_checked) ? args.evidence_checked : []).map((entry) => String(entry))
          if (W.isApproving(args.verdict) && evidenceChecked.length === 0 && current.settings.requireReviewEvidence !== false) {
            throw new W.WorkflowError(
              'an approving verdict must declare what you actually inspected in evidence_checked (read the files, re-run a command, or quote the evidence you checked)',
              'WORKFLOW_REVIEW_EVIDENCE_REQUIRED',
            )
          }
          if (W.isApproving(args.verdict)) {
            await runHook('taskCompleted', {
              item: { id: item.id, subject: item.subject, owner: item.owner, writeScopes: item.writeScopes, status: item.status },
              verdict: args.verdict,
              reviewer: membership.name,
            }, { agent, settings: current.settings, store })
          }
          outcome = W.applyReviewSubmit(current, {
            itemId: item.id,
            reviewer: membership.name,
            verdict: args.verdict,
            summary: clip(String(args.summary ?? '').trim(), 4000),
            findings,
            evidenceChecked,
            now,
          })
          return current
        })
        const item = outcome.item
        const syncWarnings = []
        if (item.status === W.ITEM_STATUS.CHANGES_REQUESTED) {
          const reopened = await syncTaskReopen(ctx, agent, item.taskId)
          if (reopened !== null) syncWarnings.push(reopened)
        }
        const notified = []
        if (item.status === W.ITEM_STATUS.CHANGES_REQUESTED) {
          const failure = settings.autoNotify ? await sendPeer(ctx, agent, item.owner, changesRequestedMessage(state, item, outcome.review), exec.signal) : null
          if (failure === null && settings.autoNotify) notified.push(item.owner)
          else if (failure !== null) syncWarnings.push(failure)
        } else if (item.status === W.ITEM_STATUS.APPROVED) {
          const failure = settings.autoNotify ? await sendPeer(ctx, agent, item.owner, approvedMessage(state, item, outcome.review), exec.signal) : null
          if (failure === null && settings.autoNotify) notified.push(item.owner)
          else if (failure !== null) syncWarnings.push(failure)
          const cwd = store.workingDir(agent)
          await autoMergeApprovedWorktree({ cwd, state, itemId: item.id, agent, store }).catch(() => {})
          state = (await store.readState(agent)) ?? state
          if (state?.settings?.worktreeIsolation === 'serial') {
            await autoProvisionWorktrees({ cwd, state, agent, store }).catch(() => {})
            state = (await store.readState(agent)) ?? state
          }
        }
        if (outcome.nextReviewer !== null && outcome.nextReviewer !== undefined) {
          if (!isLiveMember(ctx, agent, outcome.nextReviewer)) syncWarnings.push(`next reviewer "${outcome.nextReviewer}" is not in the roster`)
          else if (settings.autoNotify) {
            const cwd = store.workingDir(agent)
            const diff = await getWorktreeDiffSummary({ cwd, state, item }).catch(() => null)
            const failure = await sendPeer(ctx, agent, outcome.nextReviewer, reviewRequestMessage(state, item, diff), exec.signal)
            if (failure === null) notified.push(outcome.nextReviewer)
            else syncWarnings.push(failure)
          }
        }
        const status = W.buildStatus(state, {
          me: { name: membership.name, role: membership.role },
          role: membership.role,
          settings: state.settings,
          members: [],
          artifacts: {},
        })
        triggerOrchestrator(agent)
        return {
          item_id: item.id,
          verdict: outcome.review.verdict,
          item_status: item.status,
          next_reviewer: outcome.nextReviewer ?? null,
          notified,
          sync_warnings: syncWarnings,
          next_actions: status.next_actions,
        }
      },
    },

    // ----------------------------------------------------- review respond
    {
      name: 'team_flow_review_respond',
      description:
        'Owner-only. Answer every open review finding of your item: fixed | rebut | accepted_risk, each with the evidence that supports it. When all findings are answered the reviewer gets the next round; a rebutted blocker, or an exhausted round budget, escalates to the Lead instead.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Your item id.' },
          responses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                finding_id: { type: 'string', description: 'Finding id from the review.' },
                state: { type: 'string', enum: ['fixed', 'rebut', 'accepted_risk'], description: 'What you did about it.' },
                evidence: { type: 'string', description: 'Command, diff, or quoted output that supports this response.' },
                note: { type: 'string', description: 'Short rationale, mandatory for rebut and accepted_risk.' },
              },
              required: ['finding_id', 'state'],
            },
            description: 'One response per open finding.',
          },
        },
        required: ['item_id', 'responses'],
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          item_status: { type: 'string' },
          next_round: {},
          next_reviewer: {},
          escalated: { type: 'boolean' },
          notified: { type: 'array', items: { type: 'string' } },
          sync_warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_review_respond')
        const now = new Date().toISOString()
        const responses = (Array.isArray(args.responses) ? args.responses : []).map((response) => ({
          findingId: String(response?.finding_id ?? ''),
          state: String(response?.state ?? ''),
          evidence: response?.evidence === undefined ? null : clip(response.evidence, 2000),
          note: response?.note === undefined ? null : clip(response.note, 2000),
        }))
        for (const response of responses) {
          if (!W.FINDING_RESOLUTIONS.includes(response.state)) throw new Error(`response for "${response.findingId}" has state "${response.state}"; use one of ${W.FINDING_RESOLUTIONS.join('/')}`)
          if ((response.state === 'rebut' || response.state === 'accepted_risk') && (response.note === null || response.note.length === 0)) {
            throw new Error(`response for "${response.findingId}" is ${response.state} and needs a note explaining why`)
          }
        }
        let outcome = null
        let state = await store.mutateState(agent, async (current) => {
          if (current === null) throw new Error('no workflow run exists yet')
          requireWritableRun(current, 'team_flow_review_respond')
          const item = W.findItem(current, String(args.item_id ?? ''))
          if (item.owner !== membership.name) throw new Error(`item "${item.id}" belongs to "${item.owner}"; only the author may answer its review`)
          outcome = W.applyReviewRespond(current, { itemId: item.id, author: membership.name, responses, now, settings: current.settings })
          return current
        })
        const item = outcome.item
        const syncWarnings = []
        const notified = []
        if (outcome.escalated) {
          const escalation = state.escalations.at(-1)
          const failure = await sendPeer(
            ctx,
            agent,
            'lead',
            `[BLOCKER] ${item.id} "${item.subject}" needs arbitration (escalation ${escalation?.id ?? 'unknown'}).\n${escalation?.detail ?? ''}\nCall team_flow_status, then resolve it with team_flow_escalate or record a gate override.`,
            exec.signal,
          )
          if (failure === null) notified.push('lead')
          else syncWarnings.push(failure)
        } else if (outcome.nextReviewer !== null && outcome.nextReviewer !== undefined) {
          if (!isLiveMember(ctx, agent, outcome.nextReviewer)) syncWarnings.push(`reviewer "${outcome.nextReviewer}" is not in the roster`)
          else if (settings.autoNotify) {
            const cwd = store.workingDir(agent)
            const diff = await getWorktreeDiffSummary({ cwd, state, item }).catch(() => null)
            const failure = await sendPeer(ctx, agent, outcome.nextReviewer, reviewRequestMessage(state, item, diff), exec.signal)
            if (failure === null) notified.push(outcome.nextReviewer)
            else syncWarnings.push(failure)
          }
        }
        const status = W.buildStatus(state, {
          me: { name: membership.name, role: membership.role },
          role: membership.role,
          settings: state.settings,
          members: [],
          artifacts: {},
        })
        triggerOrchestrator(agent)
        return {
          item_id: item.id,
          item_status: item.status,
          next_round: outcome.nextReview?.round ?? null,
          next_reviewer: outcome.nextReviewer ?? null,
          escalated: outcome.escalated === true,
          notified,
          sync_warnings: syncWarnings,
          next_actions: status.next_actions,
        }
      },
    },

    // ---------------------------------------------------------------- gate
    {
      name: 'team_flow_gate',
      description:
        'Lead-only. Evaluate the quality gates (report presence, evidence quality, reviewer approval, unresolved findings, write-scope discipline, blocking escalations) and optionally finalize: only a passing gate may converge the run and write the report. Overrides are recorded with a reason and still show as overridden in the report.',
      parameters: {
        type: 'object',
        properties: {
          finalize: { type: 'boolean', description: 'Write the report and converge the run when every gate passes.' },
          overrides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                item_id: { type: 'string', description: 'Item whose failures the Lead accepts.' },
                reason: { type: 'string', description: 'Why the remaining failures are acceptable; recorded in the report.' },
              },
              required: ['item_id', 'reason'],
            },
            description: 'Explicit Lead risk acceptance for specific items.',
          },
        },
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          pass: { type: 'boolean' },
          finalized: { type: 'boolean' },
          item_gates: { type: 'array', items: {} },
          team_failures: { type: 'array', items: { type: 'string' } },
          report_path: {},
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_gate')
        requireLead(membership, 'team_flow_gate')
        const now = new Date().toISOString()
        const overrides = (Array.isArray(args.overrides) ? args.overrides : []).map((override) => ({
          itemId: String(override?.item_id ?? ''),
          reason: String(override?.reason ?? '').trim(),
        }))
        for (const override of overrides) if (override.reason.length === 0) throw new Error(`override for "${override.itemId}" needs a reason`)

        let nativeTasks = []
        let members = []
        try {
          nativeTasks = ctx.agentTeams.listTasks(agent).map((task) => ({ id: task.id, status: task.status, revision: task.revision }))
        } catch {
          nativeTasks = []
        }
        try {
          members = ctx.agentTeams.listMembers(agent).map((member) => ({
            name: member.name,
            role: member.role,
            status: member.status,
            context: member.context,
            agent: (() => {
              try {
                return ctx.agents.get(member.id)
              } catch {
                return undefined
              }
            })(),
          }))
        } catch {
          members = []
        }

        let gate = null
        let reportPath = null
        let state = await store.mutateState(agent, async (current) => {
          if (current === null) throw new Error('no workflow run exists yet')
          for (const override of overrides) W.findItem(current, override.itemId)
          // Capture token usage (when the Host exposes the token-meter projection)
          // so the gate can enforce budgets and the board can show real numbers.
          const usage = { capturedAt: now, members: {}, totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
          const readUsage = tokenUsage?.()
          for (const member of members) {
            if (typeof readUsage !== 'function') break
            const raw = readUsage(member.agent)
            if (raw === null || raw === undefined) continue
            // The token-meter projection exposes `{ totals, last }`; keep only
            // the flat bucket totals so budgets and the board agree.
            const totals = raw.totals !== undefined && raw.totals !== null && typeof raw.totals === 'object' ? raw.totals : raw
            usage.members[member.name] = {
              uncachedInputTokens: Number.isFinite(totals.uncachedInputTokens) ? totals.uncachedInputTokens : 0,
              outputTokens: Number.isFinite(totals.outputTokens) ? totals.outputTokens : 0,
              cacheReadTokens: Number.isFinite(totals.cacheReadTokens) ? totals.cacheReadTokens : 0,
              cacheWriteTokens: Number.isFinite(totals.cacheWriteTokens) ? totals.cacheWriteTokens : 0,
            }
            for (const key of Object.keys(usage.totals)) usage.totals[key] += Number.isFinite(totals[key]) ? totals[key] : 0
          }
          current.usage = usage
          gate = W.evaluateGates(current, { settings: current.settings, members, nativeTasks, overrides, now })
          // Worktree isolation is only real if reported artifacts actually live
          // in the item's worktree; a report pointing at the shared checkout is
          // a scope violation, not a parallel result.
          if ((current.settings.worktreeIsolation ?? 'off') !== 'off') {
            for (const item of current.items) {
              const worktree = item.git?.worktreePath
              if (typeof worktree !== 'string' || worktree.length === 0 || item.report === null || item.report === undefined) continue
              const files = Array.isArray(item.report.files) ? item.report.files : []
              const missing = files.filter((file) => {
                try {
                  return !fs.existsSync(path.resolve(worktree, W.normalizePath(file)))
                } catch {
                  return true
                }
              })
              if (missing.length === 0) continue
              const itemGate = gate.itemGates.find((entry) => entry.id === item.id)
              if (itemGate !== undefined) {
                itemGate.pass = false
                itemGate.failures.push(`reported files missing from the item worktree: ${missing.join(', ')}`)
                gate.pass = false
              }
            }
          }
          const tokenTotal = (totals) => ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((sum, key) => sum + (Number.isFinite(totals?.[key]) ? totals[key] : 0), 0)
          const budget = { perMember: current.settings.tokenBudgetPerMember, perRun: current.settings.tokenBudgetPerRun }
          if (budget.perMember > 0) {
            for (const [name, totals] of Object.entries(usage.members)) {
              const used = tokenTotal(totals)
              if (used > budget.perMember) {
                gate.pass = false
                gate.teamFailures.push(`member "${name}" used ${used} tokens (budget ${budget.perMember})`)
              }
            }
          }
          if (budget.perRun > 0 && tokenTotal(usage.totals) > budget.perRun) {
            gate.pass = false
            gate.teamFailures.push(`run used ${tokenTotal(usage.totals)} tokens (budget ${budget.perRun})`)
          }
          if (args.finalize === true && gate.pass) {
            for (const override of overrides) {
              const item = W.findItem(current, override.itemId)
              item.overrideReason = override.reason
            }
          }
          current.gate = gate
          current.updatedAt = now
          if (args.finalize === true) {
            if (!gate.pass) {
              W.appendEvent(current, { at: now, type: 'gate/failed', actor: membership.name, detail: `${gate.itemGates.filter((entry) => !entry.pass).length} item gate(s) failed` })
              return current
            }
            current.phase = W.RUN_PHASE.FINALIZED
            current.finalizedAt = now
            const markdown = renderReportMarkdown(current, gate)
            reportPath = await store.writeArtifact(agent, `teams/${store.teamIdOf(agent)}/report.md`, markdown)
            current.artifacts = { ...(current.artifacts ?? {}), reportPath }
            W.appendEvent(current, { at: now, type: 'run/finalized', actor: membership.name, detail: reportPath === null ? 'finalized' : `report at ${reportPath}` })
          }
          return current
        })

        if (args.finalize === true && !gate.pass) {
          const failures = gate.itemGates
            .filter((entry) => !entry.pass)
            .map((entry) => `${entry.id}: ${entry.failures.join('; ')}`)
          throw new Error(`the gate did not pass, so the run was not finalized:\n- ${[...gate.teamFailures, ...failures].join('\n- ')}\nFix the causes, or accept specific items with an override reason.`)
        }
        if (args.finalize === true && gate.pass) {
          // Convergence also closes the shared board: a finalized run leaves no
          // half-open backing task behind for a later reader to misread.
          for (const item of state.items) {
            if (item.taskId === null) continue
            try {
              const task = ctx.agentTeams.getTask(agent, item.taskId)
              if (task.status === 'pending') {
                const claimed = await ctx.agentTeams.updateTask(agent, { taskId: item.taskId, expectedRevision: task.revision, action: 'claim' })
                await ctx.agentTeams.updateTask(agent, { taskId: item.taskId, expectedRevision: claimed.revision, action: 'complete' })
              } else if (task.status === 'in_progress') {
                await ctx.agentTeams.updateTask(agent, { taskId: item.taskId, expectedRevision: task.revision, action: 'complete' })
              }
            } catch {
              /* finalize already succeeded; task cleanup is best effort */
            }
          }
          const cwd = store.workingDir(agent)
          await autoCleanupRunWorktrees({ cwd, state, agent, store }).catch(() => {})
          state = (await store.readState(agent)) ?? state
        }
        const overrideArgs = overrides.map((override) => ({ item_id: override.itemId, reason: override.reason }))
        const nextActions =
          args.finalize === true && gate.pass
            ? [`Run finalized. Report: ${reportPath ?? '(artifacts disabled)'}. Give the user the committed deliverable and the verification evidence; do not re-plan.`]
            : gate.pass
              ? [
                  overrideArgs.length === 0
                    ? 'Gate passes. Call team_flow_gate {finalize:true} to converge the run and write the report.'
                    : `Gate passes only with the overrides you supplied, and they are persisted only by a passing finalize. Call team_flow_gate {finalize:true, overrides:${JSON.stringify(overrideArgs)}}.`,
                ]
              : ['Gate does not pass yet. Read item_gates failures and steer the owners/reviewers; do not finalize.']
        return {
          pass: gate.pass,
          finalized: args.finalize === true && gate.pass,
          item_gates: gate.itemGates,
          team_failures: gate.teamFailures,
          report_path: reportPath,
          next_actions: nextActions,
        }
      },
    },

    // ----------------------------------------------------------- escalate
    {
      name: 'team_flow_escalate',
      description:
        'Any member. Raise a structured escalation to the Lead (blocker, conflicting requirements, scope change, decision, or arbitration) or, as Lead, resolve one. Blocking escalations stop the gate from passing, which is how the workflow refuses to converge silently.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['blocker', 'conflict', 'scope_change', 'decision', 'arbitration'], description: 'Escalation kind.' },
          subject: { type: 'string', description: 'One-line subject for a new escalation.' },
          detail: { type: 'string', description: 'Full context the Lead needs to decide, including what you already tried.' },
          blocking: { type: 'boolean', description: 'Default true. Set false for informational notes.' },
          item_id: { type: 'string', description: 'Related work item id.' },
          escalation_id: { type: 'string', description: 'Lead-only: id of the escalation to resolve.' },
          resolution: { type: 'string', description: 'Lead-only: the decision and its rationale, recorded in the report.' },
        },
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          escalation_id: { type: 'string' },
          resolved: { type: 'boolean' },
          notified: { type: 'array', items: { type: 'string' } },
          sync_warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_escalate')
        const now = new Date().toISOString()
        const resolving = typeof args.escalation_id === 'string' && args.escalation_id.length > 0
        if (resolving) {
          requireLead(membership, 'team_flow_escalate (resolve mode)')
          const resolution = String(args.resolution ?? '').trim()
          if (resolution.length === 0) throw new Error('resolving an escalation requires a resolution text recording the decision')
          const state = await store.mutateState(agent, async (current) => {
            if (current === null) throw new Error('no workflow run exists yet')
            W.resolveEscalation(current, { escalationId: String(args.escalation_id), resolution, actor: membership.name, now })
            return current
          })
          const status = W.buildStatus(state, { me: { name: membership.name, role: membership.role }, role: membership.role, settings: state.settings, members: [], artifacts: {} })
          return { escalation_id: String(args.escalation_id), resolved: true, notified: [], sync_warnings: [], next_actions: status.next_actions }
        }
        const kind = String(args.kind ?? 'blocker')
        if (!W.ESCALATION_KINDS.includes(kind)) throw new Error(`kind must be one of ${W.ESCALATION_KINDS.join('/')}`)
        const subject = String(args.subject ?? '').trim()
        if (subject.length === 0) throw new Error('a new escalation needs a subject')
        const detail = String(args.detail ?? '').trim()
        let escalation = null
        const state = await store.mutateState(agent, async (current) => {
          if (current === null) throw new Error('no workflow run exists yet')
          requireWritableRun(current, 'team_flow_escalate')
          const item = args.item_id === undefined ? null : W.findItem(current, String(args.item_id))
          escalation = W.raiseEscalation(current, {
            kind,
            subject,
            detail,
            blocking: args.blocking !== false,
            itemId: item?.id ?? null,
            actor: membership.name,
            now,
          })
          return current
        })
        const syncWarnings = []
        const notified = []
        if (membership.role !== 'lead') {
          const failure = await sendPeer(
            ctx,
            agent,
            'lead',
            `[BLOCKER] Escalation ${escalation.id} (${kind})${escalation.itemId === null ? '' : ` on ${escalation.itemId}`}: ${subject}\n\n${detail}\n\nCall team_flow_status and resolve it with team_flow_escalate {escalation_id:"${escalation.id}", resolution:"..."}.`,
            exec.signal,
          )
          if (failure === null) notified.push('lead')
          else syncWarnings.push(failure)
        }
        const status = W.buildStatus(state, { me: { name: membership.name, role: membership.role }, role: membership.role, settings: state.settings, members: [], artifacts: {} })
        return {
          escalation_id: escalation.id,
          resolved: false,
          notified,
          sync_warnings: syncWarnings,
          next_actions: status.next_actions,
        }
      },
    },
    // ------------------------------------------------------------- repair
    {
      name: 'team_flow_repair',
      description:
        'Lead-only repair for a stuck run: reopen a work item so it can be redone, reassign its owner, or reset a stuck review to another reviewer. Every repair records the reason in the audit trail and notifies the affected member, so recovery is explicit instead of a silent re-plan.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Work item to repair.' },
          action: { type: 'string', enum: ['reopen', 'reassign', 'reset_review'], description: 'Repair action.' },
          reason: { type: 'string', description: 'Why the repair is needed; recorded in the audit trail and shown to the member.' },
          owner: { type: 'string', description: 'reassign: new owner member name (lower-kebab-case).' },
          reviewer: { type: 'string', description: 'reset_review: reviewer to assign (defaults to the next outstanding reviewer).' },
        },
        required: ['item_id', 'action', 'reason'],
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          action: { type: 'string' },
          item_status: { type: 'string' },
          notified: { type: 'array', items: { type: 'string' } },
          sync_warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_repair')
        requireLead(membership, 'team_flow_repair')
        const now = new Date().toISOString()
        const action = String(args.action ?? '')
        if (!['reopen', 'reassign', 'reset_review'].includes(action)) throw new Error('action must be one of reopen / reassign / reset_review')
        const reason = String(args.reason ?? '').trim()
        if (reason.length === 0) throw new Error('every repair needs a reason; it is recorded in the audit trail')
        let outcome = null
        let state = await store.mutateState(agent, async (current) => {
          if (current === null) throw new Error('no workflow run exists yet')
          requireWritableRun(current, 'team_flow_repair')
          const item = W.findItem(current, String(args.item_id ?? ''))
          const entry = { at: now, by: membership.name, action, reason: reason.slice(0, 4000) }
          if (action === 'reopen') {
            item.report = null
            item.reportSeq = W.currentReportSeq(item) + 1
            item.reworkTotal = 0
            item.status = W.ITEM_STATUS.PENDING
            item.approvedAt = null
            item.approvedBy = null
            item.overrideReason = null
            item.updatedAt = now
            for (const review of item.reviews) if (review.status === 'pending') review.status = 'superseded'
            entry.detail = 'report cleared; earlier verdicts invalidated by a new report version'
          } else if (action === 'reassign') {
            const owner = assertMemberName(args.owner, 'owner')
            if (item.status === W.ITEM_STATUS.APPROVED) throw new Error(`item "${item.id}" is approved; reopen it before reassigning`)
            entry.detail = `owner ${item.owner} -> ${owner}`
            item.owner = owner
            if (item.status === W.ITEM_STATUS.ESCALATED) item.status = W.ITEM_STATUS.PENDING
            item.updatedAt = now
          } else {
            const candidate = args.reviewer === undefined ? (W.outstandingReviewers(item)[0] ?? item.reviewers[0]) : args.reviewer
            if (candidate === undefined) throw new Error('reset_review needs a reviewer: the item declares no reviewers and none was given')
            const reviewer = assertMemberName(candidate, 'reviewer')
            for (const review of item.reviews) if (review.status === 'pending') review.status = 'superseded'
            if (!item.reviewers.includes(reviewer)) item.reviewers.push(reviewer)
            const review = W.openReview(item, reviewer, { now, actor: membership.name })
            entry.detail = `round ${review.round} assigned to ${reviewer}`
          }
          item.repairLog = [...(item.repairLog ?? []), entry]
          W.appendEvent(current, { at: now, type: `repair/${action}`, actor: membership.name, detail: `${item.id}: ${reason.slice(0, 160)}` })
          outcome = { item }
          return current
        })
        const item = outcome.item
        const syncWarnings = []
        const notified = []

        if (action === 'reopen') {
          try {
            const task = item.taskId === null ? null : ctx.agentTeams.getTask(agent, item.taskId)
            if (task !== null && task.status === 'completed') {
              await ctx.agentTeams.updateTask(agent, { taskId: item.taskId, expectedRevision: task.revision, action: 'reopen' })
            }
          } catch (error) {
            syncWarnings.push(`backing Team task not reopened: ${error instanceof Error ? error.message : String(error)}`)
          }
          const failure = await sendPeer(
            ctx,
            agent,
            item.owner,
            `[HANDOFF] ${item.id} "${item.subject}" was reopened by the Lead for rework.\nReason: ${reason}\nAction: re-read team_flow_status, redo the work inside ${item.writeScopes.join(', ') || 'the declared scope'}, then call team_flow_report again.`,
            exec.signal,
          )
          if (failure === null) notified.push(item.owner)
          else syncWarnings.push(failure)
        } else if (action === 'reassign') {
          try {
            const task = item.taskId === null ? null : ctx.agentTeams.getTask(agent, item.taskId)
            if (task !== null && (task.status === 'pending' || task.status === 'in_progress')) {
              await ctx.agentTeams.updateTask(agent, { taskId: item.taskId, expectedRevision: task.revision, action: 'reassign', owner: item.owner })
            }
          } catch (error) {
            syncWarnings.push(`backing Team task not reassigned: ${error instanceof Error ? error.message : String(error)}`)
          }
          const failure = await sendPeer(
            ctx,
            agent,
            item.owner,
            `[HANDOFF] You are now the owner of ${item.id} "${item.subject}".\nReason for reassignment: ${reason}\nAction: call team_flow_status, do the work inside ${item.writeScopes.join(', ') || 'the declared scope'}, then report with team_flow_report.`,
            exec.signal,
          )
          if (failure === null) notified.push(item.owner)
          else syncWarnings.push(failure)
        } else {
          const target = W.pendingReview(item)?.reviewer ?? item.reviewers[0]
          if (!isLiveMember(ctx, agent, target)) {
            syncWarnings.push(`reviewer "${target}" is not in the roster; spawn it, then reset the review again`)
          } else {
            const failure = await sendPeer(ctx, agent, target, reviewRequestMessage(state, item), exec.signal)
            if (failure === null) notified.push(target)
            else syncWarnings.push(failure)
          }
        }

        const status = W.buildStatus(state, {
          me: { name: membership.name, role: membership.role },
          role: membership.role,
          settings: state.settings,
          members: [],
          artifacts: {},
        })
        triggerOrchestrator(agent)
        return {
          item_id: item.id,
          action,
          item_status: item.status,
          notified,
          sync_warnings: syncWarnings,
          next_actions: status.next_actions,
        }
      },
    },

    // -----------------------------------------------------------------
    // Peer collaboration (workflow v2): talk, work, decide, read
    // -----------------------------------------------------------------


    {
      name: 'team_flow_staff',
      description:
        'Lead-only. Make sure the Team actually exists: spawn missing owners/reviewers/pool members for the given (or all unfinished) items and wake inactive ones with their brief. Use it when a later wave becomes ready, or when a member went missing.',
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' }, description: 'Item ids to staff; omit to staff every unfinished item.' },
          reason: { type: 'string', description: 'Optional note recorded in the tool result.' },
        },
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          staffed: {},
          warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_staff')
        requireLead(membership, 'team_flow_staff')
        const state = await requireRun(store, agent, 'team_flow_staff')
        W.ensureCollaboration(state)
        const requested = Array.isArray(args.items) && args.items.length > 0
          ? args.items.map((id) => String(id))
          : state.items.filter((item) => item.status !== W.ITEM_STATUS.APPROVED).map((item) => item.id)
        const targets = requested.map((id) => W.findItem(state, id))
        const entries = []
        const providerFor = (role) => {
          const configured = typeof role === 'string' && role.length > 0 ? settings.roles[role]?.provider : undefined
          return typeof configured === 'string' && configured.length > 0 ? configured : settings.freshProvider
        }
        const roleOf = (name, fallback) => state.roleAssignments?.[name] ?? (settings.roles[fallback] === undefined ? '' : fallback)
        for (const item of targets) {
          if (typeof item.owner === 'string' && item.owner.length > 0) {
            const reviewing = state.items.filter((other) => other.reviewers.includes(item.owner)).map((other) => other.id)
            const role = roleOf(item.owner, item.role)
            const brief = renderWorkerBrief(state, item, reviewing, state.settings.workerContext)
            entries.push({ ...brief, kind: 'worker', provider: providerFor(role), prompt: brief.prompt + roleGuidance(settings, role) })
          }
          for (const reviewer of item.reviewers) {
            const reviewed = state.items.filter((other) => other.reviewers.includes(reviewer))
            const role = roleOf(reviewer, 'reviewer')
            const brief = renderReviewerBrief(state, reviewer, reviewed)
            entries.push({ ...brief, kind: 'reviewer', provider: providerFor(role), prompt: brief.prompt + roleGuidance(settings, role) })
          }
        }
        const pool = Array.isArray(state.staffPool) ? state.staffPool : []
        const openItems = state.items.filter((item) => item.assignment === 'open' && (typeof item.owner !== 'string' || item.owner.length === 0))
        for (const name of pool) {
          if (openItems.length === 0) break
          const role = state.roleAssignments?.[name] ?? ''
          const brief = renderQueueBrief(state, name, openItems, state.settings.workerContext)
          entries.push({ ...brief, kind: 'worker-pool', provider: providerFor(role), prompt: brief.prompt + roleGuidance(settings, role) })
        }
        const staffed = await staffEntries({ ctx, agent, entries, settings, signal: exec.signal })
        const warnings = staffed.failed.map((entry) => `${entry.name}: ${entry.error}`)
        if (staffed.needs_spawn.length > 0) warnings.push(`capacity limit: ${staffed.needs_spawn.map((entry) => entry.name).join(', ')}`)
        if (args.reason) warnings.push(`reason: ${String(args.reason).slice(0, 200)}`)
        return {
          staffed,
          warnings,
          next_actions: W.nextActions(state, { me: { name: membership.name, role: membership.role }, role: membership.role, members: ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, role: member.role })), settings: state.settings, now: new Date().toISOString() }),
        }
      },
    },
    {
      name: 'team_flow_git',
      description:
        'Git/PR workflow (disabled unless gitEnabled). prepare creates the run branch (Lead), commit stages only the item files, verify runs the configured checks, push publishes the branch, pr opens/updates the pull request (gh when available, else a manual compare URL), review posts the reviewer verdict to the PR, merge lands it after the gate passes (Lead only).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'prepare', 'commit', 'verify', 'push', 'pr', 'review', 'merge', 'worktree_add', 'worktree_remove', 'worktree_list'], description: 'Git/PR action.' },
          item_id: { type: 'string', description: 'Work item id for commit/verify/review/merge (status/pr may omit).' },
          message: { type: 'string', description: 'commit: optional commit message; merge: merge message.' },
          files: { type: 'array', items: { type: 'string' }, description: 'commit: explicit files; defaults to the report files.' },
          commands: { type: 'array', items: { type: 'string' }, description: 'verify: explicit commands; defaults to the configured gitVerifyCommands.' },
          method: { type: 'string', enum: ['squash', 'merge', 'no-ff'], description: 'merge: merge strategy (default squash for gh, no-ff locally).' },
          title: { type: 'string', description: 'pr: optional pull-request title.' },
          body: { type: 'string', description: 'pr: optional pull-request body.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          action: { type: 'string' },
          item_id: {},
          repo: {},
          run_git: {},
          item_git: {},
          detail: {},
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['action'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_git')
        if (settings.gitEnabled !== true) {
          throw new Error('the git workflow is disabled; enable it in the plugin config with gitEnabled: true')
        }
        const action = String(args.action ?? '')
        const state = await requireRun(store, agent, 'team_flow_git')
        W.ensureCollaboration(state)
        const cwd = store.workingDir(agent)
        const warnings = []
        assertRoleAllowed(settings, state, membership.name, 'team_flow_git', action)
        const requireItem = () => {
          if (typeof args.item_id !== 'string' || args.item_id.length === 0) throw new Error(`team_flow_git ${action} needs item_id`)
          return W.findItem(state, args.item_id)
        }
        const requireOwner = (item) => {
          if (membership.role !== 'lead' && item.owner !== membership.name) throw new Error(`item "${item.id}" belongs to "${item.owner}"; only its owner (or the Lead) may run ${action}`)
        }
        if (action === 'status') {
          const repo = await G.gitStatus({ cwd })
          return {
            action,
            repo,
            run_git: state.git ?? null,
            item_git: state.items.map((item) => ({ item_id: item.id, owner: item.owner ?? null, git: item.git ?? null })),
            warnings,
          }
        }
        if (action === 'worktree_list') {
          const result = await G.gitWorktreeList({ cwd })
          if (result.ok !== true) throw new Error(`worktree list failed: ${result.error}`)
          return {
            action,
            mode: state.settings.worktreeIsolation ?? 'off',
            worktrees: result.worktrees,
            item_worktrees: state.items
              .filter((item) => item.git?.worktreeBranch !== undefined)
              .map((item) => ({ item_id: item.id, owner: item.owner ?? null, worktree: item.git.worktree ?? null, path: item.git.worktreePath ?? null, branch: item.git.worktreeBranch, mergedAt: item.git.worktreeMergedAt ?? null })),
            warnings,
          }
        }
        if (action === 'worktree_add' || action === 'worktree_remove') {
          requireLead(membership, `team_flow_git ${action}`)
          const target = requireItem()
          const vs = state.settings
          const mode = vs.worktreeIsolation ?? 'off'
          if (mode === 'off') throw new Error('worktree isolation is disabled; set worktreeIsolation: "serial" or "parallel" in the plugin config')
          const slug = (value) => String(value).replace(/[^A-Za-z0-9._/-]+/g, '-')
          if (action === 'worktree_add') {
            if (target.git?.worktree && target.git?.worktreePath) {
              return {
                action,
                item_id: target.id,
                mode,
                worktree: {
                  relative: target.git.worktree,
                  absolute: target.git.worktreePath,
                  branch: target.git.worktreeBranch,
                  startPoint: target.git.worktreeBase ?? null,
                },
                detail: { ok: true, path: target.git.worktree, branch: target.git.worktreeBranch },
                warnings,
              }
            }
            if (mode === 'serial') {
              const other = state.items.find((item) => item.id !== target.id && item.git?.worktreeBranch !== undefined && item.git?.worktreeMergedAt == null)
              if (other !== undefined) throw new Error(`serial worktree isolation allows one active worktree at a time; item "${other.id}" still owns one (merge or remove it first)`)
            }
            const relative = `.agentteam/worktrees/${state.runId}/${target.id}`.replace(/[^A-Za-z0-9._/-]+/g, '-')
            const branch = slug(`agentteam-wt/${state.runId}/${target.id}`)
            const startPoint = typeof state.git?.branch === 'string' ? state.git.branch : undefined
            const result = await G.gitWorktreeAdd({ cwd, path: relative, branch, ...(startPoint === undefined ? {} : { startPoint }) })
            if (result.ok !== true) throw new Error(`worktree add failed: ${result.error}`)
            const absolute = path.resolve(cwd, relative)
            let next = null
            await store.mutateState(agent, (current) => {
              W.ensureCollaboration(current)
              const item = W.findItem(current, target.id)
              item.git = { ...(item.git ?? {}), worktree: relative, worktreePath: absolute, worktreeBranch: branch, worktreeBase: startPoint ?? null, worktreeCreatedAt: new Date().toISOString() }
              W.appendEvent(current, { at: new Date().toISOString(), type: 'git/worktree', actor: membership.name, detail: `${item.id} ${relative}` })
              next = current
              return current
            })
            return { action, item_id: target.id, mode, worktree: { relative, absolute, branch, startPoint: startPoint ?? null }, detail: result, warnings }
          }
          if (target.git?.worktreeRemovedAt || (!target.git?.worktree && !target.git?.worktreePath)) {
            return { action, item_id: target.id, already_removed: true, detail: { ok: true }, warnings }
          }
          const absolute = target.git?.worktreePath ?? path.resolve(cwd, target.git?.worktree ?? `.agentteam/worktrees/${state.runId}/${target.id}`)
          const result = await G.gitWorktreeRemove({ cwd, path: target.git?.worktree ?? `.agentteam/worktrees/${state.runId}/${target.id}` })
          if (result.ok !== true) throw new Error(`worktree remove failed: ${result.error}${absolute ? ` (${absolute})` : ''}`)
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            const item = W.findItem(current, target.id)
            item.git = { ...(item.git ?? {}), worktree: null, worktreePath: null, worktreeBranch: null, worktreeBase: null }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/worktree-removed', actor: membership.name, detail: item.id })
            return current
          })
          return { action, item_id: target.id, detail: result, warnings }
        }
        if (action === 'prepare') {
          requireLead(membership, 'team_flow_git prepare')
          const branch = `${state.settings.gitBranchPrefix ?? 'agentteam/'}${state.runId}`.replace(/[^A-Za-z0-9._/-]+/g, '-')
          const base = state.settings.gitBaseBranch ?? 'main'
          const result = await G.gitEnsureBranch({ cwd, branch, base })
          if (result.ok !== true) throw new Error(`could not prepare the run branch: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            if (current === null) throw new Error('no workflow run exists yet')
            W.ensureCollaboration(current)
            current.git = {
              branch,
              base,
              remote: current.settings.gitRemote ?? 'origin',
              branchCreated: result.created === true,
              pushedAt: null,
              pr: null,
              mergedAt: null,
              mergeSha: null,
            }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/prepared', actor: membership.name, detail: `${branch} (base ${base})` })
            next = current
            return current
          })
          return { action, repo: await G.gitStatus({ cwd }), run_git: next.git, warnings }
        }
        const item = action === 'merge' && typeof args.item_id !== 'string' ? null : requireItem()
        if (action === 'commit') {
          requireOwner(item)
          if (state.git === null || typeof state.git.branch !== 'string') throw new Error('no run branch yet; the Lead must run team_flow_git {action:"prepare"} first')
          // Parallel worktrees: commit inside the item worktree (its branch) so
          // concurrent items never race on one checkout.
          const isolated = typeof item.git?.worktreePath === 'string' && item.git.worktreePath.length > 0
          const workCwd = isolated ? item.git.worktreePath : cwd
          const expectedBranch = isolated ? item.git.worktreeBranch : state.git.branch
          const repo = await G.gitStatus({ cwd: workCwd })
          if (repo.ok !== true) throw new Error(`not a git repository: ${repo.error}`)
          if (repo.branch !== expectedBranch) throw new Error(`the ${isolated ? 'item worktree' : 'repository'} is on "${repo.branch}", not "${expectedBranch}"; check it out before committing`)
          const files = Array.isArray(args.files) && args.files.length > 0 ? args.files.map((file) => W.normalizePath(file)) : (item.report?.files ?? [])
          if (files.length === 0) throw new Error('nothing to commit: pass files or report the item first')
          const message = String(args.message ?? `agentteam(${item.id}): ${item.subject}`).slice(0, 200)
          const result = await G.gitCommit({ cwd: workCwd, files, message, ...(isolated ? { base: state.git.base } : {}) })
          if (result.ok !== true) throw new Error(`commit failed: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            const target = W.findItem(current, item.id)
            const previous = target.git ?? {}
            target.git = {
              ...previous,
              sha: result.sha,
              commits: [...(previous.commits ?? []), { sha: result.sha, at: new Date().toISOString(), files: result.files ?? files, message }],
            }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/committed', actor: membership.name, detail: `${target.id} ${result.sha}` })
            next = target
            return current
          })
          return { action, item_id: item.id, item_git: next.git, run_git: state.git, repo: await G.gitStatus({ cwd }), warnings }
        }
        if (action === 'verify') {
          const isAssignedReviewer = Array.isArray(item.reviewers) && item.reviewers.some((r) => (typeof r === 'string' ? r === membership.name : r?.name === membership.name))
          if (membership.role !== 'lead' && item.owner !== membership.name && !isAssignedReviewer) {
            requireOwner(item)
          }
          const commands = Array.isArray(args.commands) && args.commands.length > 0 ? args.commands.map((command) => String(command)) : (state.settings.gitVerifyCommands ?? [])
          if (commands.length === 0) throw new Error('no verification commands configured; pass commands or set gitVerifyCommands')
          // Isolated items verify their own worktree copy, not the shared checkout.
          const verifyCwd = typeof item.git?.worktreePath === 'string' && item.git.worktreePath.length > 0 ? item.git.worktreePath : cwd
          const result = await G.gitVerify({ cwd: verifyCwd, commands })
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            const target = W.findItem(current, item.id)
            target.git = { ...(target.git ?? {}), verify: { ok: result.ok === true, results: result.results, at: new Date().toISOString() } }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/verified', actor: membership.name, detail: `${target.id}: ${result.ok === true ? 'ok' : 'failed'}` })
            next = target
            return current
          })
          return { action, item_id: item.id, item_git: next.git, detail: result, warnings }
        }
        if (action === 'push') {
          requireOwner(item)
          if (state.git === null || typeof state.git.branch !== 'string') throw new Error('no run branch yet; run prepare first')
          const result = await G.gitPush({ cwd, remote: state.git.remote, branch: state.git.branch })
          if (result.ok !== true) throw new Error(`push failed: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            current.git = { ...(current.git ?? {}), pushedAt: new Date().toISOString(), pushedSha: result.sha ?? null }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/pushed', actor: membership.name, detail: `${current.git.branch} → ${current.git.remote}` })
            next = current
            return current
          })
          return { action, item_id: item.id, run_git: next.git, detail: result, warnings }
        }
        if (action === 'pr') {
          if (membership.role !== 'lead' && item.owner !== membership.name) requireOwner(item)
          if (state.git === null || typeof state.git.branch !== 'string') throw new Error('no run branch yet; run prepare first')
          if (state.git.pushedAt === null || state.git.pushedAt === undefined) throw new Error('push the branch before opening a pull request')
          const title = String(args.title ?? `[agentteam] ${state.objective}`).slice(0, 120)
          const body = String(args.body ?? state.items.map((entry) => `- ${entry.id}: ${entry.subject} (${entry.status})`).join('\n')).slice(0, 8000)
          const result = await G.gitPrCreateOrUpdate({ cwd, branch: state.git.branch, base: state.git.base, title, body, remote: state.git.remote })
          if (result.ok !== true) throw new Error(`pull request failed: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            current.git = {
              ...(current.git ?? {}),
              pr: { url: result.url ?? null, number: result.number ?? null, mode: result.mode, status: 'open', updatedAt: new Date().toISOString() },
            }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/pr', actor: membership.name, detail: `${result.mode} ${result.url ?? ''}`.trim() })
            next = current
            return current
          })
          return { action, item_id: item.id, run_git: next.git, detail: result, warnings }
        }
        if (action === 'review') {
          if (membership.role !== 'lead' && item.owner === membership.name) throw new Error('authors do not review their own work')
          const pending = W.pendingReview(item)
          if (membership.role !== 'lead' && (pending === null || pending.reviewer !== membership.name)) throw new Error(`you are not the pending reviewer of "${item.id}"`)
          const submitted = [...item.reviews].reverse().find((review) => review.reviewer === membership.name && review.status === 'submitted')
          if (submitted === undefined) throw new Error(`no submitted verdict from you on "${item.id}" yet; submit the review first`)
          const verdict = submitted.verdict === 'approve' || submitted.verdict === 'approve_with_nits' ? 'approve' : submitted.verdict === 'request_changes' ? 'request-changes' : 'comment'
          const pr = state.git?.pr ?? null
          const result = pr === null
            ? { ok: true, mode: 'record-only', detail: 'no PR recorded; the verdict stays on the board' }
            : await G.gitPrReview({ cwd, number: pr.number, verdict, body: submitted.summary ?? '' })
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            const target = W.findItem(current, item.id)
            target.git = { ...(target.git ?? {}), prReview: { verdict, at: new Date().toISOString(), mode: result.mode ?? 'record-only' } }
            next = target
            return current
          })
          return { action, item_id: item.id, item_git: next.git, detail: result, warnings }
        }
        if (action === 'merge' && typeof args.item_id === 'string') {
          requireLead(membership, 'team_flow_git merge (item worktree)')
          const target = requireItem()
          if (typeof target.git?.worktreeBranch !== 'string') throw new Error(`item "${target.id}" has no worktree branch; run worktree_add first`)
          if (target.status !== W.ITEM_STATUS.APPROVED) throw new Error(`item "${target.id}" is "${target.status}"; merge its worktree branch only after it is approved`)
          if (state.git === null || typeof state.git.branch !== 'string') throw new Error('no run branch recorded; run prepare first')
          if (target.git.worktreeMergedAt != null) {
            return {
              action,
              item_id: target.id,
              item_git: target.git,
              run_git: state.git,
              detail: { ok: true, sha: target.git.worktreeMergeSha ?? null },
              already_merged: true,
              warnings,
            }
          }
          const method = args.method === 'squash' ? 'squash' : 'no-ff'
          const result = await G.gitMerge({
            cwd,
            branch: target.git.worktreeBranch,
            into: state.git.branch,
            method,
            message: String(args.message ?? `agentteam(${target.id}): merge worktree ${target.git.worktreeBranch}`),
          })
          if (result.ok !== true) throw new Error(`worktree merge failed: ${result.error}`)
          let nextItem = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            const item = W.findItem(current, target.id)
            item.git = { ...(item.git ?? {}), worktreeMergedAt: new Date().toISOString(), worktreeMergeSha: result.sha ?? null }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/worktree-merged', actor: membership.name, detail: `${item.id} ${item.git?.worktreeBranch ?? ''} → ${current.git?.branch ?? ''}` })
            nextItem = item
            return current
          })
          return { action, item_id: target.id, item_git: nextItem.git, run_git: state.git, detail: result, warnings }
        }
        if (action === 'merge') {
          requireLead(membership, 'team_flow_git merge')
          if (state.phase !== W.RUN_PHASE.CONVERGED && state.phase !== W.RUN_PHASE.FINALIZED) throw new Error(`the run is "${state.phase}"; merge only after every item is approved`)
          if (state.gate === null || state.gate.pass !== true) throw new Error('the quality gate has not passed; run team_flow_gate first')
          if (state.git === null || typeof state.git.branch !== 'string') throw new Error('no run branch recorded')
          if (state.git.mergedAt !== null && state.git.mergedAt !== undefined) throw new Error('this run branch is already merged')
          const method = args.method === 'merge' || args.method === 'no-ff' ? args.method : 'squash'
          const pr = state.git.pr ?? null
          const result = pr !== null && pr.mode === 'gh'
            ? await G.gitPrMerge({ cwd, number: pr.number, method })
            : await G.gitMerge({ cwd, branch: state.git.branch, into: state.git.base, method: 'no-ff', message: String(args.message ?? `agentteam: merge ${state.runId}`) })
          if (result.ok !== true) throw new Error(`merge failed: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            current.git = { ...(current.git ?? {}), mergedAt: new Date().toISOString(), mergeSha: result.sha ?? null, mergedInto: current.git?.base ?? null, mergeMode: result.mode ?? 'local' }
            if (current.git?.pr != null) current.git.pr = { ...current.git.pr, status: 'merged' }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/merged', actor: membership.name, detail: `${current.git?.branch ?? ''} → ${current.git?.base ?? ''}` })
            next = current
            return current
          })
          return { action, run_git: next.git, detail: result, warnings }
        }
        throw new Error(`unknown team_flow_git action "${action}"`)
      },
    },

    {
      name: 'team_flow_stop',
      description:
        'Graceful shutdown protocol. The Lead requests a teammate stop (the teammate accepts or rejects with a reason) or escalates to an interrupt; any member can answer a pending stop request addressed to it. status lists recent stop records.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['request', 'accept', 'reject', 'interrupt', 'status'], description: 'Stop action.' },
          member: { type: 'string', description: 'request/interrupt: teammate name to stop.' },
          reason: { type: 'string', description: 'Optional reason shown to the member (request/interrupt) or to the Lead (accept/reject).' },
          stop_id: { type: 'string', description: 'interrupt: optional stop record id to escalate; defaults to the newest open record for the member.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          action: { type: 'string' },
          stop: {},
          stops: { type: 'array', items: {} },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['action'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_stop')
        const action = String(args.action ?? '')
        const now = new Date().toISOString()
        const warnings = []
        if (action === 'status') {
          const state = await requireRun(store, agent, 'team_flow_stop')
          W.ensureCollaboration(state)
          return { action, stops: (state.stops ?? []).slice(-16), warnings }
        }
        if (action === 'request' || action === 'interrupt') {
          requireLead(membership, `team_flow_stop ${action}`)
          const target = String(args.member ?? '').trim()
          if (target.length === 0) throw new Error(`team_flow_stop ${action} needs member`)
          let record = null
          await store.mutateState(agent, async (current) => {
            if (current === null) throw new Error('no workflow run exists yet')
            W.ensureCollaboration(current)
            if (action === 'interrupt') {
              const open = (current.stops ?? []).filter((stop) => stop.target === target && stop.status !== 'rejected' && stop.status !== 'interrupted').at(-1)
              record = open === undefined
                ? W.requestStop(current, { by: membership.name, target, mode: 'interrupt', reason: args.reason, now })
                : W.escalateStopToInterrupt(current, { stopId: open.id, by: membership.name, now })
            } else {
              record = W.requestStop(current, { by: membership.name, target, mode: 'graceful', reason: args.reason, now })
            }
            return current
          })
          if (action === 'interrupt') {
            try {
              ctx.agentTeams.interrupt(agent, target)
            } catch (error) {
              warnings.push(`interrupt failed: ${error instanceof Error ? error.message : String(error)}`)
            }
            return { action, stop: record, warnings }
          }
          const failure = await sendPeer(ctx, agent, target, `[SHUTDOWN] The Lead asks you to stop${typeof args.reason === 'string' && args.reason.trim().length > 0 ? `: ${args.reason.trim()}` : '.'}\nAccept with team_flow_stop {action:"accept", reason?} or reject with {action:"reject", reason:"why you should continue"}. Finish the current tool call safely before accepting.`, exec.signal)
          if (failure !== null) warnings.push(failure)
          return { action, stop: record, warnings }
        }
        if (action === 'accept' || action === 'reject') {
          let record = null
          await store.mutateState(agent, async (current) => {
            if (current === null) throw new Error('no workflow run exists yet')
            W.ensureCollaboration(current)
            if (action === 'accept') {
              await runHook('teammateIdle', {
                member: membership.name,
                stopId: W.pendingStopFor(current, membership.name)?.id ?? null,
                reason: typeof args.reason === 'string' ? args.reason : null,
              }, { agent, settings: current.settings, store })
            }
            record = W.respondStop(current, { by: membership.name, accept: action === 'accept', reason: args.reason, now })
            return current
          })
          const failure = await sendPeer(ctx, agent, 'lead', `[SHUTDOWN] ${membership.name} ${action === 'accept' ? 'accepted' : 'rejected'} the stop request${typeof args.reason === 'string' && args.reason.trim().length > 0 ? `: ${args.reason.trim()}` : '.'}`, exec.signal)
          if (failure !== null) warnings.push(failure)
          return { action, stop: record, warnings }
        }
        throw new Error(`unknown team_flow_stop action "${action}"`)
      },
    },

    {
      name: 'team_flow_plan_approval',
      description:
        'Plan-first workflow: the item owner submits a short implementation plan (steps/files/risks); the Lead (or the first peer reviewer when planApprover is "peer") approves or rejects it. With autoApprovePlan the plan is approved immediately, matching the official "lead did not review it" default.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['submit', 'approve', 'reject', 'status'], description: 'Plan action.' },
          item_id: { type: 'string', description: 'Work item id.' },
          plan: {
            type: 'object',
            properties: {
              steps: { type: 'array', items: { type: 'string' }, description: 'Ordered implementation steps (at least one).' },
              files: { type: 'array', items: { type: 'string' }, description: 'Files the plan expects to touch.' },
              risks: { type: 'array', items: { type: 'string' }, description: 'Known risks or open questions.' },
            },
            description: 'submit: the plan itself.',
          },
          reason: { type: 'string', description: 'reject: why the plan was sent back; approve: optional note.' },
        },
        required: ['action', 'item_id'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          action: { type: 'string' },
          item_id: { type: 'string' },
          plan: {},
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['action', 'item_id'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_plan_approval')
        const action = String(args.action ?? '')
        const itemId = String(args.item_id ?? '')
        const now = new Date().toISOString()
        const warnings = []
        if (action === 'status') {
          const state = await requireRun(store, agent, 'team_flow_plan_approval')
          const item = W.findItem(state, itemId)
          return { action, item_id: item.id, plan: item.plan ?? null, warnings }
        }
        let plan = null
        await store.mutateState(agent, (current) => {
          if (current === null) throw new Error('no workflow run exists yet')
          requireWritableRun(current, 'team_flow_plan_approval')
          if (action === 'submit') {
            plan = W.submitPlan(current, {
              itemId,
              by: membership.name,
              plan: args.plan,
              autoApprove: current.settings.autoApprovePlan === true,
              now,
            })
            return current
          }
          if (action === 'approve' || action === 'reject') {
            const item = W.findItem(current, itemId)
            const approver = current.settings.planApprover === 'peer' ? item.reviewers[0] ?? 'lead' : 'lead'
            if (membership.role !== 'lead' && membership.name !== approver) {
              throw new Error(`item "${item.id}" plans are approved by "${approver}", not "${membership.name}"`)
            }
            plan = W.decidePlan(current, { itemId: item.id, by: membership.name, accept: action === 'approve', reason: args.reason, now })
            return current
          }
          throw new Error(`unknown team_flow_plan_approval action "${action}"`)
        })
        if (action === 'submit' && plan !== null && plan.status === 'pending') {
          const failure = await sendPeer(ctx, agent, 'lead', `[PLAN] ${membership.name} submitted a plan for ${itemId}: ${plan.steps.length} step(s); approve with team_flow_plan_approval {action:"approve", item_id:"${itemId}"}.`, exec.signal)
          if (failure !== null) warnings.push(failure)
        }
        return { action, item_id: itemId, plan, warnings }
      },
    },
    {
      name: 'team_flow_item',
      description:
        'Member autonomy: add a new work item to the live run when you discover work that the plan missed (a missing example, an untested branch, a contract bug). The item gets its own write scope, definition of done, backing shared task and the same review/gate rules as planned items. Owner defaults to you; use owner:"open" to publish it to the queue.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create'], description: 'Item action (only "create" is supported today).' },
          subject: { type: 'string', description: 'One-line deliverable title (at most 200 characters).' },
          role: { type: 'string', description: 'Role label for the item; default implementer.' },
          write_scopes: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths you may modify for this item (at least one).' },
          definition_of_done: { type: 'array', items: { type: 'string' }, description: 'Checkable completion conditions (at least one).' },
          owner: { type: 'string', description: '"self" (default), "open" to publish to the open queue, or another member name.' },
          blocked_by: { type: 'array', items: { type: 'string' }, description: 'Existing item ids that must be approved first.' },
          needs_review: { type: 'boolean', description: 'Default true; set false only for read-only work.' },
          reviewers: { type: 'array', items: { type: 'string' }, description: 'Optional reviewer names; empty means the owner invites a peer after reporting.' },
          evidence_optional: { type: 'boolean', description: 'Set true only for read-only/research items where no command can be run.' },
          lease_minutes: { type: 'integer', description: 'Advisory claim lease in minutes when the item is yours.' },
        },
        required: ['action', 'subject', 'write_scopes', 'definition_of_done'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          subject: { type: 'string' },
          owner: {},
          assignment: { type: 'string' },
          status: { type: 'string' },
          task_id: {},
          origin: { type: 'string' },
          created_by: { type: 'string' },
          notifications: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
        required: ['item_id', 'subject'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_item')
        if (String(args.action ?? 'create') !== 'create') throw new Error('team_flow_item supports action:"create"')
        const writeScopes = Array.isArray(args.write_scopes) ? args.write_scopes : []
        const definitionOfDone = Array.isArray(args.definition_of_done) ? args.definition_of_done : []
        let item = null
        const warnings = []
        await store.mutateState(agent, async (current) => {
          if (current === null) throw new Error('no workflow run exists yet; the Lead must call team_flow_plan first')
          requireWritableRun(current, 'team_flow_item')
          assertRoleAllowed(settings, current, membership.name, 'team_flow_item')
          const taskIdByItem = new Map(current.items.filter((candidate) => typeof candidate.taskId === 'string').map((candidate) => [candidate.id, candidate.taskId]))
          const blockedByTasks = (Array.isArray(args.blocked_by) ? args.blocked_by : [])
            .map((blocker) => taskIdByItem.get(String(blocker)))
            .filter((taskId) => typeof taskId === 'string')
          item = W.createItem(current, {
            by: membership.name,
            subject: args.subject,
            role: args.role,
            writeScopes,
            definitionOfDone,
            owner: args.owner,
            blockedBy: args.blocked_by,
            needsReview: args.needs_review,
            reviewers: args.reviewers,
            evidenceOptional: args.evidence_optional,
            leaseMinutes: args.lease_minutes,
            now: new Date().toISOString(),
            maxItems: settings.maxItems,
            allowScopeOverlap: current.settings?.allowScopeOverlap,
          })
          await runHook('taskCreated', {
            item: { id: item.id, subject: item.subject, role: item.role, owner: item.owner === '' ? null : item.owner, assignment: item.assignment, writeScopes: item.writeScopes },
            objective: current.objective,
            actor: membership.name,
          }, { agent, settings: current.settings, store })
          try {
            const task = await ctx.agentTeams.createTask(agent, {
              subject: item.subject.slice(0, 200),
              description: taskDescription(current, item).slice(0, 16_384),
              ...(blockedByTasks.length === 0 ? {} : { blockedBy: blockedByTasks }),
              ...(item.writeScopes.length === 0 ? {} : { writeScopes: item.writeScopes }),
              signal: exec.signal,
            })
            item.taskId = task.id
            if (item.owner === membership.name) {
              try {
                await ctx.agentTeams.updateTask(agent, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
              } catch (error) {
                warnings.push(`backing task ${task.id} not claimed: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          } catch (error) {
            warnings.push(`backing Team task not created: ${error instanceof Error ? error.message : String(error)}`)
          }
          if (typeof item.owner === 'string' && item.owner.length > 0 && typeof item.role === 'string' && item.role.length > 0) {
            current.roleAssignments = { ...(current.roleAssignments ?? {}), [item.owner]: current.roleAssignments?.[item.owner] ?? item.role }
          }
          return current
        })
        const notifications = []
        if (item.owner !== undefined && item.owner !== null && item.owner !== '' && item.owner !== membership.name) {
          const failure = await sendPeer(ctx, agent, item.owner, `[ITEM] ${membership.name} created ${item.id} "${item.subject}" for you.\nScope: ${item.writeScopes.join(', ')}\nDoD:\n${item.definitionOfDone.map((entry) => `- ${entry}`).join('\n')}\nAction: call team_flow_status, then do the work and report with team_flow_report.`, exec.signal)
          if (failure === null) notifications.push(item.owner)
          else warnings.push(failure)
        } else if (item.owner === '' || item.owner === null || item.owner === undefined) {
          const targets = audienceFor(await store.readState(agent), membership.name)
          for (const target of targets) {
            const failure = await sendPeer(ctx, agent, target, `[ITEM] open queue item ${item.id} "${item.subject}" published by ${membership.name}: claim it with team_flow_work {action:"claim", item_id:"${item.id}"}.`, exec.signal)
            if (failure === null) notifications.push(target)
            else warnings.push(failure)
          }
        }
        const cwd = store.workingDir(agent)
        await autoProvisionWorktrees({ cwd, state: await store.readState(agent), agent, store }).catch(() => {})
        const state = await store.readState(agent)
        return {
          item_id: item.id,
          subject: item.subject,
          owner: item.owner === '' || item.owner === null || item.owner === undefined ? null : item.owner,
          assignment: item.assignment,
          status: item.status,
          task_id: item.taskId ?? null,
          origin: item.origin ?? 'member',
          created_by: item.createdBy ?? membership.name,
          notifications,
          warnings,
          next_actions: state === null ? [] : W.nextActions(state, { me: { name: membership.name, role: membership.role }, role: membership.role, members: ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, role: member.role })), settings: state.settings, now: new Date().toISOString() }),
        }
      },
    },
    {
      name: 'team_flow_talk',
      description:
        'Peer channel. Send one message to a teammate or the whole Team and record it on the workflow board. Use it to ask the peer who owns a dependency, answer questions addressed to you, or object to a decision. Delivery uses the native Team transport; the board keeps the thread and the dashboard shows it.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Teammate name (lower-kebab-case) or "team" to broadcast to every other member.' },
          kind: { type: 'string', enum: [...W.CHANNEL_KINDS], description: 'Message kind; default "note".' },
          text: { type: 'string', description: 'Message text, at most 4000 characters.' },
          item_id: { type: 'string', description: 'Optional work item id this message is about.' },
          finding_id: { type: 'string', description: 'Optional review finding id this message is about.' },
          reply_to: { type: 'string', description: 'Optional channel message id this message answers.' },
        },
        required: ['target', 'text'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          from: { type: 'string' },
          target: { type: 'string' },
          delivered_to: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['message_id'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_talk')
        const rawTarget = String(args.target ?? '').trim()
        const text = String(args.text ?? '').trim()
        if (text.length === 0) throw new Error('team_flow_talk needs non-empty text')
        let to = 'team'
        if (rawTarget !== 'team') {
          to = rawTarget
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(to)) throw new Error(`target "${to}" is not a member name (lower-kebab-case, digits allowed)`)
          if (!isLiveMember(ctx, agent, to)) {
            throw new Error(`"${to}" is not in the live roster; call team_flow_status to see the members, or use target:"team"`)
          }
        }
        let message = null
        await store.mutateState(agent, (current) => {
          if (current === null) throw new Error('no workflow run exists yet; the Lead must call team_flow_plan first')
          requireWritableRun(current, 'team_flow_talk')
          message = W.postChannelMessage(current, {
            from: membership.name,
            to,
            kind: args.kind,
            text,
            itemId: args.item_id,
            findingId: args.finding_id,
            replyTo: args.reply_to,
            now: new Date().toISOString(),
          })
          return current
        })
        const warnings = []
        const delivered = []
        const roster = ctx.agentTeams.listMembers(agent).map((member) => member.name).filter((name) => name !== membership.name)
        const targets = to === 'team' ? audienceFor(await store.readState(agent), membership.name) : [to]
        const prefix = `[CHANNEL ${message.id}] ${membership.name}${to === 'team' ? ' (to team)' : ''}${args.item_id ? ` [item ${args.item_id}]` : ''}: `
        for (const name of targets) {
          const failure = await sendPeer(ctx, agent, name, `${prefix}${text}`, exec.signal)
          if (failure === null) delivered.push(name)
          else warnings.push(failure)
        }
        return { message_id: message.id, from: membership.name, target: to, delivered_to: delivered, warnings }
      },
    },
    {
      name: 'team_flow_work',
      description:
        'Peer work coordination: claim an open-queue item, release it, invite a peer to review, accept a review invitation, or hand an unfinished item to a peer (offer / accept / decline). Use it instead of asking the Lead to assign or relay work.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['claim', 'release', 'request_review', 'take_review', 'handoff_offer', 'handoff_accept', 'handoff_decline'],
            description: 'Coordination action to perform.',
          },
          item_id: { type: 'string', description: 'Work item id.' },
          reviewer: { type: 'string', description: 'request_review only: peer name to invite; omit for an open invitation any peer can take.' },
          to: { type: 'string', description: 'handoff_offer only: peer to offer the item to.' },
          reason: { type: 'string', description: 'Optional reason (release/handoff decline).' },
          note: { type: 'string', description: 'Optional claim note.' },
          lease_minutes: { type: 'integer', description: 'Optional advisory claim lease in minutes (default 30).' },
        },
        required: ['action', 'item_id'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          action: { type: 'string' },
          item_status: { type: 'string' },
          owner: {},
          reviewer: {},
          notifications: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['item_id', 'action'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_work')
        const action = String(args.action ?? '')
        const itemId = String(args.item_id ?? '').trim()
        if (itemId.length === 0) throw new Error('team_flow_work needs item_id')
        const now = new Date().toISOString()
        let outcome = null
        let state = null
        await store.mutateState(agent, (current) => {
          if (current === null) throw new Error('no workflow run exists yet; the Lead must call team_flow_plan first')
          requireWritableRun(current, 'team_flow_work')
          state = current
          if (action === 'claim') outcome = { kind: 'claim', item: W.claimItem(current, { itemId, caller: membership.name, now, leaseMinutes: args.lease_minutes, note: args.note }) }
          else if (action === 'release') outcome = { kind: 'release', ...W.releaseItem(current, { itemId, caller: membership.name, now, reason: args.reason }) }
          else if (action === 'request_review') {
            const reviewer = args.reviewer === undefined || args.reviewer === null || String(args.reviewer).trim() === '' ? null : String(args.reviewer).trim()
            if (reviewer !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reviewer)) throw new Error(`reviewer "${reviewer}" is not a member name (lower-kebab-case, digits allowed)`)
            if (reviewer !== null && !isLiveMember(ctx, agent, reviewer)) throw new Error(`"${reviewer}" is not in the live roster`)
            outcome = { kind: 'request_review', item: W.findItem(current, itemId), request: W.requestReviewFromPeer(current, { itemId, caller: membership.name, reviewer, now }) }
          }
          else if (action === 'take_review') outcome = { kind: 'take_review', ...W.takeReview(current, { itemId, caller: membership.name, now }) }
          else if (action === 'handoff_offer') {
            const to = assertMemberName(args.to, 'to')
            if (!isLiveMember(ctx, agent, to)) throw new Error(`"${to}" is not in the live roster`)
            outcome = { kind: 'handoff_offer', item: W.findItem(current, itemId), handoff: W.offerHandoff(current, { itemId, caller: membership.name, to, reason: args.reason, now }) }
          } else if (action === 'handoff_accept' || action === 'handoff_decline') {
            outcome = { kind: action, ...W.respondHandoff(current, { itemId, caller: membership.name, accept: action === 'handoff_accept', reason: args.reason, now }) }
          } else {
            throw new Error(`unknown action "${action}"`)
          }
          return current
        })
        const item = outcome.item
        const notifications = []
        const warnings = []
        if (action === 'claim') {
          const taskId = item.taskId
          if (typeof taskId === 'string') {
            try {
              const task = ctx.agentTeams.getTask(agent, taskId)
              if (task.status === 'pending') await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'claim' })
              else if (task.status !== 'in_progress') warnings.push(`backing Team task ${taskId} is ${task.status}; the board records the claim but the task is not claimable`)
            } catch (error) {
              warnings.push(`backing Team task ${taskId} not claimed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const failure = await sendPeer(ctx, agent, 'lead', `[CLAIM] ${membership.name} claimed ${item.id} "${item.subject}" from the open queue.`, exec.signal)
          if (failure !== null) warnings.push(failure)
        } else if (action === 'release') {
          const taskId = item.taskId
          if (typeof taskId === 'string') {
            try {
              const task = ctx.agentTeams.getTask(agent, taskId)
              if (task.status === 'in_progress') await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'reopen' })
            } catch (error) {
              warnings.push(`backing Team task ${taskId} not reopened: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const failure = await sendPeer(ctx, agent, 'lead', `[HANDOFF] ${membership.name} released ${item.id}${args.reason ? `: ${args.reason}` : '.'}`, exec.signal)
          if (failure !== null) warnings.push(failure)
        } else if (action === 'request_review') {
          const request = outcome.request
          const targets = request.reviewer === null
            ? audienceFor(await store.readState(agent), membership.name)
            : [request.reviewer]
          const text = `[REVIEW] ${membership.name} requests a peer review of ${item.id} "${item.subject}".${request.reviewer === null ? ' This is an open invitation: take it with team_flow_work {action:"take_review", item_id:"' + item.id + '"}.' : ' It is addressed to you; accept with team_flow_work {action:"take_review", item_id:"' + item.id + '"}, or decline in the channel.'}`
          for (const target of targets) {
            const failure = await sendPeer(ctx, agent, target, text, exec.signal)
            if (failure === null) notifications.push(target)
            else warnings.push(failure)
          }
        } else if (action === 'take_review') {
          const owner = item.owner
          if (typeof owner === 'string' && owner.length > 0) {
            const failure = await sendPeer(ctx, agent, owner, `[REVIEW] ${membership.name} accepted the review of ${item.id}; findings will arrive through team_flow_review_submit and the channel.`, exec.signal)
            if (failure === null) notifications.push(owner)
            else warnings.push(failure)
          }
        } else if (action === 'handoff_offer') {
          const failure = await sendPeer(ctx, agent, outcome.handoff.to, `[HANDOFF] ${membership.name} offers you ${item.id} "${item.subject}"${args.reason ? `: ${args.reason}` : '.'}\nAccept with team_flow_work {action:"handoff_accept", item_id:"${item.id}"} or decline with {action:"handoff_decline"}.`, exec.signal)
          if (failure === null) notifications.push(outcome.handoff.to)
          else warnings.push(failure)
        } else {
          const taskId = item.taskId
          if (action === 'handoff_accept' && typeof taskId === 'string') {
            try {
              const task = ctx.agentTeams.getTask(agent, taskId)
              if (task.status === 'pending' || task.status === 'in_progress') {
                await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'reassign', owner: membership.name })
              }
            } catch (error) {
              warnings.push(`backing Team task ${taskId} not reassigned: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const failure = await sendPeer(ctx, agent, outcome.handoff.by, `[HANDOFF] ${membership.name} ${action === 'handoff_accept' ? 'accepted' : 'declined'} ${item.id}${args.reason ? `: ${args.reason}` : '.'}`, exec.signal)
          if (failure === null) notifications.push(outcome.handoff.by)
          else warnings.push(failure)
        }
        triggerOrchestrator(agent)
        return {
          item_id: item.id,
          action,
          item_status: item.status,
          owner: item.owner ?? null,
          reviewer: action === 'request_review' ? (outcome.request?.reviewer ?? null) : action === 'take_review' ? membership.name : null,
          notifications,
          warnings,
        }
      },
    },
    {
      name: 'team_flow_decide',
      description:
        'Peer decision protocol: open a proposal about a definition of done, scope, re-plan or review policy, vote on proposals that affect you, or withdraw your own. Affected peers (item owner + reviewers, or the whole Team) each vote once; accepted dod proposals amend the item; ties escalate to the Lead.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['propose', 'vote', 'withdraw', 'resolve'], description: 'Decision action. "resolve" is Lead-only arbitration of a tied/escalated proposal.' },
          kind: { type: 'string', enum: [...W.PROPOSAL_KINDS], description: 'propose only: proposal kind.' },
          item_id: { type: 'string', description: 'propose only: work item the proposal is about; omit for a team-wide proposal.' },
          text: { type: 'string', description: 'propose only: proposal text stating what should change and why.' },
          proposal_id: { type: 'string', description: 'vote/withdraw only: proposal id, e.g. p1.' },
          vote: { type: 'string', enum: ['yes', 'no', 'abstain'], description: 'vote only: your vote.' },
          comment: { type: 'string', description: 'vote/resolve: optional rationale recorded with the decision.' },
          timeout_minutes: { type: 'integer', description: 'propose only: minutes before the proposal auto-settles (1-1440); defaults to the run setting.' },
          outcome: { type: 'string', enum: ['accepted', 'rejected'], description: 'resolve only: the Lead decision on the proposal.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          proposal_id: { type: 'string' },
          status: { type: 'string' },
          kind: {},
          item_id: {},
          deadline: {},
          quorum: {},
          votes: {},
          tally: {},
          resolution: {},
          notifications: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['proposal_id', 'status'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_decide')
        const action = String(args.action ?? '')
        const now = new Date().toISOString()
        const members = ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, role: member.role }))
        let outcome = null
        await store.mutateState(agent, (current) => {
          if (current === null) throw new Error('no workflow run exists yet; the Lead must call team_flow_plan first')
          requireWritableRun(current, 'team_flow_decide')
          if (action === 'propose') {
            const proposal = W.proposeDecision(current, { by: membership.name, kind: args.kind, itemId: args.item_id ?? null, text: args.text, timeoutMinutes: args.timeout_minutes, settings: current.settings, members, now })
            outcome = { kind: 'propose', proposal, affected: W.affectedMembersFor(proposal, current, members) }
          } else if (action === 'vote') {
            if (!args.proposal_id) throw new Error('team_flow_decide vote needs proposal_id')
            outcome = { kind: 'vote', ...W.voteDecision(current, { proposalId: String(args.proposal_id), by: membership.name, vote: args.vote, comment: args.comment, members, settings: current.settings, now }) }
          } else if (action === 'withdraw') {
            if (!args.proposal_id) throw new Error('team_flow_decide withdraw needs proposal_id')
            outcome = { kind: 'withdraw', proposal: W.withdrawProposal(current, { proposalId: String(args.proposal_id), caller: membership.name, now }) }
          } else if (action === 'resolve') {
            requireLead(membership, 'team_flow_decide resolve')
            if (!args.proposal_id) throw new Error('team_flow_decide resolve needs proposal_id')
            outcome = { kind: 'resolve', proposal: W.settleProposalByLead(current, { proposalId: String(args.proposal_id), outcome: args.outcome, comment: args.comment, actor: membership.name, now }) }
          } else {
            throw new Error(`unknown action "${action}"`)
          }
          return current
        })
        const notifications = []
        const warnings = []
        const proposal = outcome.proposal
        if (action === 'propose') {
          for (const name of outcome.affected) {
            if (name === membership.name) continue
            const failure = await sendPeer(ctx, agent, name, `[PROPOSAL] ${membership.name} opened ${proposal.id} (${proposal.kind}${proposal.itemId ? ` on ${proposal.itemId}` : ''}): ${proposal.text}\nVote with team_flow_decide {action:"vote", proposal_id:"${proposal.id}", vote:"yes|no|abstain"}.`, exec.signal)
            if (failure === null) notifications.push(name)
            else warnings.push(failure)
          }
        } else if (action === 'vote') {
          const tally = outcome.tally
          if (proposal.by !== membership.name) {
            const failure = await sendPeer(ctx, agent, proposal.by, `[VOTE] ${membership.name} voted ${args.vote ?? 'yes'} on ${proposal.id}; tally yes=${tally.yes} no=${tally.no} abstain=${tally.abstain} of ${tally.affected} affected.`, exec.signal)
            if (failure === null) notifications.push(proposal.by)
            else warnings.push(failure)
          }
          if (outcome.resolution === 'escalated') {
            const failure = await sendPeer(ctx, agent, 'lead', `[DECISION] ${proposal.id} ended in a tie and needs Lead arbitration: ${proposal.text}`, exec.signal)
            if (failure === null) notifications.push('lead')
            else warnings.push(failure)
          }
        } else if (action === 'resolve') {
          for (const name of members.map((member) => member.name)) {
            if (name === membership.name) continue
            const failure = await sendPeer(ctx, agent, name, `[DECISION] The Lead settled ${proposal.id}: ${proposal.resolution ?? ''}`, exec.signal)
            if (failure === null) notifications.push(name)
            else warnings.push(failure)
          }
        } else {
          for (const name of members.map((member) => member.name)) {
            if (name === membership.name) continue
            const failure = await sendPeer(ctx, agent, name, `[PROPOSAL] ${membership.name} withdrew ${proposal.id}.`, exec.signal)
            if (failure === null) notifications.push(name)
            else warnings.push(failure)
          }
        }
        return {
          proposal_id: proposal.id,
          status: proposal.status,
          kind: proposal.kind,
          item_id: proposal.itemId,
          deadline: proposal.deadline ?? null,
          quorum: proposal.quorum ?? null,
          votes: action === 'vote' ? outcome.tally : proposal.votes.length,
          tally: action === 'vote' ? outcome.tally : null,
          resolution: action === 'vote' ? (proposal.resolution ?? null) : (proposal.resolution ?? null),
          notifications,
          warnings,
        }
      },
    },
    {
      name: 'team_flow_read',
      description:
        'Read the peer-collaboration context: recent Team channel messages, open proposals, the open queue, review invitations and handoffs addressed to you, unanswered questions, and (with item_id) that item thread. Use it before acting and after any peer message.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Optional work item id to include its thread and review/handoff records.' },
          limit: { type: 'integer', description: 'How many channel messages to return (default 30, max 100).' },
        },
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          channel: { type: 'array', items: {} },
          proposals: { type: 'array', items: {} },
          open_queue: { type: 'array', items: { type: 'string' } },
          my_review_requests: { type: 'array', items: {} },
          my_handoffs: { type: 'array', items: {} },
          questions_to_me: { type: 'array', items: {} },
          item: {},
          next_actions: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_read')
        let state = await requireRun(store, agent, 'team_flow_read')
        W.ensureCollaboration(state)
        {
          const liveMembers = (() => { try { return ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, role: member.role })) } catch { return [] } })()
          const settled = W.settleExpiredProposals(state, { now: new Date().toISOString(), settings: state.settings, members: liveMembers })
          if (settled.length > 0) await store.writeState(agent, state)
        }
        const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 30, 1), 100)
        const members = ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, role: member.role }))
        const summary = W.collaborationSummary(state, { me: membership.name, role: membership.role, members })
        const itemId = args.item_id === undefined || args.item_id === null || String(args.item_id).trim() === '' ? null : String(args.item_id).trim()
        let item = null
        if (itemId !== null) {
          const found = W.findItem(state, itemId)
          item = {
            id: found.id,
            subject: found.subject,
            status: found.status,
            owner: found.owner ?? null,
            assignment: found.assignment ?? 'lead',
            claim: found.claim ?? null,
            pending_reviewer: W.pendingReview(found)?.reviewer ?? null,
            review_requests: found.reviewRequests ?? [],
            handoffs: found.handoffs ?? [],
            definition_of_done: found.definitionOfDone,
            open_proposals: W.openBlockingProposals(state, found.id).map((proposal) => proposal.id),
          }
        }
        const channelSource = itemId === null
          ? state.channel
          : state.channel.filter((message) => message.refs?.itemId === itemId)
        const channel = channelSource.slice(-limit).map((message) => ({
          id: message.id,
          at: message.at,
          from: message.from,
          to: message.to,
          kind: message.kind,
          text: message.text,
          reply_to: message.replyTo ?? null,
          item_id: message.refs?.itemId ?? null,
          finding_id: message.refs?.findingId ?? null,
          proposal_id: message.refs?.proposalId ?? null,
        }))
        const proposals = state.proposals.map((proposal) => {
          const affected = W.affectedMembersFor(proposal, state, members)
          return {
            id: proposal.id,
            kind: proposal.kind,
            item_id: proposal.itemId,
            by: proposal.by,
            status: proposal.status,
            text: proposal.text,
            tally: W.tallyProposal(proposal, affected),
            votes: proposal.votes.map((vote) => ({ by: vote.by, vote: vote.vote, comment: vote.comment })),
            resolution: proposal.resolution ?? null,
          }
        })
        return {
          channel,
          proposals,
          open_queue: summary.open_queue,
          my_review_requests: summary.review_invites,
          my_handoffs: summary.handoffs_to_me,
          questions_to_me: summary.questions_to_me,
          item,
          next_actions: W.nextActions(state, { me: { name: membership.name, role: membership.role }, role: membership.role, members, settings: state.settings }),
          warnings: [],
        }
      },
    },
  ]
  return definitions.map((definition) => ({
    ...definition,
    execute: async (args, exec) => compactJson(await definition.execute(args, exec)),
  }))
}
