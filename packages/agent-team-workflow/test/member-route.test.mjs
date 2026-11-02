/**
 * Tests for the member view route (docs/19 §5).
 *
 * The route is exercised through its real handler with a Connection double and
 * an in-memory Team double, so status codes, payload shape and message
 * delivery are covered without a browser.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { MEMBER_PATH, registerMemberRoute } from '../lib/member-route.js'
import { createStore } from '../lib/store.js'
import * as W from '../lib/workflow.js'

const SETTINGS = resolveSettings({ roles: { 'fast-reviewer': { provider: 'review-fast', prompt: 'Focus on auth.' } } })
const NOW = '2026-11-02T00:00:00.000Z'

function createHarness(cwd) {
  const lead = { id: 'session-lead', session: { id: 'session-lead' } }
  const impl = { id: 'session-impl', session: { id: 'session-impl' } }
  const members = [
    { name: 'lead', role: 'lead', id: lead.id, status: 'running', context: undefined },
    { name: 'impl', role: 'implementer', id: impl.id, status: 'inactive', context: 'fresh' },
  ]
  const delivered = []
  const ctx = {
    logger: { info() {}, warn() {} },
    agents: { get: (id) => (id === lead.id ? lead : id === impl.id ? impl : undefined) },
    workingDirectory: { get: () => cwd, defaultDirectory: cwd },
    agentTeams: {
      tryMembership: (agent) => (agent.id === lead.id ? { root: lead, id: lead.id, name: 'lead', role: 'lead' } : undefined),
      listMembers: () => members,
      async sendMessage(caller, request) {
        delivered.push({ from: caller.id, target: request.target, text: request.content?.[0]?.text ?? '' })
        return { messageId: `msg-${delivered.length}` }
      },
    },
  }
  return { ctx, lead, impl, members, delivered }
}

function createConnectionDouble() {
  const registered = []
  return {
    registered,
    fetch: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
  }
}

async function withWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'atw-member-'))
  try {
    return await fn(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function seedRun(harness, store) {
  const state = W.createRun({
    workflowVersion: W.WORKFLOW_VERSION,
    runId: 'run-member-1',
    teamId: 'session-lead',
    objective: 'Ship it',
    acceptanceCriteria: ['works'],
    constraints: [],
    settings: SETTINGS,
    items: [{
      id: 'W1', subject: 'Implement', owner: 'impl', role: 'implementer', writeScopes: ['src/'], blockedBy: [],
      definitionOfDone: ['works'], needsReview: true, reviewers: ['rev'], evidenceOptional: false,
      status: W.ITEM_STATUS.PENDING, taskId: 'task-1', report: null, reportSeq: 0, reviews: [], reviewSeq: 0,
      overrideReason: null, repairLog: [], createdAt: NOW, updatedAt: NOW,
    }],
    actor: 'lead',
    now: NOW,
  })
  state.roleAssignments = { impl: 'fast-reviewer' }
  state.stops.push({ id: 'stop1', at: NOW, by: 'lead', target: 'impl', mode: 'graceful', status: 'pending', reason: 'wind down', decidedAt: null, decisionReason: null })
  state.events.push({ at: NOW, type: 'report/submitted', actor: 'impl', detail: 'W1' })
  state.channel.push({ id: 'm1', at: NOW, from: 'impl', to: 'rev', kind: 'answer', text: 'the contract is X', itemId: 'W1', replyTo: null })
  await store.writeState(harness.lead, state)
}

test('the member route registers one GET/POST path', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const connection = createConnectionDouble()
    registerMemberRoute({ connection, ctx: harness.ctx, store: createStore({ ctx: harness.ctx, settings: SETTINGS }), settings: SETTINGS })
    assert.equal(connection.registered.length, 1)
    assert.equal(connection.registered[0].path, MEMBER_PATH)
    assert.deepEqual(connection.registered[0].methods, ['GET', 'POST'])
  })
})

test('GET returns the workflow-side member view', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: SETTINGS })
    await seedRun(harness, store)
    const connection = createConnectionDouble()
    registerMemberRoute({ connection, ctx: harness.ctx, store, settings: SETTINGS })
    const response = await connection.registered[0].fetch(new Request(`http://x${MEMBER_PATH}?session=session-lead&name=impl`))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.member.name, 'impl')
    assert.equal(payload.member.status, 'inactive')
    assert.equal(payload.member.currentItems[0].id, 'W1')
    assert.equal(payload.member.recentActivity[0].type, 'report/submitted')
    assert.equal(payload.member.channel[0].text, 'the contract is X')
    assert.equal(payload.member.stop.status, 'pending')
    assert.deepEqual(payload.member.roleDefinition, { role: 'fast-reviewer', provider: 'review-fast', prompt: 'Focus on auth.' })
  })
})

test('POST delivers a message to the teammate', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: SETTINGS })
    await seedRun(harness, store)
    const connection = createConnectionDouble()
    registerMemberRoute({ connection, ctx: harness.ctx, store, settings: SETTINGS })
    const response = await connection.registered[0].fetch(new Request(`http://x${MEMBER_PATH}?session=session-lead`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'impl', message: 'please re-check the contract' }),
    }))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.delivered, true)
    assert.deepEqual(harness.delivered, [{ from: 'session-lead', target: 'impl', text: 'please re-check the contract' }])
  })
})

test('the member route validates its inputs', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: SETTINGS })
    await seedRun(harness, store)
    const connection = createConnectionDouble()
    registerMemberRoute({ connection, ctx: harness.ctx, store, settings: SETTINGS })
    const fetchRoute = connection.registered[0].fetch
    const missingSession = await fetchRoute(new Request(`http://x${MEMBER_PATH}?name=impl`))
    assert.equal(missingSession.status, 400)
    const unknownMember = await fetchRoute(new Request(`http://x${MEMBER_PATH}?session=session-lead&name=nobody`))
    assert.equal(unknownMember.status, 404)
    const emptyMessage = await fetchRoute(new Request(`http://x${MEMBER_PATH}?session=session-lead`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'impl', message: '   ' }),
    }))
    assert.equal(emptyMessage.status, 400)
    const badJson = await fetchRoute(new Request(`http://x${MEMBER_PATH}?session=session-lead`, { method: 'POST', body: 'not-json' }))
    assert.equal(badJson.status, 400)
  })
})

test('GET includes the teammate transcript when the Host exposes the session log', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: SETTINGS })
    await seedRun(harness, store)
    const connection = createConnectionDouble()
    const transcript = async (sessionId) => {
      assert.equal(sessionId, 'session-impl')
      return { messages: [{ seq: 2, role: 'user', text: 'please verify' }], truncated: false, totalEvents: 3 }
    }
    registerMemberRoute({ connection, ctx: harness.ctx, store, settings: SETTINGS, transcript })
    const response = await connection.registered[0].fetch(new Request(`http://x${MEMBER_PATH}?session=session-lead&name=impl`))
    const payload = await response.json()
    assert.equal(payload.member.transcript.available, true)
    assert.equal(payload.member.transcript.messages[0].text, 'please verify')
  })
})

test('GET keeps the workflow view when the transcript cannot be read', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: SETTINGS })
    await seedRun(harness, store)
    const connection = createConnectionDouble()
    const transcript = async () => {
      throw new Error('session log unavailable')
    }
    registerMemberRoute({ connection, ctx: harness.ctx, store, settings: SETTINGS, transcript })
    const response = await connection.registered[0].fetch(new Request(`http://x${MEMBER_PATH}?session=session-lead&name=impl`))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.member.transcript.available, false)
    assert.match(payload.member.transcript.error, /session log unavailable/)
  })
})
