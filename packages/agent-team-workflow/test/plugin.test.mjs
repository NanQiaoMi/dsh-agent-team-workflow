/**
 * Activation tests: verify the plugin's Cordis wiring with service doubles.
 *
 * These cover what the engine tests cannot: which Agents get the tools, what
 * prompt inputs are installed, and that every registration is unwound on Agent
 * disposal and plugin disposal. They use doubles for `ctx.agents`,
 * `ctx.agentTeams`, `ctx.tools`, and `ctx.systemPrompt`, but the plugin code and
 * the run store are the real ones writing to a real temporary directory.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { resolveSettings } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { filterToolsByRole, resolveAllowedToolNames } from '../lib/tool-matrix.js'
import { buildTools } from '../lib/tools.js'
import * as W from '../lib/workflow.js'

const EXPECTED_TOOLS = [
  'team_dev_contract',
  'team_dev_lookup',
  'team_flow_decide',
  'team_flow_escalate',
  'team_flow_gate',
  'team_flow_git',
  'team_flow_item',
  'team_flow_plan',
  'team_flow_plan_approval',
  'team_flow_read',
  'team_flow_repair',
  'team_flow_report',
  'team_flow_review_respond',
  'team_flow_review_submit',
  'team_flow_staff',
  'team_flow_status',
  'team_flow_stop',
  'team_flow_talk',
  'team_flow_work',
]

const EXPECTED_IMPLEMENTER_TOOLS = [
  'team_dev_contract',
  'team_dev_lookup',
  'team_flow_decide',
  'team_flow_escalate',
  'team_flow_git',
  'team_flow_item',
  'team_flow_read',
  'team_flow_report',
  'team_flow_review_respond',
  'team_flow_status',
  'team_flow_talk',
  'team_flow_work',
]

const EXPECTED_REVIEWER_TOOLS = [
  'team_dev_contract',
  'team_dev_lookup',
  'team_flow_decide',
  'team_flow_git',
  'team_flow_read',
  'team_flow_review_submit',
  'team_flow_status',
  'team_flow_talk',
]

/** A minimal Cordis-shaped context with per-Agent scoped services. */
function createContext(cwd) {
  const tools = []
  const routes = []
  const sections = []
  const contexts = []
  const guards = []
  const handlers = new Map()
  const effects = []
  const membership = new Map()
  const lead = { id: 'session-lead', session: { id: 'session-lead' }, ctx: undefined }
  const teammate = { id: 'session-worker', session: { id: 'session-worker' }, ctx: undefined }
  const outsider = { id: 'session-subagent', session: { id: 'session-subagent' }, ctx: undefined }

  const scopedFor = (agent) => {
    const scopedListeners = new Map()
    return {
      tools: {
        register(definition) {
          tools.push({ agent: agent.id, name: definition.name, definition })
          return () => {
            const index = tools.findIndex((entry) => entry.agent === agent.id && entry.name === definition.name)
            if (index >= 0) tools.splice(index, 1)
          }
        },
      },
      on(event, handler, opts = {}) {
        const list = scopedListeners.get(event) ?? []
        if (opts.prepend) list.unshift(handler)
        else list.push(handler)
        scopedListeners.set(event, list)
        return () => {
          const current = scopedListeners.get(event) ?? []
          scopedListeners.set(event, current.filter((candidate) => candidate !== handler))
        }
      },
      async runWaterfall(event, payload, base) {
        const list = [...(scopedListeners.get(event) ?? [])]
        let idx = 0
        const next = async () => {
          if (idx < list.length) {
            const fn = list[idx]
            idx += 1
            return await fn({ ...payload, agent }, next)
          }
          return base
        }
        return await next()
      },
      listenerCount(event) {
        return (scopedListeners.get(event) ?? []).length
      },
      systemPrompt: {
        getSectionOrder: (name) => (name === 'TEAM_POLICY' ? 600 : 0),
        getContextOrder: (name) => (name === 'TEAM_IDENTITY' ? 125 : 0),
        section(entry) {
          sections.push({ agent: agent.id, ...entry })
          return () => sections.splice(sections.findIndex((candidate) => candidate.agent === agent.id && candidate.name === entry.name), 1)
        },
        context(entry) {
          contexts.push({ agent: agent.id, ...entry })
          return () => contexts.splice(contexts.findIndex((candidate) => candidate.agent === agent.id && candidate.name === entry.name), 1)
        },
      },
    }
  }

  for (const agent of [lead, teammate, outsider]) agent.ctx = scopedFor(agent)
  membership.set(lead.id, { root: lead, id: lead.id, name: 'lead', role: 'lead' })
  membership.set(teammate.id, { root: lead, id: teammate.id, name: 'worker', role: 'teammate' })

  const tasks = []
  const messages = []
  let taskNumber = 0

  const ctx = {
    logger: { info() {}, warn() {} },
    agents: { list: () => [lead, teammate, outsider] },
    agentTeams: {
      tryMembership: (agent) => membership.get(agent.id),
      membership: (agent) => {
        const found = membership.get(agent.id)
        if (found === undefined) throw new Error('not a member')
        return found
      },
      listMembers: () => [...membership.values()].map((entry) => ({ name: entry.name, role: entry.role, status: 'running', context: 'fresh' })),
      async createTask(_caller, request) {
        taskNumber += 1
        const task = {
          id: `task-${taskNumber}`,
          revision: 1,
          subject: request.subject,
          description: request.description,
          status: 'pending',
          blockedBy: [...(request.blockedBy ?? [])],
          writeScopes: [...(request.writeScopes ?? [])],
        }
        tasks.push(task)
        return { ...task }
      },
      getTask(_caller, id) {
        const task = tasks.find((candidate) => candidate.id === id)
        if (task === undefined) throw new Error(`unknown task ${id}`)
        return { ...task }
      },
      listTasks: () => tasks.map((task) => ({ ...task })),
      async updateTask(_caller, request) {
        const task = tasks.find((candidate) => candidate.id === request.taskId)
        if (task === undefined) throw new Error(`unknown task ${request.taskId}`)
        if (task.revision !== request.expectedRevision) throw new Error('stale revision')
        if (request.action === 'claim') task.status = 'in_progress'
        if (request.action === 'complete') task.status = 'completed'
        if (request.action === 'reopen') task.status = 'pending'
        if (request.action === 'delete') task.status = 'deleted'
        task.revision += 1
        return { ...task }
      },
      async sendMessage(_caller, request) {
        messages.push({ to: request.target, text: request.content[0].text })
        return { messageId: `msg-${messages.length}` }
      },
    },
    workingDirectory: { get: () => cwd, defaultDirectory: cwd },
    tools: {
      register() {
        return () => {}
      },
      guard(fn) {
        guards.push(fn)
        return () => {
          const index = guards.indexOf(fn)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const current = handlers.get(event) ?? []
        handlers.set(event, current.filter((candidate) => candidate !== handler))
      }
    },
    effect(factory) {
      effects.push(factory())
      return () => {}
    },
    /**
    * Cordis-style optional-service injection: run the callback once the named
    * services are available on the reading context.
    */
    inject(dependencies, callback) {
      // Cordis runs the callback only once every named service is present.
      if (!dependencies.every((dependency) => ctx[dependency] !== undefined)) return () => {}
      const scope = {
        effect: (factory) => ctx.effect(factory),
        on: (event, handler) => ctx.on(event, handler),
        logger: ctx.logger,
      }
      for (const dependency of dependencies) scope[dependency] = ctx[dependency]
      callback(scope)
      return () => {}
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    // Connection face: the plugin registers its snapshot route through the
    // authenticated Fetch registry when a browser surface exists.
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
      },
    },
  }
  return { ctx, lead, teammate, outsider, tools, sections, contexts, guards, handlers, membership, scopedFor, tasks, messages, routes, effects }
}

