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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { resolveSettings } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import * as W from '../lib/workflow.js'

const EXPECTED_TOOLS = [
  'team_flow_escalate',
  'team_flow_gate',
  'team_flow_plan',
  'team_flow_repair',
  'team_flow_report',
  'team_flow_review_respond',
  'team_flow_review_submit',
  'team_flow_status',
]

/** A minimal Cordis-shaped context with per-Agent scoped services. */
function createContext(cwd) {
  const tools = []
  const routes = []
  const sections = []
  const contexts = []
  const handlers = new Map()
  const effects = []
  const membership = new Map()
  const lead = { id: 'session-lead', session: { id: 'session-lead' }, ctx: undefined }
  const teammate = { id: 'session-worker', session: { id: 'session-worker' }, ctx: undefined }
  const outsider = { id: 'session-subagent', session: { id: 'session-subagent' }, ctx: undefined }

  const scopedFor = (agent) => ({
    tools: {
      register(definition) {
        tools.push({ agent: agent.id, name: definition.name, definition })
        return () => {
          const index = tools.findIndex((entry) => entry.agent === agent.id && entry.name === definition.name)
          if (index >= 0) tools.splice(index, 1)
        }
      },
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
  })

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
  return { ctx, lead, teammate, outsider, tools, sections, contexts, handlers, membership, scopedFor, tasks, messages, routes }
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
    assert.equal(harness.tools.filter((entry) => entry.agent === harness.teammate.id).length, 8)
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

    assert.equal(harness.routes.length, 1, 'the live board route is registered once')
    assert.equal(harness.routes[0].path, '/api/agent-team-workflow.snapshot')
    assert.deepEqual(harness.routes[0].methods, ['GET'])
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
    assert.equal(harness.tools.filter((entry) => entry.agent === late.id).length, 8)
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
    assert.match(text, /phase planned/)
    assert.match(text, /team_flow_status/)
    assert.equal(harness.tasks.length, 1, 'planning creates one backing Team task')
  })
})

test('injectPolicy=false installs tools without prompt inputs', () => {
  return withWorkspace(async (cwd) => {
    const harness = createContext(cwd)
    apply(harness.ctx, { injectPolicy: false })
    assert.equal(harness.tools.filter((entry) => entry.agent === harness.lead.id).length, 8)
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
