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
  const spawns = []
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
    async spawnTeammate(caller, request) {
      const id = `session-${request.name}`
      const member = {
        id,
        name: request.name,
        role: 'teammate',
        status: 'inactive',
        context: request.context,
        provider: request.provider,
        description: request.description,
      }
      members.push(member)
      spawns.push({ name: request.name, prompt: request.prompt[0]?.text ?? '', context: request.context, provider: request.provider })
      return { member: { ...member, diagnostics: [] } }
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

  return { ctx, lead, members, messages, tasks, spawns }
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

test('orchestrator wakes worker with structured findings when changes are requested', () => {
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
        objective: 'Rework test',
        acceptance_criteria: ['Done'],
        items: [
          {
            id: 'W1',
            subject: 'Rework task',
            owner: 'worker-1',
            reviewers: ['rev-1'],
            write_scopes: ['src/'],
            definition_of_done: ['Do W1'],
          },
        ],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )

    await reportTool.execute(
      {
        item_id: 'W1',
        summary: 'First draft',
        files: ['src/index.js'],
        commands: [{ command: 'npm test', exit_code: 0 }],
        evidence: ['tests passed'],
      },
      { agent: worker1, signal: new AbortController().signal },
    )

    // Reviewer requests changes with specific findings
    await reviewTool.execute(
      {
        item_id: 'W1',
        verdict: 'request_changes',
        summary: 'Please fix bugs',
        findings: [
          { id: 'F1', file: 'src/index.js', line: 42, severity: 'major', claim: 'Unhandled edge case in parsing' },
        ],
      },
      { agent: rev1, signal: new AbortController().signal },
    )

    // Clear previous messages to verify orchestrator's wake-up message
    harness.messages.length = 0

    // Reconcile: should wake worker-1 with rework details
    const res = await orchestrator.reconcile(harness.lead, { force: true })
    assert.ok(res.actionsTaken.some((a) => a.type === 'wake-worker' && a.target === 'worker-1' && a.isRework === true))

    const reworkMsg = harness.messages.find((m) => m.target === 'worker-1' && m.text.includes('requires rework'))
    assert.ok(reworkMsg, 'worker must receive rework dispatch message')
    assert.match(reworkMsg.text, /requires rework based on reviewer findings/)
    assert.match(reworkMsg.text, /\[F1\]/)
    assert.match(reworkMsg.text, /Unhandled edge case in parsing/)
    assert.match(reworkMsg.text, /team_flow_review_respond/)
  })
})

test('orchestrator auto-finalizes the run when autoFinalize is enabled and gates pass', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const worker1 = { id: 'session-w1', session: { id: 'session-w1' } }
    const rev1 = { id: 'session-rev', session: { id: 'session-rev' } }
    harness.members.push(
      { name: 'worker-1', role: 'teammate', id: worker1.id, status: 'running' },
      { name: 'rev-1', role: 'teammate', id: rev1.id, status: 'running' },
    )

    const settings = resolveSettings({ autoOrchestrate: true, autoFinalize: true })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test', orchestrator })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')

    await planTool.execute(
      {
        objective: 'Auto finalize test',
        acceptance_criteria: ['Fully automated'],
        items: [
          {
            id: 'W1',
            subject: 'Self closing task',
            owner: 'worker-1',
            reviewers: ['rev-1'],
            write_scopes: ['src/'],
            definition_of_done: ['Finished'],
          },
        ],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )

    await reportTool.execute(
      {
        item_id: 'W1',
        summary: 'Completed cleanly',
        files: ['src/index.js'],
        commands: [{ command: 'npm test', exit_code: 0 }],
        evidence: ['All green'],
      },
      { agent: worker1, signal: new AbortController().signal },
    )

    await reviewTool.execute(
      {
        item_id: 'W1',
        verdict: 'approve',
        summary: 'Approved with verified evidence',
        evidence_checked: ['verified tests exit 0'],
      },
      { agent: rev1, signal: new AbortController().signal },
    )

    // Reconcile with autoFinalize: should automatically evaluate gate and finalize
    const res = await orchestrator.reconcile(harness.lead, { force: true })
    assert.equal(res.converged, true)
    assert.equal(res.finalized, true)
    assert.ok(res.actionsTaken.some((a) => a.type === 'auto-finalize'))

    const state = await store.readState(harness.lead)
    assert.equal(state.phase, 'finalized')
    assert.ok(state.artifacts?.reportPath, 'reportPath must be populated')

    const finalizeNotice = harness.messages.find((m) => m.target === 'lead' && m.text.includes('TEAM_FINALIZED'))
    assert.ok(finalizeNotice, 'lead must receive TEAM_FINALIZED notice')
    assert.match(finalizeNotice.text, /automatically finalized/)
  })
})