async function withWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'atw-plugin-'))
  try {
    return await fn(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

test('applies workflow tools and prompt inputs only to Team members', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    apply(harness.ctx, {})
    const names = harness.tools.filter((entry) => entry.agent === harness.lead.id).map((entry) => entry.name).sort()
    assert.deepEqual(names, EXPECTED_TOOLS)
    const teammateNames = harness.tools.filter((entry) => entry.agent === harness.teammate.id).map((entry) => entry.name).sort()
    assert.deepEqual(teammateNames, EXPECTED_IMPLEMENTER_TOOLS)
    assert.equal(harness.tools.filter((entry) => entry.agent === harness.teammate.id).length, 12, 'teammate gets scoped implementer tools')
    assert.equal(harness.tools.filter((entry) => entry.agent === harness.outsider.id).length, 0, 'non-Team subagents never see the workflow tools')

    const leadSections = harness.sections.filter((entry) => entry.agent === harness.lead.id)
    assert.equal(leadSections.length, 1)
    assert.equal(leadSections[0].name, 'team:workflow')
    assert.equal(leadSections[0].order, 600)
    assert.match(leadSections[0].text, /Agent Team Workflow/)
    assert.match(leadSections[0].text, /team_flow_plan/)
    assert.match(leadSections[0].text, /Independence\./)

    const leadContexts = harness.contexts.filter((entry) => entry.agent === harness.lead.id)
    assert.equal(leadContexts.length, 1)
    assert.equal(leadContexts[0].name, 'team:workflow-state')
    assert.equal(leadContexts[0].order, 126)
    assert.equal(leadContexts[0].text(), '', 'no run yet means no injected state')

    assert.equal(harness.routes.length, 2, 'the live board and member routes register once each')
    const snapshotRoute = harness.routes.find((route) => route.path === '/api/agent-team-workflow.snapshot')
    const memberRoute = harness.routes.find((route) => route.path === '/api/agent-team-workflow.member')
    assert.ok(snapshotRoute !== undefined)
    assert.ok(memberRoute !== undefined)
    assert.deepEqual(snapshotRoute.methods, ['GET'])
    assert.deepEqual(memberRoute.methods, ['GET', 'POST'])
  })
})

