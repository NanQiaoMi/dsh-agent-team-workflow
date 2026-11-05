/**
 * Unit & integration tests for the Team Orchestrator.
 *
 * Verifies that the autonomous coordinator wakes inactive workers when tasks
 * become unblocked, wakes inactive reviewers when reports arrive, throttles
 * redundant notifications, and signals convergence to the Lead.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { buildTools } from '../lib/tools.js'

function createHarness(cwd) {
  const lead = { id: 'session-lead', session: { id: 'session-lead' } }
  const members = [{ name: 'lead', role: 'lead', id: lead.id, status: 'running' }]
  const messages = []
  const tasks = []
  let taskNumber = 0

  const agentTeams = {
    tryMembership(agent) {
      const member = members.find((candidate) => candidate.id === agent.id)
      if (!member) return undefined
      return { root: lead, id: agent.id, name: member.name, role: member.role }
    },
    membership(agent) {
      const res = agentTeams.tryMembership(agent)
      if (!res) throw new Error('not a team member')
      return res
    },
    listMembers() {
      return members.map((m) => ({ ...m, diagnostics: [] }))
    },
    async sendMessage(caller, request) {
      messages.push({
        from: caller.id,
        target: request.target,
        text: request.content[0]?.text ?? '',
      })
      return { messageId: `msg-${messages.length}` }
    },
    async createTask(caller, request) {
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
      return { ...task, ready: true, writeScopeWarnings: [] }
    },
    getTask(caller, id) {
      const t = tasks.find((cand) => cand.id === id)
      if (!t) throw new Error(`task ${id} not found`)
      return { ...t, ready: true, writeScopeWarnings: [] }
    },
    async updateTask(caller, request) {
      const t = tasks.find((cand) => cand.id === request.taskId)
      if (!t) throw new Error(`task ${request.taskId} not found`)
      t.revision = request.expectedRevision + 1
      if (request.action === 'claim') t.status = 'in_progress'
      if (request.action === 'complete') t.status = 'completed'
      return { ...t, ready: true, writeScopeWarnings: [] }
    },
  }

  const ctx = {
    agentTeams,
    agents: {
      list: () => [lead],
    },
    workingDirectory: {
      get: () => cwd,
    },
    logger: {
      warn: () => {},
      debug: () => {},
    },
  }

  return { ctx, lead, members, messages, tasks }
}

async function withWorkspace(run) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-test-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('orchestrator is a no-op when autoOrchestrate is disabled', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const settings = resolveSettings({ autoOrchestrate: false })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })

    const res = await orchestrator.reconcile(harness.lead)
    assert.deepEqual(res.actionsTaken, [])
    assert.equal(res.converged, false)
    assert.equal(orchestrator.isWatchdogRunning(), false)
  })
})

test('orchestrator wakes inactive assigned workers for unblocked tasks', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    // Add inactive worker-1 and worker-2
    harness.members.push(
      { name: 'worker-1', role: 'teammate', id: 'session-w1', status: 'inactive' },
      { name: 'worker-2', role: 'teammate', id: 'session-w2', status: 'inactive' },
      { name: 'rev-1', role: 'teammate', id: 'session-rev', status: 'inactive' },
    )

    const settings = resolveSettings({ autoOrchestrate: true })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test', orchestrator })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    await planTool.execute(
      {
        objective: 'Test plan',
        acceptance_criteria: ['Done'],
        items: [
          {
            id: 'W1',
            subject: 'First task',
            owner: 'worker-1',
            reviewers: ['rev-1'],
            write_scopes: ['src/a/'],
            definition_of_done: ['Do W1'],
          },
          {
            id: 'W2',
            subject: 'Second task (blocked by W1)',
            owner: 'worker-2',
            reviewers: ['rev-1'],
            blocked_by: ['W1'],
            write_scopes: ['src/b/'],
            definition_of_done: ['Do W2'],
          },
        ],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )

    // Reconcile
    const res = await orchestrator.reconcile(harness.lead, { force: true })

    // Worker 1 should be woken, but Worker 2 should NOT be woken because W1 is not approved
    assert.equal(res.actionsTaken.length, 1)
    assert.equal(res.actionsTaken[0].type, 'wake-worker')
    assert.equal(res.actionsTaken[0].target, 'worker-1')
    assert.equal(res.actionsTaken[0].itemId, 'W1')

    const dispatchMsg = harness.messages.find((m) => m.target === 'worker-1' && m.text.includes('AUTO_DISPATCH'))
    assert.ok(dispatchMsg)
    assert.match(dispatchMsg.text, /AUTO_DISPATCH.*W1/)
    assert.match(dispatchMsg.text, /automatically claimed for you/)
    assert.equal(harness.tasks.find((t) => t.id === 'task-1')?.status, 'in_progress', 'backing task must be claimed automatically on wakeup')
  })
})

test('orchestrator wakes reviewer when worker reports and detects convergence', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const worker1 = { id: 'session-w1', session: { id: 'session-w1' } }
    const rev1 = { id: 'session-rev', session: { id: 'session-rev' } }
    harness.members.push(
      { name: 'worker-1', role: 'teammate', id: worker1.id, status: 'inactive' },
      { name: 'rev-1', role: 'teammate', id: rev1.id, status: 'inactive' },
    )

    const settings = resolveSettings({ autoOrchestrate: true })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test', orchestrator })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')

    await planTool.execute(
      {
        objective: 'Test plan',
        acceptance_criteria: ['Done'],
        items: [
          {
            id: 'W1',
            subject: 'Single task',
            owner: 'worker-1',
            reviewers: ['rev-1'],
            write_scopes: ['src/'],
            definition_of_done: ['Do W1'],
          },
        ],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )

    // Worker reports
    await reportTool.execute(
      {
        item_id: 'W1',
        summary: 'Completed W1',
        files_modified: ['src/index.js'],
        commands_run: [{ command: 'npm test', exit_code: 0 }],
        evidence: ['All tests pass'],
      },
      { agent: worker1, signal: new AbortController().signal },
    )

    // Reconcile: should wake rev-1
    const resReview = await orchestrator.reconcile(harness.lead, { force: true })
    assert.ok(resReview.actionsTaken.some((a) => a.type === 'wake-reviewer' && a.target === 'rev-1'))

    // Reviewer approves — this automatically triggers orchestrator reconciliation inside reviewTool
    await reviewTool.execute(
      {
        item_id: 'W1',
        round: 1,
        verdict: 'approve',
        evidence_checked: ['Verified tests pass'],
      },
      { agent: rev1, signal: new AbortController().signal },
    )

    // Reconcile: should reflect convergence state
    const resConverge = await orchestrator.reconcile(harness.lead, { force: true })
    assert.equal(resConverge.converged, true)

    // Lead notification was automatically sent
    const leadMsg = harness.messages.find((m) => m.target === 'lead' && m.text.includes('TEAM_CONVERGED'))
    assert.ok(leadMsg)
  })
})

test('orchestrator watchdog starts and stops cleanly', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const settings = resolveSettings({ autoOrchestrate: true, watchdogIntervalSeconds: 60 })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })

    assert.equal(orchestrator.isWatchdogRunning(), false)
    orchestrator.startWatchdog()
    assert.equal(orchestrator.isWatchdogRunning(), true)
    // Starting again is idempotent
    orchestrator.startWatchdog()
    assert.equal(orchestrator.isWatchdogRunning(), true)
    orchestrator.stopWatchdog()
    assert.equal(orchestrator.isWatchdogRunning(), false)
  })
})