test('orchestrator wakes Lead for arbitration when an item is ESCALATED', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    harness.members.push(
      { name: 'worker-1', role: 'teammate', id: 'session-w1', status: 'inactive' },
      { name: 'rev-1', role: 'teammate', id: 'session-rev', status: 'inactive' },
    )
    const settings = resolveSettings({ autoOrchestrate: true })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: '1.23.0' })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    await planTool.execute(
      {
        objective: 'Test escalation arbitration',
        acceptance_criteria: ['Lead notified on escalation'],
        items: [
          {
            id: 'W1',
            subject: 'Escalated task',
            owner: 'worker-1',
            reviewers: ['rev-1'],
            definition_of_done: ['Arbitrated'],
          },
        ],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )

    // Escalate item W1
    await store.mutateState(harness.lead, (s) => {
      const item = s.items.find((it) => it.id === 'W1')
      item.status = 'escalated'
      item.escalation = { reason: 'Exceeded rework budget', at: new Date().toISOString() }
      return s
    })

    const res = await orchestrator.reconcile(harness.lead, { force: true })
    assert.ok(res.actionsTaken.some((a) => a.type === 'wake-arbitration' && a.itemId === 'W1'))
    const leadNotice = harness.messages.find((m) => m.target === 'lead' && m.text.includes('LEAD_ARBITRATION_REQUIRED'))
    assert.ok(leadNotice, 'Lead must receive LEAD_ARBITRATION_REQUIRED notice')
    assert.match(leadNotice.text, /Exceeded rework budget/)
  })
})

test('orchestrator alerts Lead and Worker on worktree merge conflict', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    harness.members.push(
      { name: 'worker-1', role: 'teammate', id: 'session-w1', status: 'inactive' },
      { name: 'rev-1', role: 'teammate', id: 'session-rev', status: 'inactive' },
    )
    const settings = resolveSettings({ autoOrchestrate: true })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: '1.23.0' })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    await planTool.execute(
      {
        objective: 'Test conflict alert',
        acceptance_criteria: ['Alert on conflict'],
        items: [
          {
            id: 'W1',
            subject: 'Conflicted task',
            owner: 'worker-1',
            reviewers: ['rev-1'],
            definition_of_done: ['Resolved'],
          },
        ],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )

    // Mark item W1 approved but with worktreeMergeError
    await store.mutateState(harness.lead, (s) => {
      const item = s.items.find((it) => it.id === 'W1')
      item.status = 'approved'
      item.git = {
        worktreeBranch: 'agentteam-wt/run/W1',
        worktreeMergeError: 'merge of branch into run branch has conflicts',
      }
      return s
    })

    const res = await orchestrator.reconcile(harness.lead, { force: true })
    assert.ok(res.actionsTaken.some((a) => a.type === 'notify-worktree-conflict' && a.itemId === 'W1'))
    const conflictNotice = harness.messages.find((m) => m.text.includes('merge conflict during auto-merge'))
    assert.ok(conflictNotice, 'notice must mention merge conflict')
    assert.match(conflictNotice.text, /worktree_sync/)
  })
})

