/**
 * Tests for the authenticated live-board snapshot route.
 *
 * The route is exercised through its real handler with a Connection double and
 * an in-memory Agent Teams double writing to a real temporary board, so every
 * status code and payload branch is covered without a browser.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { registerDashboardRoute, SNAPSHOT_PATH } from '../lib/dashboard-route.js'
import { createStore } from '../lib/store.js'
import * as W from '../lib/workflow.js'

const SETTINGS = resolveSettings({})
const NOW = '2026-11-01T00:00:00.000Z'

/** Minimal live-runtime double for one Lead plus one teammate. */
function createHarness(cwd) {
  const lead = { id: 'session-lead', session: { id: 'session-lead' } }
  const worker = { id: 'session-worker', session: { id: 'session-worker' } }
  const members = [
    { name: 'lead', role: 'lead', status: 'running', context: undefined },
    { name: 'impl', role: 'teammate', status: 'inactive', context: 'fresh' },
  ]
  const tasks = [{ id: 'task-2', revision: 3, status: 'in_progress', subject: 'Implement', ownerName: 'impl' }]
  const ctx = {
    logger: { info() {}, warn() {} },
    agents: { get: (id) => (id === lead.id ? lead : id === worker.id ? worker : undefined) },
    workingDirectory: { get: () => cwd, defaultDirectory: cwd },
    agentTeams: {
      tryMembership: (agent) => (agent.id === lead.id ? { root: lead, id: lead.id, name: 'lead', role: 'lead' } : undefined),
      listMembers: () => members,
      listTasks: () => tasks,
    },
  }
  return { ctx, lead, members, tasks }
}

/** Connection double capturing the one registered route. */
function createConnectionDouble() {
  const registered = []
  return {
    registered,
    fetch: {
      register(route) {
        registered.push(route)
        return () => {
          const index = registered.indexOf(route)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
  }
}

async function withWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'atw-route-'))
  try {
    return await fn(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

/** Seed one planned run so the snapshot has real content. */
async function seedRun(harness, store) {
  const state = W.createRun({
    workflowVersion: W.WORKFLOW_VERSION,
    runId: 'run-route-1',
    teamId: 'session-lead',
    objective: 'Ship a verified module',
    acceptanceCriteria: ['works'],
    constraints: [],
    settings: {
      maxReviewRounds: 2,
      maxParallelItems: 4,
      workerContext: 'fresh',
      strictScopes: false,
      allowScopeOverlap: false,
      requireReviewEvidence: true,
    },
    items: [
      {
        id: 'W1',
        subject: 'Implement',
        owner: 'impl',
        role: 'implementer',
        writeScopes: ['src/'],
        blockedBy: [],
        definitionOfDone: ['works'],
        needsReview: true,
        reviewers: ['rev'],
        evidenceOptional: false,
        status: W.ITEM_STATUS.PENDING,
        taskId: 'task-2',
        report: null,
        reportSeq: 0,
        reviews: [],
        reviewSeq: 0,
        overrideReason: null,
        repairLog: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    actor: 'lead',
    now: NOW,
  })
  await store.writeState(harness.lead, state)
}

test('the route registers one GET-only exact Fetch route under /api', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const connection = createConnectionDouble()
    const disposer = registerDashboardRoute({ connection, ctx: harness.ctx, store: createStore({ ctx: harness.ctx, settings: SETTINGS }), settings: SETTINGS })
    assert.equal(connection.registered.length, 1)
    assert.equal(connection.registered[0].path, SNAPSHOT_PATH)
    assert.match(SNAPSHOT_PATH, /^\/api\//)
    assert.deepEqual(connection.registered[0].methods, ['GET'])
    assert.equal(typeof connection.registered[0].fetch, 'function')
    disposer()
    assert.equal(connection.registered.length, 0)
  })
})

test('returns the live snapshot for a member session', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: SETTINGS })
    await seedRun(harness, store)
    const connection = createConnectionDouble()
    registerDashboardRoute({ connection, ctx: harness.ctx, store, settings: SETTINGS })
    const response = await connection.registered[0].fetch(new Request(`http://localhost${SNAPSHOT_PATH}?session=session-lead`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.version, 1)
    assert.equal(payload.sessionId, 'session-lead')
    assert.equal(payload.run.id, 'run-route-1')
    assert.equal(payload.run.items.length, 1)
    assert.equal(payload.team.me.name, 'lead')
    assert.equal(payload.team.members.length, 2)
    assert.equal(payload.team.tasks[0].revision, 3)
    assert.equal(payload.diagnostics.boardSource, 'file')
  })
})

test('rejects malformed, unknown, and non-GET requests with the documented status codes', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: SETTINGS })
    const connection = createConnectionDouble()
    registerDashboardRoute({ connection, ctx: harness.ctx, store, settings: SETTINGS })
    const route = connection.registered[0]

    const missing = await route.fetch(new Request(`http://localhost${SNAPSHOT_PATH}`))
    assert.equal(missing.status, 400)
    assert.match((await missing.json()).error, /session/)

    const invalid = await route.fetch(new Request(`http://localhost${SNAPSHOT_PATH}?session=../../etc`))
    assert.equal(invalid.status, 400)

    const unknown = await route.fetch(new Request(`http://localhost${SNAPSHOT_PATH}?session=session-missing`))
    assert.equal(unknown.status, 404)

    const post = await route.fetch(new Request(`http://localhost${SNAPSHOT_PATH}?session=session-lead`, { method: 'POST' }))
    assert.equal(post.status, 405)
  })
})

test('a session without a workflow board still returns the live roster', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: SETTINGS })
    const connection = createConnectionDouble()
    registerDashboardRoute({ connection, ctx: harness.ctx, store, settings: SETTINGS })
    const response = await connection.registered[0].fetch(new Request(`http://localhost${SNAPSHOT_PATH}?session=session-lead`))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.run, null)
    assert.equal(payload.diagnostics.boardSource, 'missing')
    assert.equal(payload.team.members.length, 2)
  })
})

test('a non-Team session returns a null run instead of failing', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: SETTINGS })
    const connection = createConnectionDouble()
    registerDashboardRoute({ connection, ctx: harness.ctx, store, settings: SETTINGS })
    const response = await connection.registered[0].fetch(new Request(`http://localhost${SNAPSHOT_PATH}?session=session-worker`))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.run, null)
    assert.equal(payload.team.me, null)
    assert.deepEqual(payload.team.members, [])
  })
})

test('a corrupt board degrades to a warning instead of a 500', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: SETTINGS })
    const statePath = store.statePath(harness.lead)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(statePath, '..'), { recursive: true })
    await writeFile(statePath, '{not json', 'utf8')
    const connection = createConnectionDouble()
    registerDashboardRoute({ connection, ctx: harness.ctx, store, settings: SETTINGS })
    const response = await connection.registered[0].fetch(new Request(`http://localhost${SNAPSHOT_PATH}?session=session-lead`))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.run, null)
    assert.ok(payload.diagnostics.warnings.some((warning) => /unreadable/.test(warning)), payload.diagnostics.warnings.join('; '))
  })
})
