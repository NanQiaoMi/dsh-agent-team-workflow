/**
 * Planning, status, gate, repair, staffing, stop, and plan-approval tools.
 */

import fs from 'node:fs'
import path from 'node:path'

import { applyWorkflowPreset, runSettings } from '../config.js'
import {
  renderQueueBrief,
  renderReportMarkdown,
  renderReviewerBrief,
  renderWorkerBrief,
  reviewRequestMessage,
  roleGuidance,
} from '../protocol.js'
import { computeUsage } from '../telemetry.js'
import * as W from '../workflow.js'
import {
  autoCleanupRunWorktrees,
  autoProvisionWorktrees,
  runIntegrationVerify,
  toIntegrationGateRecord,
} from '../worktree-manager.js'
import {
  assertMemberName,
  formatToolValidationError,
  isLiveMember,
  jsonOutput,
  makeRunId,
  normalizeItem,
  requireLead,
  requireRun,
  requireWritableRun,
  resolveCaller,
  runHook,
  sendPeer,
  staffEntries,
  taskDescription,
} from './shared.js'

export function buildDomainTools({ ctx, settings, store, version, tokenUsage, orchestrator, thinkingRouter, refreshMemberTools, triggerOrchestrator }) {
  return [
    {
      name: 'team_flow_plan',
      description:
        'Lead-only. Create workflow run with disjoint-scope items, DoD, dependencies, and reviewers; returns task ids and spawn briefs.',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string' },
          acceptance_criteria: { type: 'array', items: { type: 'string' } },
          constraints: { type: 'array', items: { type: 'string' } },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Short id e.g. W1.' },
                subject: { type: 'string' },
                owner: { type: 'string', description: 'Owner name (never "lead"); omit for open queue.' },
                assignment: { type: 'string', enum: ['lead', 'open'], description: 'lead (default) or open queue.' },
                role: { type: 'string', description: 'implementer|verifier|researcher|architect|writer.' },
                write_scopes: { type: 'array', items: { type: 'string' }, description: 'Relative paths; disjoint within a wave.' },
                blocked_by: { type: 'array', items: { type: 'string' }, description: 'Prerequisite item ids.' },
                definition_of_done: { type: 'array', items: { type: 'string' } },
                needs_review: { type: 'boolean', description: 'Default true.' },
                reviewers: { type: 'array', items: { type: 'string' }, description: 'Independent reviewers (not owner).' },
                evidence_optional: { type: 'boolean', description: 'True only for read-only/research.' },
                complexity: { type: 'string', enum: ['trivial', 'normal', 'complex'] },
                thinking_tier: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'max', 'inherit'] },
                review_depth: { type: 'string', enum: ['auto', 'light', 'standard', 'deep'] },
                review_profile: { type: 'string', enum: ['auto', 'code', 'security', 'api', 'docs', 'tests', 'refactor'] },
              },
              required: ['subject', 'definition_of_done'],
            },
            description: 'Planned items.',
          },
          workers: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' } }, required: ['name'] },
              ],
            },
            description: 'Open-queue pool: name or {name,role}.',
          },
          replace: { type: 'boolean', description: 'Archive existing run and restart.' },
          preset: { type: 'string', enum: ['fast-fix', 'feature', 'pr-review', 'deep-audit'] },
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
        const normalizedItems = rawItems.map((raw, index) => normalizeItem(raw, index))
        const presetApplied = applyWorkflowPreset(runSettings(settings), normalizedItems, rawItems, args.preset)
        const effective = presetApplied.settings
        const items = presetApplied.items
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
        const preflight = W.preflightPlan(plan, effective)
        const allErrors = [...new Set([...validation.errors, ...preflight.errors])]
        if (allErrors.length > 0) {
          throw new Error(
            formatToolValidationError({
              tool: 'team_flow_plan',
              reason: `the plan violates the workflow rules:\n- ${allErrors.join('\n- ')}`,
              example: {
                objective: '...',
                acceptance_criteria: ['...'],
                items: [
                  {
                    id: 'W1',
                    subject: '...',
                    owner: 'worker1',
                    reviewers: ['rev1'],
                    write_scopes: ['src/'],
                    definition_of_done: ['...'],
                  },
                ],
              },
            }),
          )
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
            preset: presetApplied.preset,
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
        const wave1Ids = new Set(validation.waves[0] ?? [])
        const wave1Workers = new Set(assignedItems.filter((item) => wave1Ids.has(item.id)).map((item) => item.owner))
        const immediateWorkers = settings.lazyStaffing
          ? workerSpawn.filter((entry) => wave1Workers.has(entry.name))
          : workerSpawn
        const deferredEntries = settings.lazyStaffing
          ? [
              ...workerSpawn.filter((entry) => !wave1Workers.has(entry.name)).map((entry) => ({ name: entry.name, kind: 'worker' })),
              ...reviewerSpawn.map((entry) => ({ name: entry.name, kind: 'reviewer' })),
            ]
          : []
        const seenDeferred = new Set()
        const deferred = []
        for (const entry of deferredEntries) {
          if (seenDeferred.has(entry.name)) continue
          seenDeferred.add(entry.name)
          deferred.push(entry)
        }
        const staffInputs = [
          ...immediateWorkers.map((entry) => ({ ...entry, kind: 'worker' })),
          ...queueSpawn.map((entry) => ({ ...entry, kind: 'worker-pool' })),
          ...(settings.lazyStaffing ? [] : reviewerSpawn.map((entry) => ({ ...entry, kind: 'reviewer' }))),
        ]
        const staffed = autoSpawn
          ? await staffEntries({ ctx, agent, entries: staffInputs, settings, signal: exec.signal })
          : { spawned: [], woken: [], skipped: [], failed: [], needs_spawn: staffInputs.map((entry) => ({ name: entry.name, kind: entry.kind, reason: 'auto_staff disabled' })) }
        if (settings.lazyStaffing) {
          staffed.deferred = deferred
        }
        const teamKey = state.teamId ?? store.teamIdOf?.(agent) ?? agent.id
        const staffedNames = new Set([
          ...staffed.spawned.map((entry) => entry.name),
          ...staffed.woken,
        ])
        for (const item of assignedItems) {
          if (wave1Ids.has(item.id) && staffedNames.has(item.owner)) {
            orchestrator?.markNotified?.(teamKey, 'wake-worker', item.owner, item.id, state.rev)
          }
        }
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
          ...(settings.lazyStaffing && deferred.length > 0
            ? [`Lazy staffing active: deferred ${deferred.map((entry) => `${entry.name}(${entry.kind})`).join(', ')} until unblocked or awaiting review.`]
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
          ...preflight.warnings,
        ]
        triggerOrchestrator(agent)
        refreshMemberTools?.(agent, null, state)
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
          preflight_warnings: preflight.warnings,
          warnings: [...archived.map((path) => `archived previous run state to ${path}`), ...validation.warnings, ...preflight.warnings],
          next_actions: nextActions,
        }
      },
    },
    {
      name: 'team_flow_status',
      description:
        'Read board state, items, review state, and next_actions. Call first and after peer messages.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Include full report/reviews for item.' },
          view: { type: 'string', enum: ['brief', 'full'], description: 'brief (compact) or full.' },
          since_rev: { type: 'integer', description: 'Return {unchanged:true} if rev matches.' },
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
        const requestedView = args.view === 'brief' || args.view === 'full' ? args.view : settings.statusView
        const status = W.buildStatus(state, {
          me: { name: membership.name, role: membership.role },
          role: membership.role,
          settings: state.settings,
          members,
          artifacts,
          tasksById,
          detailItemId,
          view: requestedView,
          sinceRev: Number.isInteger(args.since_rev) ? args.since_rev : undefined,
        })
        return { ...status, workflow_version: W.WORKFLOW_VERSION, artifacts, settings }
      },
    },
    {
      name: 'team_flow_gate',
      description:
        'Lead-only. Evaluate quality gates and optionally finalize the run.',
      parameters: {
        type: 'object',
        properties: {
          finalize: { type: 'boolean', description: 'Finalize and write report when gates pass.' },
          overrides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                item_id: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['item_id', 'reason'],
            },
            description: 'Explicit Lead risk acceptances.',
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
          const readUsage = tokenUsage?.()
          const usage = computeUsage({ members, read: readUsage, state: current, now })
          const routingSnapshot = thinkingRouter?.snapshot?.(current.teamId ?? store.teamIdOf?.(agent)) ?? null
          if (routingSnapshot !== null) usage.routing = routingSnapshot
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
            const integration = await runIntegrationVerify({ cwd: store.workingDir(agent), state: current })
            if (integration.skipped !== true) {
              const integrationGate = toIntegrationGateRecord(integration)
              current.integrationGate = integrationGate
              gate.integration = integrationGate
              if (!integration.ok) {
                const failureDetail = integration.summary || integration.error || 'integration verification failed'
                gate.pass = false
                gate.teamFailures.push(`integration gate failed: ${failureDetail}`)
                W.appendEvent(current, { at: now, type: 'gate/integration-failed', actor: membership.name, detail: failureDetail })
              } else {
                W.appendEvent(current, {
                  at: now,
                  type: 'gate/integration-passed',
                  actor: membership.name,
                  detail: `${integrationGate.results.length} command(s) passed (${integrationGate.durationMs}ms)`,
                })
              }
            }
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
          integration_gate: state.integrationGate ?? null,
          report_path: reportPath,
          next_actions: nextActions,
        }
      },
    },
    {
      name: 'team_flow_repair',
      description:
        'Lead-only. Repair a stuck item (reopen, reassign owner, or reset_review) with an audited reason.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          action: { type: 'string', enum: ['reopen', 'reassign', 'reset_review'] },
          reason: { type: 'string' },
          owner: { type: 'string', description: 'reassign: new owner name.' },
          reviewer: { type: 'string', description: 'reset_review: reviewer name (optional).' },
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
            item.archived = false
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
        if (action === 'reassign') refreshMemberTools?.(agent, item.owner, state)
        else if (action === 'reset_review') refreshMemberTools?.(agent, W.pendingReview(item)?.reviewer ?? null, state)
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
    {
      name: 'team_flow_staff',
      description:
        'Lead-only. Spawn missing owners/reviewers/pool and wake inactive ones with their brief.',
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' }, description: 'Target item ids (defaults to all unfinished).' },
          reason: { type: 'string' },
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
      name: 'team_flow_stop',
      description:
        'Graceful shutdown protocol: Lead requests/interrupts member stop; member accepts/rejects.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['request', 'accept', 'reject', 'interrupt', 'status'] },
          member: { type: 'string', description: 'request/interrupt: teammate name.' },
          reason: { type: 'string' },
          stop_id: { type: 'string', description: 'interrupt: optional stop record id.' },
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
        'Plan-first workflow: owner submits item plan; Lead or peer approver approves or rejects.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['submit', 'approve', 'reject', 'status'] },
          item_id: { type: 'string' },
          plan: {
            type: 'object',
            properties: {
              steps: { type: 'array', items: { type: 'string' } },
              files: { type: 'array', items: { type: 'string' } },
              risks: { type: 'array', items: { type: 'string' } },
            },
            description: 'submit: implementation plan.',
          },
          reason: { type: 'string', description: 'reject rationale or optional approve note.' },
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
  ]
}