test('zero duplicate wakes across report, request_changes, and review_respond', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const worker1 = { id: 'session-w1', session: { id: 'session-w1' } }
    const rev1 = { id: 'session-rev', session: { id: 'session-rev' } }
    harness.members.push(
      { name: 'worker-1', role: 'teammate', id: worker1.id, status: 'inactive' },
      { name: 'rev-1', role: 'teammate', id: rev1.id, status: 'inactive' },
    )

    const settings = resolveSettings({ autoOrchestrate: true, autoStaff: false })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test', orchestrator })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const submitTool = tools.find((t) => t.name === 'team_flow_review_submit')
    const respondTool = tools.find((t) => t.name === 'team_flow_review_respond')

    await planTool.execute(
      {
        objective: 'Dedupe wake test',
        acceptance_criteria: ['No duplicate notifications'],
        items: [{ id: 'W1', subject: 'Feature', owner: 'worker-1', reviewers: ['rev-1'], write_scopes: ['src/'], definition_of_done: ['Done'] }],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )

    // 1. Report notifies rev-1; subsequent non-force reconcile must NOT resend
    harness.messages.length = 0
    await reportTool.execute(
      { item_id: 'W1', summary: 'Implemented', files: ['src/a.js'], commands: [{ command: 'npm test', exit_code: 0 }], evidence: ['ok'] },
      { agent: worker1, signal: new AbortController().signal },
    )
    await orchestrator.whenIdle()
    await orchestrator.reconcile(harness.lead)
    await orchestrator.whenIdle()
    const revMsgsAfterReport = harness.messages.filter((m) => m.target === 'rev-1')
    assert.equal(revMsgsAfterReport.length, 1, 'rev-1 must receive exactly 1 notice after report')

    // 2. request_changes notifies worker-1; subsequent non-force reconcile must NOT resend
    harness.messages.length = 0
    await submitTool.execute(
      {
        item_id: 'W1',
        verdict: 'request_changes',
        summary: 'Fix edge case',
        findings: [{ id: 'F1', severity: 'major', file: 'src/a.js', line: 10, claim: 'Null input crashes' }],
        evidence_checked: ['read src/a.js'],
      },
      { agent: rev1, signal: new AbortController().signal },
    )
    await orchestrator.whenIdle()
    await orchestrator.reconcile(harness.lead)
    await orchestrator.whenIdle()
    const workerMsgsAfterSubmit = harness.messages.filter((m) => m.target === 'worker-1')
    assert.equal(workerMsgsAfterSubmit.length, 1, 'worker-1 must receive exactly 1 notice after request_changes')

    // 3. review_respond notifies rev-1 with reReviewRequestMessage; non-force reconcile must NOT resend
    harness.messages.length = 0
    await respondTool.execute(
      {
        item_id: 'W1',
        responses: [{ finding_id: 'F1', state: 'fixed', evidence: 'added null guard; unit tests pass' }],
      },
      { agent: worker1, signal: new AbortController().signal },
    )
    await orchestrator.whenIdle()
    await orchestrator.reconcile(harness.lead)
    await orchestrator.whenIdle()
    const revMsgsAfterRespond = harness.messages.filter((m) => m.target === 'rev-1')
    assert.equal(revMsgsAfterRespond.length, 1, 'rev-1 must receive exactly 1 re-review notice after review_respond')
    assert.match(revMsgsAfterRespond[0].text, /re-review ready/)
    assert.match(revMsgsAfterRespond[0].text, /F1 \[major\] src\/a\.js:10 -> fixed/)
    assert.match(revMsgsAfterRespond[0].text, /added null guard; unit tests pass/)
    assert.match(revMsgsAfterRespond[0].text, /Focus on verifying each finding response above/)
  })
})

test('orchestrator batches multiple assignments for one inactive member into a single digest message', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    harness.members.push(
      { name: 'worker-1', role: 'teammate', id: 'session-w1', status: 'inactive' },
      { name: 'rev-1', role: 'teammate', id: 'session-rev', status: 'inactive' },
    )
    const settings = resolveSettings({ autoOrchestrate: true, autoStaff: false })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })

    await tools.find((t) => t.name === 'team_flow_plan').execute(
      {
        objective: 'Batch digest test',
        acceptance_criteria: ['One message per member'],
        items: [
          { id: 'W1', subject: 'First module', owner: 'worker-1', reviewers: ['rev-1'], write_scopes: ['src/a/'], definition_of_done: ['Do W1'] },
          { id: 'W2', subject: 'Second module', owner: 'worker-1', reviewers: ['rev-1'], write_scopes: ['src/b/'], definition_of_done: ['Do W2'] },
        ],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )

    harness.messages.length = 0
    const res = await orchestrator.reconcile(harness.lead, { force: true })
    assert.equal(res.actionsTaken.filter((a) => a.type === 'wake-worker').length, 2)
    const workerMsgs = harness.messages.filter((m) => m.target === 'worker-1')
    assert.equal(workerMsgs.length, 1, 'worker-1 must receive 1 combined digest instead of 2 separate messages')
    assert.match(workerMsgs[0].text, /Multiple assignments ready \(2 items\)/)
    assert.match(workerMsgs[0].text, /W1/)
    assert.match(workerMsgs[0].text, /W2/)
  })
})