test('a newly created teammate is installed and disposal unwinds every registration', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    apply(harness.ctx, {})
    const late = { id: 'session-late', session: { id: 'session-late' } }
    late.ctx = harness.scopedFor(late)
    harness.membership.set(late.id, { root: harness.lead, id: late.id, name: 'late', role: 'teammate' })

    harness.ctx.emit('agent/created', { agent: late })
    assert.equal(harness.tools.filter((entry) => entry.agent === late.id).length, 12)
    assert.equal(harness.sections.filter((entry) => entry.agent === late.id).length, 1)

    harness.ctx.emit('agent/disposed', { agent: late })
    assert.equal(harness.tools.filter((entry) => entry.agent === late.id).length, 0)
    assert.equal(harness.sections.filter((entry) => entry.agent === late.id).length, 0)
    assert.equal(harness.contexts.filter((entry) => entry.agent === late.id).length, 0)
  })
})

test('the injected state context reflects a run created through the real tools', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    apply(harness.ctx, {})
    const planTool = harness.tools.find((entry) => entry.agent === harness.lead.id && entry.name === 'team_flow_plan')
    assert.ok(planTool !== undefined)
    const result = await planTool.definition.execute(
      {
        objective: 'Ship a verified module',
        acceptance_criteria: ['module works'],
        items: [
          {
            id: 'W1',
            subject: 'Implement it',
            owner: 'worker',
            write_scopes: ['src/'],
            definition_of_done: ['it works'],
            reviewers: ['lead'],
          },
        ],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )
    assert.match(result.run_id, /^run-/)

    const context = harness.contexts.find((entry) => entry.agent === harness.lead.id)
    const text = context.text()
    assert.match(text, new RegExp(result.run_id))
    assert.match(text, /is active/)
    assert.match(text, /team_flow_status/)
    assert.equal(harness.tasks.length, 1, 'planning creates one backing Team task')

    // KV-Cache stability: mutating run phase and item status must not alter the injected context string
    const reportTool = harness.tools.find((entry) => entry.agent === harness.teammate.id && entry.name === 'team_flow_report')
    assert.ok(reportTool !== undefined)
    await reportTool.definition.execute(
      {
        item_id: 'W1',
        summary: 'Implemented module',
        files: ['src/index.js'],
        commands: [{ command: 'node --test', exit_code: 0 }],
        evidence: ['all tests pass'],
      },
      { agent: harness.teammate, signal: new AbortController().signal },
    )
    assert.equal(context.text(), text, 'team:workflow-state must remain byte-identical across state transitions')
  })
})

