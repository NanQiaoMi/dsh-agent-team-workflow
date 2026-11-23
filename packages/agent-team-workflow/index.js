/**
 * Agent Team Workflow — a Cordis Host plugin for DeepSeek Harness.
 *
 * It layers a standard, injected multi-agent workflow on top of the shipped
 * Agent Teams runtime (`ctx.agentTeams`) instead of replacing it:
 *
 *   plan → parallel independent execution → mutual review → quality gates → converge
 *
 * Three things are added to every Team member:
 *   1. an injected protocol section in the system prompt (the "injection");
 *   2. seven workflow tools that make each phase transition auditable;
 *   3. a persisted run board under `<cwd>/.agentteam/` acting as a blackboard.
 *
 * Tooling is installed in the exact Agent scope of each Team member, following
 * the same per-Agent lifecycle the shipped Team tools use, so a non-Team
 * subagent never sees the workflow tools.
 */

import { resolveSettings, WORKFLOW_VERSION } from './lib/config.js'
import { createStore } from './lib/store.js'
import { buildPolicy } from './lib/protocol.js'
import { buildTools } from './lib/tools.js'
import { registerDashboardRoute } from './lib/dashboard-route.js'
import { registerMemberRoute } from './lib/member-route.js'
import { summarizeTranscript } from './lib/transcript.js'
import { installToolSandbox } from '../tool-guard-kit/index.js'
import { teamSubjectResolver } from './lib/tool-guard.js'
import { scopeGuardReason } from './lib/scope-guard.js'
import { createOrchestrator } from './lib/orchestrator.js'
import { filterToolsByRole, resolveAllowedToolNames } from './lib/tool-matrix.js'
import { createThinkingRouter } from './lib/thinking-router.js'
import { pendingReviewFor } from './lib/workflow.js'

export const name = 'agent-team-workflow'