test('lazyStaffing spawns Wave 1 upfront and defers Wave 2 + reviewer until needed', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const settings = resolveSettings({ autoOrchestrate: true, autoStaff: true, lazyStaffing: true })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test', orchestrator })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const submitTool = tools.find((t) => t.name === 'team_flow_review_submit')

    const plan = await planTool.execute(
      {
        objective: 'Lazy staffing 2-wave run',
        acceptance_criteria: ['All waves complete'],
        items: [
          { id: 'W1', subject: 'Wave 1 task', owner: 'worker-1', reviewers: ['rev-1'], write_scopes: ['src/a/'], definition_of_done: ['W1 done'] },
          { id: 'W2', subject: 'Wave 2 task', owner: 'worker-2', reviewers: ['rev-1'], blocked_by: ['W1'], write_scopes: ['src/b/'], definition_of_done: ['W2 done'] },
        ],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )
    await orchestrator.whenIdle()

    assert.deepEqual(plan.staffed.spawned, [{ name: 'worker-1', kind: 'worker' }])
    assert.deepEqual(plan.staffed.deferred, [
      { name: 'worker-2', kind: 'worker' },
      { name: 'rev-1', kind: 'reviewer' },
    ])
    assert.equal(harness.spawns.length, 1, 'only wave 1 owner spawned at plan time')

    // Worker 1 reports -> orchestrator lazy-spawns rev-1 with diff/review context
    const w1Agent = { id: 'session-worker-1', session: { id: 'session-worker-1' } }
    await reportTool.execute(
      { item_id: 'W1', summary: 'W1 built', files: ['src/a/index.js'], commands: [{ command: 'npm test', exit_code: 0 }], evidence: ['pass'] },
      { agent: w1Agent, signal: new AbortController().signal },
    )
    await orchestrator.whenIdle()
    await orchestrator.reconcile(harness.lead)
    assert.ok(
      harness.spawns.some((s) => s.name === 'rev-1'),
      'reviewer must be lazy-spawned after report',
    )
    const revSpawn = harness.spawns.find((s) => s.name === 'rev-1')
    assert.ok(revSpawn, 'rev-1 must exist in spawns')
    assert.match(revSpawn.prompt, /W1 built/, 'lazy-spawned reviewer prompt includes initial report summary')

    // Reviewer approves W1 -> orchestrator lazy-spawns worker-2 for Wave 2
    const revAgent = { id: 'session-rev-1', session: { id: 'session-rev-1' } }
    await submitTool.execute(
      { item_id: 'W1', verdict: 'approve', summary: 'Looks solid', findings: [], evidence_checked: ['checked src/a/index.js'] },
      { agent: revAgent, signal: new AbortController().signal },
    )
    await orchestrator.whenIdle()
    await orchestrator.reconcile(harness.lead)
    assert.ok(
      harness.spawns.some((s) => s.name === 'worker-2'),
      'wave 2 worker must be lazy-spawned once W1 is approved',
    )
  })
})

test('orchestrator enforces single-flight per team and coalesces concurrent reconciles', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    harness.members.push({ name: 'worker-1', role: 'teammate', id: 'session-w1', status: 'inactive' })
    const settings = resolveSettings({ autoOrchestrate: true, autoStaff: false })
    const store = createStore({ ctx: harness.ctx, settings })

    let releaseFirstSend
    const sendGate = new Promise((resolve) => {
      releaseFirstSend = resolve
    })
    const origSend = harness.ctx.agentTeams.sendMessage
    let callCount = 0
    harness.ctx.agentTeams.sendMessage = async (caller, request) => {
      callCount += 1
      if (callCount === 1) await sendGate
      return origSend(caller, request)
    }

    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    await tools.find((t) => t.name === 'team_flow_plan').execute(
      {
        objective: 'Single-flight test',
        acceptance_criteria: ['Coalesce concurrent passes'],
        items: [{ id: 'W1', subject: 'Task', owner: 'worker-1', reviewers: ['lead'], write_scopes: ['src/'], definition_of_done: ['Done'] }],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )

    const p1 = orchestrator.reconcile(harness.lead)
    // Wait a tick so p1 enters sendMessage and holds single-flight lock
    await new Promise((r) => setTimeout(r, 20))
    const p2 = await orchestrator.reconcile(harness.lead)
    assert.equal(p2.coalesced, true)
    releaseFirstSend()
    const r1 = await p1
    assert.equal(r1.actionsTaken.length, 1)
    assert.equal(harness.messages.filter((m) => m.target === 'worker-1').length, 1)
  })
})