test('injectPolicy=false installs tools without prompt inputs', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    apply(harness.ctx, { injectPolicy: false })
    assert.equal(harness.tools.filter((entry) => entry.agent === harness.lead.id).length, 19)
    assert.equal(harness.sections.length, 0)
    assert.equal(harness.contexts.length, 0)
  })
})

test('two Teams in one workspace never share a board', () => {
  return withWorkspace(async (cwd) => {
    const leadA = { id: 'session-team-a', session: { id: 'session-team-a' } }
    const leadB = { id: 'session-team-b', session: { id: 'session-team-b' } }
    const ctx = {
      workingDirectory: { get: () => cwd, defaultDirectory: cwd },
    tools: {
      register() {
        return () => {}
      },
      guard(fn) {
        guards.push(fn)
        return () => {
          const index = guards.indexOf(fn)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
      agentTeams: {
        tryMembership: (agent) => ({ root: agent, id: agent.id, name: 'lead', role: 'lead' }),
      },
    }
    const store = createStore({ ctx, settings: resolveSettings({}) })
    const pathA = store.statePath(leadA)
    const pathB = store.statePath(leadB)
    assert.notEqual(pathA, pathB)
    assert.match(pathA, /teams[\\/]session-team-a[\\/]state\.json$/)
    assert.match(pathB, /teams[\\/]session-team-b[\\/]state\.json$/)

    const state = W.createRun({
      workflowVersion: W.WORKFLOW_VERSION,
      runId: 'run-a',
      teamId: 'session-team-a',
      objective: 'a',
      acceptanceCriteria: ['x'],
      constraints: [],
      settings: { maxReviewRounds: 2, maxParallelItems: 4, workerContext: 'fresh', strictScopes: false, allowScopeOverlap: false, requireReviewEvidence: true },
      items: [],
      actor: 'lead',
      now: '2026-11-01T00:00:00.000Z',
    })
    await store.writeState(leadA, state)
    assert.equal((await store.readState(leadA)).runId, 'run-a')
    assert.equal(await store.readState(leadB), null, 'Team B must not see Team A run')
  })
})

test('the optional runtime write-scope guard registers a second guard when enabled', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    apply(harness.ctx, { enforceWriteScopes: true })
    assert.equal(harness.guards.length, 2, 'sandbox + scope guard when enforceWriteScopes is on')
    const scopeGuard = harness.guards[1]
    // No board is loaded yet, so the guard fails open instead of guessing.
    assert.equal(scopeGuard({ name: 'write', agent: harness.teammate, arguments: { file_path: 'x.txt' } }), undefined)
  })
})

test('the native tool sandbox registers one guard and lets non-members through', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    apply(harness.ctx, {})
    assert.equal(harness.guards.length, 1, 'exactly one global tool guard is registered')
    const guard = harness.guards[0]
    // A plain Agent without Team membership is never blocked.
    assert.equal(guard({ name: 'write', agent: { id: 'session-outsider' } }), undefined)
  })
})

test('role-adaptive policy tailors prompt sections for implementer and reviewer', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    apply(harness.ctx, {})

    const worker = { id: 'session-impl', session: { id: 'session-impl' } }
    worker.ctx = harness.scopedFor(worker)
    harness.membership.set(worker.id, { root: harness.lead, id: worker.id, name: 'impl', role: 'implementer' })

    const reviewer = { id: 'session-rev', session: { id: 'session-rev' } }
    reviewer.ctx = harness.scopedFor(reviewer)
    harness.membership.set(reviewer.id, { root: harness.lead, id: reviewer.id, name: 'rev', role: 'reviewer' })

    harness.ctx.emit('agent/created', { agent: worker })
    harness.ctx.emit('agent/created', { agent: reviewer })

    const workerSection = harness.sections.find((s) => s.agent === worker.id && s.name === 'team:workflow')
    assert.ok(workerSection, 'worker must have workflow policy section')
    assert.match(workerSection.text, /Worker Protocol/)
    assert.match(workerSection.text, /Do NOT plan, delegate, or spawn/)
    assert.match(workerSection.text, /Your task is already claimed for you/)

    const reviewerSection = harness.sections.find((s) => s.agent === reviewer.id && s.name === 'team:workflow')
    assert.ok(reviewerSection, 'reviewer must have workflow policy section')
    assert.match(reviewerSection.text, /Reviewer Protocol/)
    assert.match(reviewerSection.text, /adversarial reviewer/)
    assert.match(reviewerSection.text, /Inspect Real Changes/)

    // Check scoped tools
    const workerTools = harness.tools.filter((t) => t.agent === worker.id).map((t) => t.name).sort()
    assert.deepEqual(workerTools, EXPECTED_IMPLEMENTER_TOOLS)
    const reviewerTools = harness.tools.filter((t) => t.agent === reviewer.id).map((t) => t.name).sort()
    assert.deepEqual(reviewerTools, EXPECTED_REVIEWER_TOOLS)
  })
})

