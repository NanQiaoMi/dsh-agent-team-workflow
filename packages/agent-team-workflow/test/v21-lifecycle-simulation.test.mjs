/**
 * Full-Lifecycle Simulation Test for v2.1 & v2.2 Capabilities.
 *
 * Chains an end-to-end multi-wave feature run across a real git repository and
 * bare remote:
 *   1. `feature` preset tool pruning (`presetToolPruning`) & Wave 0/1 lazy worktree provisioning (`lazyWorktreeProvision`)
 *   2. Graduated stall nudge (`member/stall-nudge`) -> automatic `stall-recovery` thinking escalation (`high`)
 *   3. In-scope auto-commit on report (`autoCommitOnReport`) + tamper-proof `hostVerified` snapshot (`hostVerifyOnReport`)
 *   4. Conflict-free parallel pre-sync before squash merge (`autoPresyncWorktree`)
 *   5. Wave 1 lazy worktree creation inheriting upstream exports + 80% token budget thinking downgrade (`low`)
 *   6. Post-merge integration verification gate (`integrationVerifyCommands`) + `autoFinalize` + worktree cleanup
 *   7. Run-level reliability attribution metrics (`computeReliabilityMetrics`) & final Markdown report
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import * as Git from '../lib/git.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { renderReportMarkdown } from '../lib/protocol.js'
import { createStore } from '../lib/store.js'
import { computeReliabilityMetrics } from '../lib/telemetry.js'
import { selectThinkingPlan } from '../lib/thinking-router.js'
import { resolveAllowedToolNames } from '../lib/tool-matrix.js'
import { buildTools } from '../lib/tools.js'
import * as W from '../lib/workflow.js'

function realExec(file, args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { cwd: options.cwd, timeout: options.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const exitCode = error === null || error === undefined ? 0 : Number.isInteger(error.code) ? error.code : 1
        resolvePromise({ exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

async function gitRun(cwd, args) {
  const result = await realExec('git', args, { cwd })
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

async function withRepo(fn) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'atw-v21-sim-')))
  const repo = join(dir, 'repo')
  const remote = join(dir, 'remote.git')
  const baseShared = Array.from({ length: 12 }, (_, idx) => `line-${idx + 1}`).join('\n') + '\n'
  try {
    await mkdir(repo)
    await gitRun(dir, ['init', '-q', '-b', 'main', 'repo'])
    await gitRun(repo, ['config', 'user.email', 'agentteam@example.test'])
    await gitRun(repo, ['config', 'user.name', 'Agent Team'])
    await gitRun(repo, ['config', 'commit.gpgsign', 'false'])
    await writeFile(join(repo, 'README.md'), '# v2.1/v2.2 simulation\n')
    await writeFile(join(repo, 'shared.txt'), baseShared)
    await writeFile(join(repo, '.gitignore'), '.dsh-state\n.dsh-artifacts\n.agentteam/\n')
    await gitRun(repo, ['add', 'README.md', 'shared.txt', '.gitignore'])
    await gitRun(repo, ['commit', '-q', '-m', 'initial commit'])
    await gitRun(dir, ['init', '-q', '--bare', 'remote.git'])
    await gitRun(repo, ['remote', 'add', 'origin', remote])
    await gitRun(repo, ['push', '-q', '-u', 'origin', 'main'])
    return await fn({ dir, repo, remote, baseShared })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function createHarness(cwd) {
  const lead = { id: 'session-lead', session: { id: 'session-lead' } }
  const members = [
    { name: 'lead', role: 'lead', id: lead.id, status: 'running' },
    { name: 'worker1', role: 'teammate', id: 'session-w1', status: 'inactive' },
    { name: 'worker2', role: 'teammate', id: 'session-w2', status: 'running' },
    { name: 'reviewer1', role: 'teammate', id: 'session-r1', status: 'running' },
  ]
  const messages = []
  const tasks = []
  let taskNumber = 0

  const agentTeams = {
    tryMembership(agent) {
      const m = members.find((cand) => cand.id === agent.id)
      return m ? { root: lead, id: agent.id, name: m.name, role: m.role } : undefined
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
        text: request.content?.[0]?.text ?? '',
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
      return task
    },
    getTask(caller, taskId) {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) throw new Error(`Task ${taskId} not found`)
      return { ...task }
    },
    async updateTask(caller, request) {
      const task = tasks.find((t) => t.id === request.taskId)
      if (!task) throw new Error(`Task ${request.taskId} not found`)
      task.revision += 1
      if (request.action === 'claim') task.status = 'in_progress'
      if (request.action === 'complete') task.status = 'completed'
      return { ...task }
    },
  }

  return {
    lead,
    members,
    messages,
    tasks,
    ctx: {
      agentTeams,
      agents: { list: () => [lead] },
      workingDirectory: { get: () => cwd },
      artifactsDir: () => join(cwd, '.dsh-artifacts'),
      logger: { warn() {}, info() {}, debug() {} },
    },
  }
}

test('v2.1/v2.2 full lifecycle simulation: lazy worktrees, stall escalation, auto-commit, presync, 80% downgrade, integration gate & metrics', async () => {
  await withRepo(async ({ repo, baseShared }) => {
    const harness = createHarness(repo)
    let clockMs = 1_000_000
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      allowScopeOverlap: true,
      autoWorktree: true,
      lazyWorktreeProvision: true,
      autoCommitOnReport: true,
      autoPresyncWorktree: true,
      autoMergeWorktree: true,
      autoCleanupWorktrees: true,
      autoOrchestrate: true,
      autoFinalize: true,
      autoStaff: false,
      presetToolPruning: true,
      hostVerifyOnReport: true,
      maxStallNudges: 2,
      stallNudgeDelaySeconds: 30,
      tokenBudgetPerRun: 1000,
      gitVerifyCommands: ['node -e "process.exit(0)"'],
      integrationVerifyCommands: [
        'node -e "import(\'./app.mjs\').then(m => { if (m.run() !== \'hello:5\') process.exit(1) })"',
      ],
    })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings, now: () => clockMs })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: '2.2.0', orchestrator })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')

    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }
    const worker2Agent = { id: 'session-w2', session: { id: 'session-w2' } }
    const reviewer1Agent = { id: 'session-r1', session: { id: 'session-r1' } }

    // 1. Plan multi-wave feature run -> lazy Wave 1 + feature preset tool pruning
    await planTool.execute(
      {
        preset: 'feature',
        objective: 'Full v2.1/v2.2 lifecycle simulation',
        acceptance_criteria: ['All waves merge cleanly and pass integration gate'],
        items: [
          {
            id: 'T1',
            subject: 'Create lib.mjs and update top of shared.txt',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            write_scopes: ['lib.mjs', 'shared.txt'],
            review_depth: 'light',
            complexity: 'trivial',
            definition_of_done: ['Exports greet() and sum()'],
            evidence_commands: ['echo ok'],
          },
          {
            id: 'T2',
            subject: 'Update bottom of shared.txt in parallel',
            owner: 'worker2',
            reviewers: ['reviewer1'],
            write_scopes: ['shared.txt'],
            review_depth: 'light',
            complexity: 'trivial',
            definition_of_done: ['Updates line-12'],
            evidence_commands: ['echo ok'],
          },
          {
            id: 'T3',
            subject: 'Create app.mjs consuming lib.mjs in Wave 1',
            owner: 'worker2',
            reviewers: ['reviewer1'],
            blocked_by: ['T1', 'T2'],
            write_scopes: ['app.mjs'],
            review_depth: 'standard',
            complexity: 'complex',
            definition_of_done: ['app.mjs run() returns hello:5'],
            evidence_commands: ['echo ok'],
          },
        ],
      },
      { agent: harness.lead, signal: new AbortController().signal },
    )

    let state = await store.readState(harness.lead)
    const t1Init = state.items.find((it) => it.id === 'T1')
    const t2Init = state.items.find((it) => it.id === 'T2')
    const t3Init = state.items.find((it) => it.id === 'T3')
    assert.ok(t1Init.git?.worktreePath, 'Wave 0 T1 worktree must be provisioned immediately')
    assert.ok(t2Init.git?.worktreePath, 'Wave 0 T2 worktree must be provisioned immediately')
    assert.equal(t3Init.git?.worktreePath, undefined, 'Wave 1 T3 worktree must be deferred by lazyWorktreeProvision')

    const featureWorkerTools = resolveAllowedToolNames({ role: 'implementer', settings, state })
    assert.equal(featureWorkerTools.has('team_dev_lookup'), true, 'feature preset retains team_dev_lookup')
    assert.equal(featureWorkerTools.has('team_flow_work'), false, 'feature preset prunes inactive open-queue tool')
    assert.equal(featureWorkerTools.has('team_dev_contract'), false, 'feature preset prunes inactive contract tool')

    // 2. Stall nudge on inactive worker1 -> stall-recovery thinking escalation
    await orchestrator.whenIdle()
    assert.equal(harness.messages.filter((m) => m.target === 'worker1').length, 1, 'initial wake sent to worker1')

    clockMs += 40_000
    const nudgeRes = await orchestrator.reconcile(harness.lead)
    assert.ok(
      nudgeRes.actionsTaken.some((a) => a.type === 'stall-nudge' && a.target === 'worker1' && a.attempt === 1),
      'worker1 must receive stall nudge after delay',
    )
    state = await store.readState(harness.lead)
    const recoveryPlan = selectThinkingPlan({
      membership: { name: 'worker1', role: 'teammate' },
      state,
      settings: state.settings,
    })
    assert.equal(recoveryPlan.tier, 'high')
    assert.equal(recoveryPlan.stage, 'stall-recovery')
    assert.equal(recoveryPlan.reason, 'stall-recovery-escalate')

    // Mark worker1 running once it resumes work
    harness.members.find((m) => m.name === 'worker1').status = 'running'

    // 3. T1 auto-commit on report + host verification + light review + merge
    await writeFile(
      join(t1Init.git.worktreePath, 'lib.mjs'),
      "export function greet() { return 'hello' }\nexport function sum(a, b) { return a + b }\n",
    )
    await writeFile(join(t1Init.git.worktreePath, 'shared.txt'), baseShared.replace('line-1\n', 'line-1-by-T1\n'))
    const r1 = await reportTool.execute(
      {
        item_id: 'T1',
        summary: 'Implemented lib.mjs and top of shared.txt',
        files: ['lib.mjs', 'shared.txt'],
        commands: [{ command: 'node -e "process.exit(0)"', exit_code: 0 }],
        evidence: ['host check ok'],
      },
      { agent: worker1Agent },
    )
    assert.equal(r1.host_verified?.ok, true)
    await reviewTool.execute(
      { item_id: 'T1', verdict: 'approve', summary: 'Light review passed', evidence_checked: ['host_verified'] },
      { agent: reviewer1Agent },
    )

    // 4. T2 parallel edit on bottom of shared.txt -> autoCommit + autoPresyncWorktree + merge
    await writeFile(join(t2Init.git.worktreePath, 'shared.txt'), baseShared.replace('line-12\n', 'line-12-by-T2\n'))
    const r2 = await reportTool.execute(
      {
        item_id: 'T2',
        summary: 'Updated bottom of shared.txt',
        files: ['shared.txt'],
        commands: [{ command: 'node -e "process.exit(0)"', exit_code: 0 }],
        evidence: ['host check ok'],
      },
      { agent: worker2Agent },
    )
    assert.equal(r2.host_verified?.ok, true)
    await reviewTool.execute(
      { item_id: 'T2', verdict: 'approve', summary: 'Light review passed', evidence_checked: ['host_verified'] },
      { agent: reviewer1Agent },
    )

    state = await store.readState(harness.lead)
    const t2Merged = state.items.find((it) => it.id === 'T2')
    assert.ok(t2Merged.git?.worktreeMergedAt, 'T2 must be merged into runBranch')
    assert.ok(t2Merged.git?.worktreePresyncedAt, 'T2 must record auto-presync timestamp')
    assert.ok(state.events.some((ev) => ev.type === 'git/worktree-presynced' && ev.detail.includes('T2')))
    const sharedOnRunBranch = await gitRun(repo, ['show', `${state.git.branch}:shared.txt`])
    assert.match(sharedOnRunBranch, /line-1-by-T1/)
    assert.match(sharedOnRunBranch, /line-12-by-T2/)

    // 5. Wave 1 T3 lazily provisioned from updated runBranch + 80% budget thinking downgrade
    const t3Ready = state.items.find((it) => it.id === 'T3')
    assert.ok(t3Ready.git?.worktreePath, 'T3 must now have a lazily provisioned worktree after Wave 0 merged')
    const upstreamLib = await gitRun(t3Ready.git.worktreePath, ['show', 'HEAD:lib.mjs'])
    assert.match(upstreamLib, /export function greet/)

    const budgetDowngradedPlan = selectThinkingPlan({
      membership: { name: 'worker2', role: 'teammate' },
      state,
      settings: state.settings,
      usage: { totalTokens: 850 },
    })
    assert.equal(budgetDowngradedPlan.tier, 'low')
    assert.equal(budgetDowngradedPlan.budgetDowngraded, true)

    await writeFile(
      join(t3Ready.git.worktreePath, 'app.mjs'),
      "import { greet, sum } from './lib.mjs'\nexport function run() { return `${greet()}:${sum(2, 3)}` }\n",
    )
    const r3 = await reportTool.execute(
      {
        item_id: 'T3',
        summary: 'Implemented app.mjs integrating lib.mjs',
        files: ['app.mjs'],
        commands: [{ command: 'node -e "process.exit(0)"', exit_code: 0 }],
        evidence: ['host check ok'],
      },
      { agent: worker2Agent },
    )
    assert.equal(r3.host_verified?.ok, true)
    await reviewTool.execute(
      { item_id: 'T3', verdict: 'approve', summary: 'Standard review passed', evidence_checked: ['app.mjs', 'host_verified'] },
      { agent: reviewer1Agent },
    )

    // 6. Auto-finalize integration gate + worktree cleanup + reliability metrics + report
    clockMs += 5_000
    await orchestrator.reconcile(harness.lead)
    await orchestrator.whenIdle()

    state = await store.readState(harness.lead)
    assert.equal(state.phase, W.RUN_PHASE.FINALIZED, 'run must finalize after integration gate passes')
    assert.equal(state.integrationGate?.pass, true, 'post-merge integration gate must pass')

    const wtList = await Git.gitWorktreeList({ cwd: repo })
    for (const item of state.items) {
      assert.ok(item.git?.worktreeMergedAt)
      assert.ok(item.git?.worktreeRemovedAt)
      assert.equal(
        wtList.worktrees.some((wt) => wt.branch === item.git.worktreeBranch),
        false,
        `${item.id} worktree must be cleaned up on finalize`,
      )
    }

    const metrics = computeReliabilityMetrics(state)
    assert.equal(metrics.totalItems, 3)
    assert.equal(metrics.approvedItems, 3)
    assert.equal(metrics.firstPassApproved, 3)
    assert.equal(metrics.firstPassApproveRate, 1)
    assert.equal(metrics.reworkRounds, 0)
    assert.equal(metrics.stallNudges, 1)
    assert.equal(metrics.stallEscalations, 0)
    assert.equal(metrics.autoCommits, 3)
    assert.equal(metrics.mergeConflicts, 0)
    assert.equal(metrics.hostVerifiedPasses, 3)
    assert.equal(metrics.hostVerifiedFailures, 0)
    assert.equal(metrics.integrationGate?.pass, true)

    const reportMd = renderReportMarkdown(state, { pass: true, itemGates: [], teamFailures: [] })
    assert.match(reportMd, /## Reliability & efficiency/)
    assert.match(reportMd, /First-pass approve rate: 100% \(3\/3\)/)
    assert.match(reportMd, /Auto-commits \/ merge conflicts: 3 \/ 0/)
    assert.match(reportMd, /Host-verified snapshots \(pass \/ fail\): 3 \/ 0/)
    assert.match(reportMd, /Integration gate: pass/)
  })
})
