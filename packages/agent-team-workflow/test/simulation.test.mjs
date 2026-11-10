/**
 * Real-world multi-agent collaboration simulation for Agent Teams workflow.
 *
 * Simulates an end-to-end multi-member software development workflow:
 * 1. Planning: Team Lead plans a 2-wave modular project (Auth -> Checkout) with write scopes and DoD.
 * 2. Communication & Alignment: Alice and Lead/Carol exchange questions and answers via team_flow_talk.
 * 3. Autonomous Consensus: Alice proposes a DoD clarification via team_flow_decide; peers vote and settle it.
 * 4. Implementation & Quality Pre-Check: Alice submits code and test; pre-report gate rejects non-zero exit codes fail-fast.
 * 5. Review & Nit Tolerance: Carol attempts request_changes on pure nit, engine advises approve_with_nits; Carol approves.
 * 6. Cold Data Archive: W1's detailed report and reviews are evicted to .agentteam/teams/<id>/archive/W1.json.
 * 7. Orchestrator Event Reconciliation: Orchestrator detects W1 approval and unblocks W2, notifying Bob.
 * 8. On-Demand Cold Retrieval & Chained Delivery: Bob reads W1's archived report via team_flow_read { archive_item_id }, implements W2, Carol approves.
 * 9. Token Attribution Telemetry: Multi-turn tokens collected and attributed across Lead, Worker, and Reviewer.
 * 10. Quality Gate Finalization & Report: Lead finalizes; gate evaluates passing status; final report.md rendered with Token Attribution table.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import { filterToolsByRole, resolveAllowedToolNames } from '../lib/tool-matrix.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { buildSnapshot } from '../lib/dashboard.js'
import * as W from '../lib/workflow.js'

function createSimulationHarness(cwd) {
  const leadAgent = { id: 'session-lead', session: { id: 'session-lead' } }
  const aliceAgent = { id: 'session-alice', session: { id: 'session-alice' } }
  const bobAgent = { id: 'session-bob', session: { id: 'session-bob' } }
  const carolAgent = { id: 'session-carol', session: { id: 'session-carol' } }

  const agents = new Map([
    ['lead', leadAgent],
    ['alice', aliceAgent],
    ['bob', bobAgent],
    ['carol', carolAgent],
  ])

  const members = [
    { name: 'lead', role: 'lead', id: leadAgent.id, status: 'running' },
    { name: 'alice', role: 'implementer', id: aliceAgent.id, status: 'running' },
    { name: 'bob', role: 'implementer', id: bobAgent.id, status: 'inactive' },
    { name: 'carol', role: 'reviewer', id: carolAgent.id, status: 'running' },
  ]

  const tasks = []
  const messages = []
  let taskCounter = 0

  const agentTeams = {
    tryMembership(agent) {
      const member = members.find((m) => m.id === agent?.id)
      return member ? { root: leadAgent, id: member.id, name: member.name, role: member.role } : undefined
    },
    membership(agent) {
      const result = agentTeams.tryMembership(agent)
      if (!result) throw new Error(`Agent ${agent?.id} is not a team member`)
      return result
    },
    listMembers() {
      return members.map((m) => ({ ...m, context: 'fresh', diagnostics: [] }))
    },
    listTasks() {
      return tasks.map((t) => ({ ...t }))
    },
    getTask(_caller, id) {
      const task = tasks.find((t) => t.id === id)
      if (!task) throw new Error(`Task ${id} not found`)
      return { ...task }
    },
    async createTask(caller, req) {
      taskCounter += 1
      const task = {
        id: `task-${taskCounter}`,
        revision: 1,
        subject: req.subject,
        description: req.description,
        status: 'pending',
        blockedBy: [...(req.blockedBy ?? [])],
        writeScopes: [...(req.writeScopes ?? [])],
        ownerId: req.ownerId ?? null,
      }
      tasks.push(task)
      return task
    },
    async updateTask(caller, req) {
      const task = tasks.find((t) => t.id === req.taskId)
      if (!task) throw new Error(`Task ${req.taskId} not found`)
      if (req.action === 'claim') {
        task.status = 'in_progress'
        task.ownerId = caller.id
      } else if (req.action === 'complete') {
        task.status = 'completed'
      } else if (req.action === 'reopen') {
        task.status = 'pending'
      }
      task.revision += 1
      return { ...task }
    },
    async sendMessage(caller, req) {
      const sender = members.find((m) => m.id === caller?.id)?.name ?? caller?.id
      messages.push({ from: sender, to: req.target, text: req.content[0]?.text ?? '' })
      return { messageId: `msg-${messages.length}` }
    },
  }

  const ctx = {
    agents: {
      list: () => [...agents.values()],
      get: (id) => [...agents.values()].find((a) => a.id === id),
    },
    workingDirectory: { get: () => cwd, defaultDirectory: cwd },
    agentTeams,
    logger: { info() {}, warn() {}, error() {} },
  }

  return { ctx, lead: leadAgent, alice: aliceAgent, bob: bobAgent, carol: carolAgent, messages, tasks }
}

test('real-world path simulation: plan, collaborate, propose, pre-gate, nit-tolerance, cold-archive, unblock, telemetry, and finalize', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'atw-sim-'))
  const signal = new AbortController().signal

  try {
    const harness = createSimulationHarness(cwd)
    const settings = resolveSettings({
      writeArtifacts: true,
      archiveApprovedItems: true,
      nitTolerance: true,
      preReportCheck: true,
      autoOrchestrate: true,
      autoWakeUnblocked: true,
      autoWakeReviewers: true,
      requireReviewEvidence: true,
    })

    const tokenMeter = {
      lead: { uncachedInputTokens: 1200, outputTokens: 300, cacheReadTokens: 1500, cacheWriteTokens: 0 },
      alice: { uncachedInputTokens: 3500, outputTokens: 1200, cacheReadTokens: 8000, cacheWriteTokens: 0 },
      bob: { uncachedInputTokens: 2800, outputTokens: 1000, cacheReadTokens: 6000, cacheWriteTokens: 0 },
      carol: { uncachedInputTokens: 1800, outputTokens: 600, cacheReadTokens: 4000, cacheWriteTokens: 0 },
    }
    const readTokenUsage = (agent) => {
      const id = String(agent?.id ?? '')
      const key = id.replace('session-', '')
      return { totals: tokenMeter[key] ?? { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    }

    const store = createStore({ ctx: harness.ctx, settings })
    let orchestrator = null
    const allTools = buildTools({
      ctx: harness.ctx,
      settings,
      store,
      version: '1.26.0',
      tokenUsage: () => readTokenUsage,
      orchestrator: { trigger: (agent) => orchestrator?.reconcile?.(agent) },
    })
    orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings, tokenUsage: () => readTokenUsage })

    // Helper to get role-scoped tool executor for an agent
    const getTool = (agent, name) => {
      const member = harness.ctx.agentTeams.membership(agent)
      const allowed = resolveAllowedToolNames({ role: member.role, settings })
      const scoped = filterToolsByRole(allTools, allowed)
      const target = scoped.find((t) => t.name === name)
      if (!target) throw new Error(`Tool "${name}" is not accessible to member "${member.name}" (${member.role})`)
      return (args) => target.execute(args, { agent, signal })
    }

    // ------------------------------------------------------------------------
    // Step 1: Team Lead Plans the 2-Wave Architecture
    // ------------------------------------------------------------------------
    const leadPlan = getTool(harness.lead, 'team_flow_plan')
    const planResult = await leadPlan({
      objective: 'Build modular payment platform with auth token verifier and stripe checkout',
      acceptance_criteria: [
        'Auth module passes signature and expiration verification',
        'Stripe checkout integrates with auth and verifies payment webhooks',
      ],
      constraints: ['No external npm packages beyond workspace dependencies'],
      items: [
        {
          id: 'W1',
          subject: 'Auth Token Verifier',
          owner: 'alice',
          role: 'implementer',
          write_scopes: ['src/auth/'],
          definition_of_done: ['Token verification module created', 'Unit test with expiration pass'],
          reviewers: ['carol'],
        },
        {
          id: 'W2',
          subject: 'Stripe Checkout Integration',
          owner: 'bob',
          role: 'implementer',
          write_scopes: ['src/checkout/'],
          blocked_by: ['W1'],
          definition_of_done: ['Checkout charges card token', 'Integration test with auth passes'],
          reviewers: ['carol'],
        },
      ],
    })

    assert.equal(planResult.waves.length, 2, 'Must calculate 2 execution waves')
    assert.deepEqual(planResult.waves[0], ['W1'], 'Wave 0 contains unblocked auth task')
    assert.deepEqual(planResult.waves[1], ['W2'], 'Wave 1 contains checkout task dependent on W1')
    assert.equal(harness.tasks.length, 2, 'Created 2 backing shared tasks')

    // ------------------------------------------------------------------------
    // Step 2: Peer Dialogue & Alignment on Channel (team_flow_talk)
    // ------------------------------------------------------------------------
    const aliceTalk = getTool(harness.alice, 'team_flow_talk')
    const carolTalk = getTool(harness.carol, 'team_flow_talk')
    const aliceRead = getTool(harness.alice, 'team_flow_read')
    const carolRead = getTool(harness.carol, 'team_flow_read')

    // Alice checks read tool and asks a clarification question
    const aliceContext = await aliceRead({ item_id: 'W1' })
    assert.equal(aliceContext.item.id, 'W1')
    assert.equal(aliceContext.item.status, 'pending')

    const questionSent = await aliceTalk({
      target: 'carol',
      kind: 'question',
      text: 'Should auth token TTL be hardcoded to 3600 seconds or configurable via options?',
      item_id: 'W1',
    })
    assert.ok(questionSent.message_id)
    assert.deepEqual(questionSent.delivered_to, ['carol'])

    // Carol reads the channel and answers
    const carolContext = await carolRead({ item_id: 'W1' })
    const lastMsg = carolContext.channel.at(-1)
    assert.equal(lastMsg.from, 'alice')
    assert.match(lastMsg.text, /auth token TTL/)

    const answerSent = await carolTalk({
      target: 'alice',
      kind: 'answer',
      text: 'Make 3600s the default in options, with override support.',
      reply_to: lastMsg.id,
      item_id: 'W1',
    })
    assert.ok(answerSent.message_id)
    assert.deepEqual(answerSent.delivered_to, ['alice'])

    // ------------------------------------------------------------------------
    // Step 3: Peer Consensus Proposal & Voting (team_flow_decide)
    // ------------------------------------------------------------------------
    const aliceDecide = getTool(harness.alice, 'team_flow_decide')
    const carolDecide = getTool(harness.carol, 'team_flow_decide')
    const bobDecide = getTool(harness.bob, 'team_flow_decide')

    const proposalCreated = await aliceDecide({
      action: 'propose',
      item_id: 'W1',
      kind: 'dod',
      text: 'Add standard 3600s default TTL test to DoD',
    })
    assert.equal(proposalCreated.status, 'open')
    const proposalId = proposalCreated.proposal_id

    // Both affected members (owner Alice and reviewer Carol) vote
    await aliceDecide({
      action: 'vote',
      proposal_id: proposalId,
      vote: 'yes',
      comment: 'Proposer agreement',
    })

    const voteCarol = await carolDecide({
      action: 'vote',
      proposal_id: proposalId,
      vote: 'yes',
      comment: 'Agree, ensures consistency across teams',
    })
    assert.equal(voteCarol.status, 'accepted')
    assert.match(voteCarol.resolution, /accepted by vote/)

    // ------------------------------------------------------------------------
    // Step 4: Alice Implements W1 & Pre-Report Deterministic Gate
    // ------------------------------------------------------------------------
    await mkdir(join(cwd, 'src', 'auth'), { recursive: true })
    await writeFile(join(cwd, 'src', 'auth', 'token.js'), 'export function verifyToken(t) { return t.valid === true }', 'utf8')
    await writeFile(join(cwd, 'src', 'auth', 'token.test.js'), 'import { verifyToken } from "./token.js"; if (!verifyToken({valid:true})) throw new Error("fail");', 'utf8')

    const aliceReport = getTool(harness.alice, 'team_flow_report')

    // 4a: Test Pre-Report Gate: fail fast if non-zero exit code is recorded without deviation
    await assert.rejects(
      aliceReport({
        item_id: 'W1',
        summary: 'Finished token verification',
        files: ['src/auth/token.js'],
        commands: [{ command: 'node src/auth/token.test.js', exit_code: 1, note: 'syntax error' }],
        evidence: ['tests failed'],
      }),
      /verification command failed.*exit code 1/,
      'Pre-report check must reject failed commands without deviation explanation',
    )

    // 4b: Submit valid report with passing exit code
    const reportOutcome = await aliceReport({
      item_id: 'W1',
      summary: 'Auth token verification with RSA and default 3600s TTL completed and tested',
      files: ['src/auth/token.js', 'src/auth/token.test.js'],
      commands: [{ command: 'node src/auth/token.test.js', exit_code: 0, note: '1 passed' }],
      evidence: [
        'src/auth/token.test.js exited with 0',
        'Exported verifyToken signature checked',
        'Default TTL options 3600 verified against test fixture',
      ],
      open_questions: [],
      risks: ['Ensure secret key is provided via environment in deployment'],
    })
    assert.equal(reportOutcome.status, 'in_review')
    assert.equal(reportOutcome.reviewer, 'carol')
    assert.equal(harness.tasks.find((t) => t.id === 'task-1')?.status, 'completed', 'Shared task auto-completed on report')

    // ------------------------------------------------------------------------
    // Step 5: Carol Reviews W1 with Nit Tolerance
    // ------------------------------------------------------------------------
    const carolReview = getTool(harness.carol, 'team_flow_review_submit')

    // 5a: Test Nit Tolerance Gate: Request changes with ONLY nit findings is blocked
    await assert.rejects(
      carolReview({
        item_id: 'W1',
        verdict: 'request_changes',
        summary: 'Looks good overall, just noticed a small comment typo',
        findings: [{ id: 'F1', severity: 'nit', claim: 'Typo in token.js docstring' }],
        evidence_checked: ['read src/auth/token.js'],
      }),
      /all findings have "nit" severity.*approve_with_nits/,
      'Nit tolerance must intercept pure nit rework cycles',
    )

    // 5b: Carol submits approve_with_nits
    const reviewApproval = await carolReview({
      item_id: 'W1',
      verdict: 'approve_with_nits',
      summary: 'Auth implementation meets DoD and verified clean test suite; small docstring typo noted',
      findings: [{ id: 'F1', severity: 'nit', claim: 'Typo in token.js docstring' }],
      evidence_checked: ['Inspected src/auth/token.js logic', 'Ran node src/auth/token.test.js directly'],
    })
    assert.equal(reviewApproval.item_status, 'approved')

    // ------------------------------------------------------------------------
    // Step 6: Verify Cold Data Archive for Approved Item W1
    // ------------------------------------------------------------------------
    const stateAfterW1 = await store.readState(harness.lead)
    const itemW1 = stateAfterW1.items.find((i) => i.id === 'W1')
    assert.equal(itemW1.status, 'approved')
    assert.equal(itemW1.archived, true, 'W1 should be marked as archived')
    assert.equal(itemW1.report.archived, true)
    assert.ok(itemW1.report.archivePath.includes('archive/W1.json'), 'Archive path points to disk file')
    assert.deepEqual(itemW1.report.evidence, [], 'Heavy evidence evicted from active state')
    assert.deepEqual(itemW1.report.risks, [], 'Risks evicted from active state')
    assert.equal(itemW1.reviews[0].archived, true)
    assert.deepEqual(itemW1.reviews[0].findings, [], 'Detailed findings evicted from active state')

    // ------------------------------------------------------------------------
    // Step 7: Autonomous Event Reconciliation (Unblocking Wave 1)
    // ------------------------------------------------------------------------
    const recon = await orchestrator.reconcile(harness.lead)
    assert.ok(recon.actionsTaken.some((a) => a.type === 'wake-worker' && a.target === 'bob'), 'Bob auto-woken for W2')

    // ------------------------------------------------------------------------
    // Step 8: Bob Retrieves W1's Cold Archive on Demand & Delivers W2
    // ------------------------------------------------------------------------
    const bobRead = getTool(harness.bob, 'team_flow_read')
    const bobReport = getTool(harness.bob, 'team_flow_report')

    // Bob pulls archived details of W1 on demand without inflating the whole state
    const bobFetchArchive = await bobRead({ archive_item_id: 'W1' })
    assert.ok(bobFetchArchive.archived_item !== null)
    assert.equal(bobFetchArchive.archived_item.id, 'W1')
    assert.equal(bobFetchArchive.archived_item.report.evidence.length, 3, 'Full 3 evidence items retrieved on demand')
    assert.equal(bobFetchArchive.archived_item.reviews[0].summary, 'Auth implementation meets DoD and verified clean test suite; small docstring typo noted')

    // Bob implements W2
    await mkdir(join(cwd, 'src', 'checkout'), { recursive: true })
    await writeFile(join(cwd, 'src', 'checkout', 'checkout.js'), 'import { verifyToken } from "../auth/token.js"; export function charge(card, token) { if (!verifyToken(token)) throw new Error("unauthorized"); return { id: "ch_123", amount: 1000 } }', 'utf8')
    await writeFile(join(cwd, 'src', 'checkout', 'checkout.test.js'), 'import { charge } from "./checkout.js"; const res = charge({}, {valid:true}); if (res.id !== "ch_123") throw new Error("bad charge");', 'utf8')

    const bobReportOutcome = await bobReport({
      item_id: 'W2',
      summary: 'Implemented Stripe checkout with auth verification integration',
      files: ['src/checkout/checkout.js', 'src/checkout/checkout.test.js'],
      commands: [{ command: 'node src/checkout/checkout.test.js', exit_code: 0, note: 'integration passed' }],
      evidence: ['node src/checkout/checkout.test.js exited 0', 'charge() successfully verified auth token'],
      open_questions: [],
      risks: [],
    })
    assert.equal(bobReportOutcome.status, 'in_review')
    assert.equal(bobReportOutcome.reviewer, 'carol')

    // Carol reviews and approves W2
    const carolReviewW2 = await carolReview({
      item_id: 'W2',
      verdict: 'approve',
      summary: 'Integration with auth token verifier is clean and charge tests succeed',
      findings: [],
      evidence_checked: ['Checked src/checkout/checkout.js integration', 'Ran node src/checkout/checkout.test.js'],
    })
    assert.equal(carolReviewW2.item_status, 'approved')

    // ------------------------------------------------------------------------
    // Step 9: Quality Gate Evaluation & Convergence
    // ------------------------------------------------------------------------
    const leadGate = getTool(harness.lead, 'team_flow_gate')
    const preGate = await leadGate({ finalize: false })
    assert.equal(preGate.pass, true, 'All quality gates must pass')
    assert.equal(preGate.finalized, false)

    // Finalize the run
    const finalGate = await leadGate({ finalize: true })
    assert.equal(finalGate.pass, true)
    assert.equal(finalGate.finalized, true)

    // ------------------------------------------------------------------------
    // Step 10: Verify Report Markdown & Telemetry Token Attribution
    // ------------------------------------------------------------------------
    const reportMdPath = join(cwd, '.agentteam', 'teams', 'session-lead', 'report.md')
    const reportContent = await readFile(reportMdPath, 'utf8')

    // Verifications on final report
    assert.match(reportContent, /Agent Team Workflow Report/)
    assert.match(reportContent, /Build modular payment platform/)
    assert.match(reportContent, /W1 — Auth Token Verifier/)
    assert.match(reportContent, /W2 — Stripe Checkout Integration/)
    assert.match(reportContent, /Details archived at .*archive\/W1\.json/)

    // Token attribution breakdown verification
    assert.match(reportContent, /## Token attribution by role/)
    assert.match(reportContent, /\| lead \| 1200 \| 300 \| 1500 \| 0 \| 3000 \|/)
    assert.match(reportContent, /\| worker \| 6300 \| 2200 \| 14000 \| 0 \| 22500 \|/)
    assert.match(reportContent, /\| reviewer \| 1800 \| 600 \| 4000 \| 0 \| 6400 \|/)

    // Dashboard snapshot inspection
    const finalState = await store.readState(harness.lead)
    assert.equal(finalState.phase, 'finalized')

    const snapshot = buildSnapshot({
      state: finalState,
      team: { me: { name: 'lead', role: 'lead' }, members: harness.ctx.agentTeams.listMembers(), tasks: harness.tasks },
      artifacts: { reportPath: reportMdPath },
      diagnostics: { warnings: [] },
      sessionId: 'session-lead',
      now: new Date().toISOString(),
    })

    assert.equal(snapshot.run.phase, 'finalized')
    assert.equal(snapshot.run.counts.approved, 2)
    assert.equal(snapshot.run.counts.pending, 0)
    assert.ok(snapshot.run.usage.byRole.lead.totalTokens > 0)
    assert.ok(snapshot.run.usage.byRole.worker.totalTokens > 0)
    assert.ok(snapshot.run.usage.byRole.reviewer.totalTokens > 0)
    assert.ok(snapshot.run.usage.tokenShare.worker > 0.5, 'Workers should account for majority share of workload')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