test('legacyAllTools restores all tools for teammates', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    apply(harness.ctx, { legacyAllTools: true })
    assert.equal(harness.tools.filter((entry) => entry.agent === harness.teammate.id).length, 19)
    assert.equal(harness.tools.filter((entry) => entry.agent === harness.lead.id).length, 19)
  })
})

test('the applied plugin version matches package.json', async () => {
  const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const match = /const VERSION = '([^']+)'/.exec(indexSource)
  assert.ok(match !== null, 'index.js declares VERSION')
  assert.equal(match[1], pkg.version, 'the applied-version log line must not drift from package.json')
})

test('event-driven agent/status idle wakes unblocked downstream members immediately', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    const worker2 = { id: 'session-worker2', session: { id: 'session-worker2' } }
    worker2.ctx = harness.scopedFor(worker2)
    harness.membership.set(worker2.id, { root: harness.lead, id: worker2.id, name: 'worker2', role: 'teammate' })

    const liveStatus = new Map([
      ['lead', 'running'],
      ['worker', 'running'],
      ['worker2', 'running'],
    ])
    harness.ctx.agentTeams.listMembers = () =>
      [...harness.membership.values()].map((entry) => ({
        id: entry.id,
        name: entry.name,
        role: entry.role,
        status: liveStatus.get(entry.name) ?? 'inactive',
        context: 'fresh',
      }))

    apply(harness.ctx, { autoOrchestrate: true, eventDrivenOrchestrator: true, watchdogIntervalSeconds: 60, autoStaff: false })
    try {
      const planTool = harness.tools.find((entry) => entry.agent === harness.lead.id && entry.name === 'team_flow_plan')
      await planTool.definition.execute(
        {
          objective: 'Event-driven idle dispatch',
          acceptance_criteria: ['Downstream wakes on idle event'],
          items: [
            { id: 'W1', subject: 'First', owner: 'worker', write_scopes: ['src/a/'], definition_of_done: ['done'], reviewers: ['lead'] },
            { id: 'W2', subject: 'Second', owner: 'worker2', blocked_by: ['W1'], write_scopes: ['src/b/'], definition_of_done: ['done'], reviewers: ['lead'] },
          ],
        },
        { agent: harness.lead, signal: new AbortController().signal },
      )

      const reportTool = harness.tools.find((entry) => entry.agent === harness.teammate.id && entry.name === 'team_flow_report')
      await reportTool.definition.execute(
        { item_id: 'W1', summary: 'W1 ready', files: ['src/a/1.js'], commands: [{ command: 'node --test', exit_code: 0 }], evidence: ['ok'] },
        { agent: harness.teammate, signal: new AbortController().signal },
      )
      const reviewTool = harness.tools.find((entry) => entry.agent === harness.lead.id && entry.name === 'team_flow_review_submit')
      await reviewTool.definition.execute(
        { item_id: 'W1', verdict: 'approve', summary: 'Approved', findings: [], evidence_checked: ['read src/a/1.js'] },
        { agent: harness.lead, signal: new AbortController().signal },
      )
      // Wait one tick for reviewTool's triggerOrchestrator to finish seeing worker2 as still running
      await new Promise((resolve) => setTimeout(resolve, 30))

      // Now worker2 finishes its previous turn and becomes idle -> agent/status idle must wake it for W2
      harness.messages.length = 0
      liveStatus.set('worker2', 'inactive')
      harness.ctx.emit('agent/status', { agent: worker2, status: 'idle' })

      await new Promise((resolve) => setTimeout(resolve, 350))
      const wake = harness.messages.find((m) => m.to === 'worker2' && m.text.includes('AUTO_DISPATCH'))
      assert.ok(wake, 'agent/status idle event must trigger immediate debounced dispatch for worker2')
      assert.match(wake.text, /W2/)
    } finally {
      for (const dispose of harness.effects) {
        if (typeof dispose === 'function') dispose()
      }
    }
  })
})

