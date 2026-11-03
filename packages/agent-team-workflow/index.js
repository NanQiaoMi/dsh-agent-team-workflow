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

export const name = 'agent-team-workflow'

/** Services this plugin needs; the plugin stays inactive without Agent Teams. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'workingDirectory']

const VERSION = '1.9.1'

/** Shared tool list, built once per plugin instance. */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const store = createStore({ ctx, settings })
  const tools = buildTools({ ctx, settings, store, version: VERSION, tokenUsage: () => tokenUsage })
  const policy = buildPolicy(settings)
  const installed = new Map()

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

  const maybeInstall = (agent) => {
    if (installed.has(agent)) return
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined) return
    installed.set(agent, install(agent, ctx, { settings, tools, store, policy }))
    // Warm the prompt-context summary so the first step already sees the run
    // instead of waiting for the member to call a tool. Best effort: a missing
    // or unreadable board is not an installation failure.
    void store.readState(agent).catch(() => undefined)
  }

  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => maybeInstall(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = installed.get(agent)
    if (dispose !== undefined) dispose()
    installed.delete(agent)
  })
  ctx.effect(
    () => () => {
      for (const dispose of installed.values()) dispose()
      installed.clear()
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
      () => registerDashboardRoute({ connection: scope.connection, ctx, store, settings }),
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
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

export { WORKFLOW_VERSION }