/** Services this plugin needs; the plugin stays inactive without Agent Teams. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'workingDirectory']

const VERSION = '1.27.0'

/** Shared tool list, built once per plugin instance. */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const store = createStore({ ctx, settings })

  // Optional seam: query model reasoning capabilities from Host LLM runtime.
  let resolveModelInfoFn = null
  ctx.inject(['llm'], (scope) => {
    resolveModelInfoFn = (provider, model, signal) => scope.llm.resolveModelInfo(provider, model, signal)
    scope.effect(() => () => {
      resolveModelInfoFn = null
    }, 'agent-team-workflow: llm capability seam')
  })

  const thinkingRouter = createThinkingRouter({
    ctx,
    store,
    settings,
    resolveModelInfo: () => resolveModelInfoFn,
  })
  const orchestrator = createOrchestrator({ ctx, store, settings, tokenUsage: () => tokenUsage, thinkingRouter })
  const installed = new Map()

  const computeDuties = (membership, state) => {
    const duties = []
    if (!state || !Array.isArray(state.items)) return duties
    const isReviewer = state.items.some((item) =>
      (Array.isArray(item.reviewers) && item.reviewers.some((r) => (typeof r === 'string' ? r : r?.name) === membership.name)) ||
      pendingReviewFor(item, membership.name) !== null ||
      (Array.isArray(item.reviewRequests) && item.reviewRequests.some((req) => req?.status === 'open' && req?.reviewer === membership.name)),
    )
    if (isReviewer) duties.push('reviewer')
    const isImplementer = state.items.some((item) => item.owner === membership.name)
    if (isImplementer) duties.push('implementer')
    return duties
  }

  let tools = []

  const syncAgentTools = (agent, stateHint = null) => {
    const entry = installed.get(agent)
    if (!entry) {
      maybeInstall(agent)
      return
    }
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined) return
    let state = stateHint
    if (!state) {
      try {
        state = store.cachedState(agent)
      } catch {
        state = null
      }
    }
    const duties = computeDuties(membership, state)
    const allowedNames = resolveAllowedToolNames({
      role: membership.role,
      duties,
      settings,
      preset: state?.preset ?? null,
      state,
    })
    const targetTools = filterToolsByRole(tools, allowedNames)
    for (const def of targetTools) {
      if (entry.registeredNames.has(def.name)) continue
      entry.extraDisposers.push(agent.ctx.tools.register(def))
      entry.registeredNames.add(def.name)
    }
  }

  const refreshMemberTools = (callerAgent, memberName = null, stateHint = null) => {
    try {
      const callerMembership = ctx.agentTeams.tryMembership(callerAgent)
      if (!callerMembership) return
      const seen = new Set()
      const candidates = [...(ctx.agents?.list?.() ?? []), ...installed.keys()]
      for (const targetAgent of candidates) {
        if (!targetAgent || seen.has(targetAgent)) continue
        seen.add(targetAgent)
        const targetMembership = ctx.agentTeams.tryMembership(targetAgent)
        if (!targetMembership) continue
        const sameTeam =
          targetMembership.root === callerMembership.root ||
          (callerMembership.root?.id && targetMembership.root?.id === callerMembership.root.id)
        if (!sameTeam) continue
        if (memberName !== null && targetMembership.name !== memberName) continue
        syncAgentTools(targetAgent, stateHint)
      }
    } catch {
      /* best-effort tool refresh */
    }
  }

  tools = buildTools({ ctx, settings, store, version: VERSION, tokenUsage: () => tokenUsage, orchestrator, thinkingRouter, refreshMemberTools })

  // Start autonomous watchdog timer
  orchestrator.startWatchdog()
  ctx.effect(
    () => () => orchestrator.stopWatchdog(),
    'agent-team-workflow.watchdog()',
  )

  // Event-driven dispatch: react immediately when any teammate becomes idle
  if (settings.eventDrivenOrchestrator !== false && typeof ctx.on === 'function') {
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      if (ctx.agentTeams.tryMembership(agent) === undefined) return
      orchestrator.scheduleReconcile(agent)
    })
  }

  // Native-tool sandbox: one global guard that only acts on teammates whose
  // role names a tool policy (allow/deny/readOnly). The mechanism lives in the
  // reusable @local/dsh-tool-guard-kit; this plugin binds it to the run board.
  installToolSandbox(ctx, {
    policies: settings.roles,
    resolveSubject: teamSubjectResolver(ctx, store),
    failOpen: true,
    auditLimit: 64,
    label: 'agent-team-workflow.toolSandbox()',
  })

  // Runtime write-scope guard: gate-time strictScopes stays, but direct
  // write/edit calls outside the caller's item scopes are denied up front.
  if (settings.enforceWriteScopes) {
    ctx.effect(
      () => ctx.tools.guard((exec) => scopeGuardReason(exec, ctx, store, settings)),
      'agent-team-workflow.scopeGuard()',
    )
  }

  const maybeInstall = (agent) => {
    if (installed.has(agent)) return
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined) return
    const policy = buildPolicy(settings, membership.role)

    // Inspect cached state to see if member has reviewer/implementer duties in any planned item
    let state = null
    try {
      state = store.cachedState(agent)
    } catch {
      /* cachedState is best-effort */
    }
    const duties = computeDuties(membership, state)

    const allowedNames = resolveAllowedToolNames({
      role: membership.role,
      duties,
      settings,
      preset: state?.preset ?? null,
      state,
    })
    const scopedTools = filterToolsByRole(tools, allowedNames)

    const dispose = install(agent, ctx, { settings, tools: scopedTools, store, policy, thinkingRouter })
    installed.set(agent, {
      dispose,
      registeredNames: new Set(scopedTools.map((def) => def.name)),
      extraDisposers: [],
    })
    // Warm the prompt-context summary so the first step already sees the run
    // instead of waiting for the member to call a tool. Best effort: a missing
    // or unreadable board is not an installation failure.
    void store.readState(agent).catch(() => undefined)
  }

  const disposeEntry = (entry) => {
    if (!entry) return
    if (Array.isArray(entry.extraDisposers)) {
      for (const extra of [...entry.extraDisposers].reverse()) extra()
    }
    entry.dispose?.()
  }

  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => maybeInstall(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    disposeEntry(installed.get(agent))
    installed.delete(agent)
    thinkingRouter.clearAgent(agent.id)
  })
  ctx.effect(
    () => () => {
      for (const entry of installed.values()) disposeEntry(entry)
      installed.clear()
      thinkingRouter.clearCache()
    },
    'agent-team-workflow.scopedTools()',
  )

  // The live board is served through Connection's authenticated Fetch fence.
  // Profiles without a browser surface (headless runs) simply never get the
  // route, and the Host-side workflow keeps working unchanged.
  // Optional seam: read the token-meter projection when the Host provides it.
  // A missing service leaves usage unknown instead of failing the plugin.
  let tokenUsage = () => null
  ctx.inject(['sessionProjections'], (scope) => {
    const read = (agent) => {
      try {
        const totals = scope.sessionProjections.stateOf(agent.session, 'tokenUsage')
        return totals === null || totals === undefined ? null : { ...totals }
      } catch {
        return null
      }
    }
    tokenUsage = read
    scope.effect(() => () => {
      tokenUsage = () => null
    }, 'agent-team-workflow: token usage seam')
  })

  // Optional seam: read a teammate's session log for the transcript panel.
  let readSessionEvents = () => null
  ctx.inject(['sessionQuery'], (scope) => {
    readSessionEvents = async (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      const record = await scope.sessionQuery.readSession(sessionId)
      return record === null || record === undefined ? null : record.events ?? null
    }
    scope.effect(() => () => {
      readSessionEvents = () => null
    }, 'agent-team-workflow: session transcript seam')
  })

  ctx.inject(['connection'], (scope) => {
    scope.effect(
      () => registerDashboardRoute({ connection: scope.connection, ctx, store, settings, thinkingRouter }),
      'agent-team-workflow: live board route',
    )
    scope.effect(
      () => registerMemberRoute({
        connection: scope.connection,
        ctx,
        store,
        settings,
        transcript: async (sessionId, options) => {
          const events = await readSessionEvents(sessionId)
          if (events === null) return null
          return summarizeTranscript(events, options)
        },
      }),
      'agent-team-workflow: member view route',
    )
  })

  ctx.logger?.info?.(`agent-team-workflow ${VERSION} applied (policy=${settings.injectPolicy}, artifacts=${settings.artifactsDir})`)
}

/**
 * Install the workflow surface in one exact Agent scope.
 * @param agent - exact live Team member.
 * @param ctx - plugin context (root) for shared services.
 * @param options - `{ settings, tools, store, policy }`.
 * @returns disposer that unwinds every registration in reverse order.
 */
function install(agent, ctx, options) {
  const scoped = agent.ctx
  const disposers = []
  const register = (disposer) => disposers.push(disposer)
  try {
    if (options.settings.injectPolicy) {
      register(
        scoped.systemPrompt.section({
          name: 'team:workflow',
          order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
          text: options.policy,
        }),
      )
      register(
        scoped.systemPrompt.context({
          name: 'team:workflow-state',
          order: scoped.systemPrompt.getContextOrder('TEAM_IDENTITY') + 1,
          required: true,
          text: () => options.store.cachedSummary(agent) ?? '',
        }),
      )
    }
    for (const definition of options.tools) register(scoped.tools.register(definition))
    if (options.thinkingRouter) register(options.thinkingRouter.install(agent))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

export { WORKFLOW_VERSION }