test('apply wires ctx.llm capability probing and agent/request thinking router cleanly until disposal', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    harness.ctx.llm = {
      async resolveModelInfo(_provider, model) {
        return { id: model, reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }
      },
    }
    apply(harness.ctx, { thinkingRouting: 'auto', watchdogIntervalSeconds: 0 })
    try {
      const planTool = harness.tools.find((entry) => entry.agent === harness.lead.id && entry.name === 'team_flow_plan')
      await planTool.definition.execute(
        {
          objective: 'Test live thinking wiring',
          acceptance_criteria: ['Done'],
          items: [
            {
              id: 'W1',
              subject: 'Complex core change',
              owner: 'worker',
              complexity: 'complex',
              write_scopes: ['src/'],
              definition_of_done: ['done'],
              reviewers: ['lead'],
            },
          ],
        },
        { agent: harness.lead, signal: new AbortController().signal },
      )

      assert.equal(harness.teammate.ctx.listenerCount('agent/request'), 1)
      const routed = await harness.teammate.ctx.runWaterfall(
        'agent/request',
        { turn: 1, step: 1, signal: new AbortController().signal },
        { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'low' },
      )
      assert.equal(routed.reasoningEffort, 'high', 'complex item must elevate worker thinking to high')

      harness.ctx.emit('agent/disposed', { agent: harness.teammate })
      assert.equal(harness.teammate.ctx.listenerCount('agent/request'), 0, 'disposal must unregister agent/request listener')
    } finally {
      for (const dispose of harness.effects) {
        if (typeof dispose === 'function') dispose()
      }
    }
  })
})

test('apply refreshes tools additively when an implementer takes a peer review duty', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    const worker2 = { id: 'session-worker2', session: { id: 'session-worker2' } }
    worker2.ctx = harness.scopedFor(worker2)
    harness.membership.set(worker2.id, { root: harness.lead, id: worker2.id, name: 'worker2', role: 'teammate' })

    apply(harness.ctx, { roleToolScoping: true, watchdogIntervalSeconds: 0, autoStaff: false })
    harness.ctx.emit('agent/created', { agent: worker2 })
    try {
      const planTool = harness.tools.find((entry) => entry.agent === harness.lead.id && entry.name === 'team_flow_plan')
      await planTool.definition.execute(
        {
          objective: 'Test additive duty tool refresh',
          acceptance_criteria: ['Done'],
          items: [
            {
              id: 'W1',
              subject: 'Open-review item',
              owner: 'worker',
              assignment: 'open',
              write_scopes: ['src/'],
              definition_of_done: ['done'],
              reviewers: [],
            },
          ],
        },
        { agent: harness.lead, signal: new AbortController().signal },
      )

      const worker2HasReviewBefore = () =>
        harness.tools.filter((entry) => entry.agent === worker2.id && entry.name === 'team_flow_review_submit')
      assert.equal(worker2HasReviewBefore().length, 0, 'worker2 starts without team_flow_review_submit')

      // worker claims and reports W1, then publishes open review invitation
      const workLeadOrImpl = harness.tools.find((entry) => entry.agent === harness.teammate.id && entry.name === 'team_flow_work')
      await workLeadOrImpl.definition.execute({ action: 'claim', item_id: 'W1' }, { agent: harness.teammate, signal: new AbortController().signal })
      const reportTool = harness.tools.find((entry) => entry.agent === harness.teammate.id && entry.name === 'team_flow_report')
      await reportTool.definition.execute(
        { item_id: 'W1', summary: 'Implemented', files: ['src/a.js'], commands: [{ command: 'node --test', exit_code: 0 }], evidence: ['ok'] },
        { agent: harness.teammate, signal: new AbortController().signal },
      )
      await workLeadOrImpl.definition.execute({ action: 'request_review', item_id: 'W1' }, { agent: harness.teammate, signal: new AbortController().signal })

      // worker2 takes the review -> team_flow_review_submit must be registered additively without duplicating existing tools
      const workTool2 = harness.tools.find((entry) => entry.agent === worker2.id && entry.name === 'team_flow_work')
      const beforeCount = harness.tools.filter((entry) => entry.agent === worker2.id).length
      await workTool2.definition.execute({ action: 'take_review', item_id: 'W1' }, { agent: worker2, signal: new AbortController().signal })

      assert.equal(worker2HasReviewBefore().length, 1, 'team_flow_review_submit must be installed additively once')
      const afterNames = harness.tools.filter((entry) => entry.agent === worker2.id).map((entry) => entry.name)
      assert.equal(new Set(afterNames).size, afterNames.length, 'must not register duplicate tools')
      assert.ok(afterNames.length > beforeCount)

      harness.ctx.emit('agent/disposed', { agent: worker2 })
      assert.equal(harness.tools.filter((entry) => entry.agent === worker2.id).length, 0, 'disposal must clean up extra tools too')
    } finally {
      for (const dispose of harness.effects) {
        if (typeof dispose === 'function') dispose()
      }
    }
  })
})

test('presetToolPruning slims worker/reviewer tool schemas under fast-fix while keeping core tools', () => {
  const settings = resolveSettings({ presetToolPruning: true })
  const allTools = buildTools({
    ctx: { agentTeams: {}, agents: {}, tools: {} },
    settings,
    store: {},
    version: '2.1.0',
    tokenUsage: () => null,
    orchestrator: {},
  })

  const workerNames = resolveAllowedToolNames({ role: 'implementer', settings, preset: 'fast-fix' })
  for (const core of [
    'team_flow_report',
    'team_flow_review_respond',
    'team_flow_git',
    'team_flow_talk',
    'team_flow_read',
    'team_flow_escalate',
    'team_flow_status',
  ]) {
    assert.equal(workerNames.has(core), true, `worker must retain ${core}`)
  }
  for (const pruned of ['team_flow_work', 'team_flow_item', 'team_flow_decide', 'team_dev_contract', 'team_dev_lookup']) {
    assert.equal(workerNames.has(pruned), false, `fast-fix worker should prune ${pruned}`)
  }

  const workerSchemas = filterToolsByRole(allTools, workerNames).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
  const workerBytes = Buffer.byteLength(JSON.stringify(workerSchemas), 'utf8')
  assert.ok(workerBytes <= 8500, `expected pruned worker schemas <= 8500 bytes, got ${workerBytes}`)

  const reviewerNames = resolveAllowedToolNames({ role: 'reviewer', settings, preset: 'fast-fix' })
  assert.equal(reviewerNames.has('team_flow_review_submit'), true)
  assert.equal(reviewerNames.has('team_flow_decide'), false)
  assert.equal(reviewerNames.has('team_dev_contract'), false)
})

test('presetToolPruning dynamically restores tools when open queue, open proposal, or contracts are active', () => {
  const settings = resolveSettings({ presetToolPruning: true })
  const state = {
    preset: 'fast-fix',
    items: [
      { id: 'W1', assignment: 'open', handoffPacket: { contract_id: 'c-auth' } },
    ],
    proposals: [{ id: 'P1', status: 'open' }],
  }
  const allowed = resolveAllowedToolNames({ role: 'implementer', settings, state })
  assert.equal(allowed.has('team_flow_work'), true)
  assert.equal(allowed.has('team_flow_item'), true)
  assert.equal(allowed.has('team_flow_decide'), true)
  assert.equal(allowed.has('team_dev_contract'), true)
  assert.equal(allowed.has('team_dev_lookup'), true)

  const strictSettings = resolveSettings({ presetToolPruning: true, strictContracts: true })
  const strictAllowed = resolveAllowedToolNames({ role: 'reviewer', settings: strictSettings, preset: 'fast-fix' })
  assert.equal(strictAllowed.has('team_dev_contract'), true)
  assert.equal(strictAllowed.has('team_dev_lookup'), true)
})

test('presetToolPruning=false restores full role tool set even under fast-fix', () => {
  const settings = resolveSettings({ presetToolPruning: false })
  const allowed = resolveAllowedToolNames({ role: 'implementer', settings, preset: 'fast-fix' })
  for (const name of ['team_flow_work', 'team_flow_item', 'team_flow_decide', 'team_dev_contract', 'team_dev_lookup']) {
    assert.equal(allowed.has(name), true, `expected ${name} when presetToolPruning is false`)
  }
})
