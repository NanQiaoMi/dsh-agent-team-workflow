/**
 * Unit & integration tests for the Automated Worktree Isolation Engine.
 *
 * Verifies that:
 * 1. autoProvisionWorktrees automatically provisions isolated worktrees & branches
 *    for planned items when worktreeIsolation is 'parallel' or 'serial'.
 * 2. autoMergeApprovedWorktree automatically squash-merges an item's branch into the
 *    team's run branch upon reviewer approval.
 * 3. autoCleanupRunWorktrees automatically cleans up worktrees upon gate finalization.
 * 4. Backward compatibility: worktreeIsolation: 'off' skips all worktree operations cleanly.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { createStore } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import * as Git from '../lib/git.js'
import { autoMergeApprovedWorktree, getWorktreeDiffSummary } from '../lib/worktree-manager.js'

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
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'atw-wt-engine-')))
  const repo = join(dir, 'repo')
  const remote = join(dir, 'remote.git')
  try {
    await mkdir(repo)
    await gitRun(dir, ['init', '-q', '-b', 'main', 'repo'])
    await gitRun(repo, ['config', 'user.email', 'agentteam@example.test'])
    await gitRun(repo, ['config', 'user.name', 'Agent Team'])
    await gitRun(repo, ['config', 'commit.gpgsign', 'false'])
    await writeFile(join(repo, 'README.md'), '# demo\n')
    await writeFile(join(repo, '.gitignore'), '.dsh-state\n.dsh-artifacts\n.agentteam/\n')
    await gitRun(repo, ['add', 'README.md', '.gitignore'])
    await gitRun(repo, ['commit', '-q', '-m', 'initial commit'])
    await gitRun(dir, ['init', '-q', '--bare', 'remote.git'])
    await gitRun(repo, ['remote', 'add', 'origin', remote])
    await gitRun(repo, ['push', '-q', '-u', 'origin', 'main'])
    return await fn({ dir, repo, remote })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function createHarness(cwd, customMembers = []) {
  const lead = { id: 'session-lead', session: { id: 'session-lead' } }
  const defaultMembers = [
    { name: 'lead', role: 'lead', id: lead.id, status: 'running' },
    { name: 'worker1', role: 'worker', id: 'session-w1', status: 'running' },
    { name: 'worker2', role: 'worker', id: 'session-w2', status: 'running' },
    { name: 'reviewer1', role: 'reviewer', id: 'session-r1', status: 'running' },
  ]
  const members = customMembers.length > 0 ? customMembers : defaultMembers
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
      if (request.expectedRevision !== undefined && task.revision !== request.expectedRevision) {
        throw new Error('Revision mismatch')
      }
      task.revision += 1
      if (request.action === 'claim') task.status = 'in_progress'
      if (request.action === 'complete') task.status = 'completed'
      return { ...task }
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
    artifactsDir: () => join(cwd, '.dsh-artifacts'),
    logger: {
      warn: () => {},
      debug: () => {},
    },
  }

  return { ctx, lead, members, messages, tasks }
}

test('autoProvisionWorktrees automatically sets up parallel worktrees on plan', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      autoWorktree: true,
      autoStaff: false,
    })
    const store = createStore({ ctx: harness.ctx, settings })

    const tools = buildTools({
      ctx: harness.ctx,
      settings,
      store,
      version: '1.18.0',
    })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const res = await planTool.execute(
      {
        objective: 'Test parallel worktree isolation',
        acceptance_criteria: ['Worktrees created and functioning'],
        items: [
          {
            id: 'T1',
            subject: 'Build feature A',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            definition_of_done: ['A works'],
            evidence_commands: ['echo A'],
          },
          {
            id: 'T2',
            subject: 'Build feature B',
            owner: 'worker2',
            reviewers: ['reviewer1'],
            definition_of_done: ['B works'],
            evidence_commands: ['echo B'],
          },
        ],
      },
      { agent: harness.lead },
    )

    const state = await store.readState(harness.lead)
    assert.equal(state.settings.worktreeIsolation, 'parallel')
    assert.ok(state.git?.branch, 'team run branch must be created')

    const t1 = state.items.find((it) => it.id === 'T1')
    const t2 = state.items.find((it) => it.id === 'T2')

    assert.ok(t1.git?.worktree, 'T1 must have worktree relative path')
    assert.ok(t1.git?.worktreePath, 'T1 must have worktree absolute path')
    assert.ok(t1.git?.worktreeBranch, 'T1 must have worktree branch')

    assert.ok(t2.git?.worktree, 'T2 must have worktree relative path')
    assert.ok(t2.git?.worktreePath, 'T2 must have worktree absolute path')
    assert.ok(t2.git?.worktreeBranch, 'T2 must have worktree branch')

    // Verify worktrees exist in git
    const wtList = await Git.gitWorktreeList({ cwd: repo })
    assert.equal(wtList.ok, true)
    assert.ok(wtList.worktrees.some((wt) => wt.branch === t1.git.worktreeBranch))
    assert.ok(wtList.worktrees.some((wt) => wt.branch === t2.git.worktreeBranch))
  })
})

test('autoMergeApprovedWorktree squash-merges approved worktree changes and cleans up on finalize', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      autoWorktree: true,
      autoMergeWorktree: true,
      autoCleanupWorktrees: true,
      autoStaff: false,
    })
    const store = createStore({ ctx: harness.ctx, settings })

    const tools = buildTools({
      ctx: harness.ctx,
      settings,
      store,
      version: '1.18.0',
    })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')
    const gateTool = tools.find((t) => t.name === 'team_flow_gate')
    const gitTool = tools.find((t) => t.name === 'team_flow_git')

    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }
    const reviewer1Agent = { id: 'session-r1', session: { id: 'session-r1' } }

    // 1. Lead plans 1 item
    await planTool.execute(
      {
        objective: 'Test worktree auto-merge',
        acceptance_criteria: ['Worktree auto merges on approval'],
        items: [
          {
            id: 'T1',
            subject: 'Build feature in worktree',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            definition_of_done: ['File created'],
            evidence_commands: ['cat file_a.txt'],
          },
        ],
      },
      { agent: harness.lead },
    )

    let state = await store.readState(harness.lead)
    const t1 = state.items.find((it) => it.id === 'T1')
    assert.ok(t1.git?.worktreePath)

    // 2. Worker1 creates file_a.txt inside its isolated worktree
    const fileInWt = join(t1.git.worktreePath, 'file_a.txt')
    await writeFile(fileInWt, 'content from worktree T1\n')

    // Commit change inside worktree
    const commitRes = await gitTool.execute(
      {
        action: 'commit',
        item_id: 'T1',
        files: ['file_a.txt'],
        message: 'feat: add file_a.txt',
      },
      { agent: worker1Agent },
    )
    assert.ok(commitRes.item_git?.sha)

    // 3. Worker1 submits report
    await reportTool.execute(
      {
        item_id: 'T1',
        summary: 'Finished file_a.txt in worktree',
        files: ['file_a.txt'],
        commands: [{ command: 'cat file_a.txt', exit_code: 0, output: 'content from worktree T1\n' }],
        evidence: ['cat file_a.txt exited 0 with expected output'],
      },
      { agent: worker1Agent },
    )

    // Verify reviewer receives notification with diff delivery
    const reviewNotice = harness.messages.find((m) => m.target === 'reviewer1')
    assert.ok(reviewNotice, 'reviewer must receive notification')
    assert.ok(reviewNotice.text.includes('# Code Changes (Diff)'), 'review notice must include code diff section')
    assert.ok(reviewNotice.text.includes('file_a.txt'), 'diff must list file_a.txt')

    // 4. Reviewer1 approves report
    const reviewRes = await reviewTool.execute(
      {
        item_id: 'T1',
        verdict: 'approve',
        summary: 'Verified file_a.txt looks good',
        evidence_checked: ['file_a.txt exists and verified'],
      },
      { agent: reviewer1Agent },
    )
    assert.equal(reviewRes.verdict, 'approve')

    // Verify autoMergeApprovedWorktree merged the change into state.git.branch
    state = await store.readState(harness.lead)
    const updatedT1 = state.items.find((it) => it.id === 'T1')
    assert.ok(updatedT1.git?.worktreeMergedAt, 'worktreeMergedAt must be set')
    assert.equal(updatedT1.git?.worktreeMergeMethod, 'squash')

    // Verify file_a.txt is committed in state.git.branch
    const branchContent = await gitRun(repo, ['show', `${state.git.branch}:file_a.txt`])
    assert.equal(branchContent, 'content from worktree T1\n')

    // 5. Lead finalizes gate -> worktrees should be cleaned up automatically
    const gateRes = await gateTool.execute(
      {
        finalize: true,
      },
      { agent: harness.lead },
    )
    assert.equal(gateRes.pass, true)
    assert.equal(gateRes.finalized, true)

    // Check worktree removed
    const wtListAfter = await Git.gitWorktreeList({ cwd: repo })
    assert.ok(!wtListAfter.worktrees.some((wt) => wt.branch === t1.git.worktreeBranch))

    state = await store.readState(harness.lead)
    const finalizedT1 = state.items.find((it) => it.id === 'T1')
    assert.ok(finalizedT1.git?.worktreeRemovedAt)
  })
})

test('serial worktree isolation provisions only one active worktree at a time', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'serial',
      autoWorktree: true,
      autoMergeWorktree: true,
      autoStaff: false,
    })
    const store = createStore({ ctx: harness.ctx, settings })

    const tools = buildTools({
      ctx: harness.ctx,
      settings,
      store,
      version: '1.18.0',
    })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')
    const gitTool = tools.find((t) => t.name === 'team_flow_git')

    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }
    const reviewer1Agent = { id: 'session-r1', session: { id: 'session-r1' } }

    // Plan two items
    await planTool.execute(
      {
        objective: 'Test serial worktree isolation',
        acceptance_criteria: ['Serial worktrees provisioned one at a time'],
        items: [
          {
            id: 'T1',
            subject: 'First task',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            definition_of_done: ['Step 1 done'],
            evidence_commands: ['echo 1'],
          },
          {
            id: 'T2',
            subject: 'Second task',
            owner: 'worker2',
            reviewers: ['reviewer1'],
            definition_of_done: ['Step 2 done'],
            evidence_commands: ['echo 2'],
          },
        ],
      },
      { agent: harness.lead },
    )

    let state = await store.readState(harness.lead)
    const t1 = state.items.find((it) => it.id === 'T1')
    const t2 = state.items.find((it) => it.id === 'T2')

    // T1 has worktree, T2 does NOT yet because T1 is still active
    assert.ok(t1.git?.worktreeBranch, 'T1 should have worktree')
    assert.equal(t2.git?.worktreeBranch, undefined, 'T2 must wait in serial mode')

    // Worker1 commits and reports
    await writeFile(join(t1.git.worktreePath, 'step1.txt'), 'step1\n')
    await gitTool.execute(
      { action: 'commit', item_id: 'T1', files: ['step1.txt'], message: 'feat: step 1' },
      { agent: worker1Agent },
    )
    await reportTool.execute(
      {
        item_id: 'T1',
        summary: 'Done step 1',
        files: ['step1.txt'],
        evidence: [{ command: 'echo 1', exit_code: 0, output: '1' }],
      },
      { agent: worker1Agent },
    )

    // Reviewer approves T1
    await reviewTool.execute(
      {
        item_id: 'T1',
        verdict: 'approve',
        summary: 'Step 1 approved',
        evidence_checked: ['step1.txt verified'],
      },
      { agent: reviewer1Agent },
    )

    // Now T1 is merged, so T2's worktree should be provisioned automatically
    state = await store.readState(harness.lead)
    const updatedT2 = state.items.find((it) => it.id === 'T2')
    assert.ok(updatedT2.git?.worktreeBranch, 'T2 worktree should be provisioned now that T1 is approved')
  })
})

test('worktreeIsolation off skips all worktree creation cleanly', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      worktreeIsolation: 'off',
      autoStaff: false,
    })
    const store = createStore({ ctx: harness.ctx, settings })

    const tools = buildTools({
      ctx: harness.ctx,
      settings,
      store,
      version: '1.18.0',
    })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    await planTool.execute(
      {
        objective: 'Test worktree disabled',
        acceptance_criteria: ['Runs without worktree'],
        items: [
          {
            id: 'T1',
            subject: 'Task without worktree',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            definition_of_done: ['Done'],
            evidence_commands: ['echo ok'],
          },
        ],
      },
      { agent: harness.lead },
    )

    const state = await store.readState(harness.lead)
    const t1 = state.items.find((it) => it.id === 'T1')
    assert.equal(t1.git?.worktreeBranch, undefined)
    assert.equal(t1.git?.worktreePath, undefined)

    const wtList = await Git.gitWorktreeList({ cwd: repo })
    assert.equal(wtList.worktrees.length, 1) // only the main repo checkout
  })
})

test('worktree auto-merge conflict is diagnosed and recovered via worktree_sync', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      autoWorktree: true,
      autoMergeWorktree: true,
      autoCleanupWorktrees: true,
      autoStaff: false,
    })
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({
      ctx: harness.ctx,
      settings,
      store,
      version: '1.23.0',
    })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')
    const gitTool = tools.find((t) => t.name === 'team_flow_git')

    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }
    const reviewer1Agent = { id: 'session-r1', session: { id: 'session-r1' } }

    // Plan 1 item
    await planTool.execute(
      {
        objective: 'Test conflict recovery',
        acceptance_criteria: ['Conflict handled'],
        items: [
          {
            id: 'T1',
            subject: 'Conflict task',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            definition_of_done: ['Resolved'],
            evidence_commands: ['cat shared.txt'],
          },
        ],
      },
      { agent: harness.lead },
    )

    let state = await store.readState(harness.lead)
    const t1 = state.items.find((it) => it.id === 'T1')
    assert.ok(t1.git?.worktreePath)

    // In parallel, write to shared.txt in the run branch
    const runBranch = state.git.branch
    await gitRun(repo, ['switch', runBranch])
    await writeFile(join(repo, 'shared.txt'), 'run branch content\n')
    await gitRun(repo, ['add', 'shared.txt'])
    await gitRun(repo, ['commit', '-m', 'feat: run branch commit'])
    await gitRun(repo, ['switch', 'main'])

    // Worker1 writes conflicting shared.txt inside its worktree
    const fileInWt = join(t1.git.worktreePath, 'shared.txt')
    await writeFile(fileInWt, 'worktree branch content\n')
    await gitTool.execute(
      {
        action: 'commit',
        item_id: 'T1',
        files: ['shared.txt'],
        message: 'feat: worktree conflicting commit',
      },
      { agent: worker1Agent },
    )

    // Worker1 submits report
    await reportTool.execute(
      {
        item_id: 'T1',
        summary: 'Finished shared.txt in worktree',
        files: ['shared.txt'],
        commands: [{ command: 'cat shared.txt', exit_code: 0, output: 'worktree branch content\n' }],
        evidence: ['evidence verified'],
      },
      { agent: worker1Agent },
    )

    // Reviewer1 approves report
    // autoMergeApprovedWorktree should run and detect conflict with run branch!
    await reviewTool.execute(
      {
        item_id: 'T1',
        verdict: 'approve',
        summary: 'Approved',
        evidence_checked: ['evidence verified'],
      },
      { agent: reviewer1Agent },
    )

    // Inspect state: item T1 should have worktreeMergeError recorded
    state = await store.readState(harness.lead)
    const conflictedT1 = state.items.find((it) => it.id === 'T1')
    assert.ok(conflictedT1.git?.worktreeMergeError, 'worktreeMergeError must be recorded')
    assert.match(conflictedT1.git.worktreeMergeError, /conflicts/i)

    // Now worker calls worktree_sync to pull from run branch and diagnose
    const syncRes = await gitTool.execute(
      {
        action: 'worktree_sync',
        item_id: 'T1',
      },
      { agent: worker1Agent },
    )
    assert.equal(syncRes.conflict, true)
    assert.ok(syncRes.conflicted_files.includes('shared.txt'))

    // Worker resolves conflict in worktree by updating shared.txt and committing
    await writeFile(fileInWt, 'merged content\n')
    await gitTool.execute(
      {
        action: 'commit',
        item_id: 'T1',
        files: ['shared.txt'],
        message: 'fix: resolve conflict with run branch',
      },
      { agent: worker1Agent },
    )

    // Lead executes merge for T1 worktree
    const mergeRes = await gitTool.execute(
      {
        action: 'merge',
        item_id: 'T1',
      },
      { agent: harness.lead },
    )
    assert.ok(mergeRes.item_git?.worktreeMergedAt)

    // Verify content on run branch is merged
    const finalContent = await gitRun(repo, ['show', `${runBranch}:shared.txt`])
    assert.equal(finalContent, 'merged content\n')
  })
})

test('getWorktreeDiffSummary falls back to path-scoped git diff when worktree is off', async () => {
  await withRepo(async ({ repo }) => {
    await writeFile(join(repo, 'README.md'), '# demo\n\nupdated without worktree\n')
    const diff = await getWorktreeDiffSummary({
      cwd: repo,
      state: { settings: { gitEnabled: false } },
      item: { report: { files: ['README.md'] } },
      maxLines: 120,
    })
    assert.ok(diff !== null, 'must produce diff summary without worktree')
    assert.match(diff, /Diff stat:/)
    assert.match(diff, /README\.md/)
    assert.match(diff, /\+updated without worktree/)

    // Non-git directory returns null gracefully
    const nonGit = await getWorktreeDiffSummary({
      cwd: tmpdir(),
      state: { settings: { gitEnabled: false } },
      item: { report: { files: ['README.md'] } },
    })
    assert.equal(nonGit, null)
  })
})

test('getWorktreeDiffSummary computes incremental diff using sinceSha when provided', async () => {
  await withRepo(async ({ repo }) => {
    await gitRun(repo, ['switch', '-c', 'agentteam/run-inc'])
    await gitRun(repo, ['switch', '-c', 'agentteam-wt/run-inc/T1'])
    await writeFile(join(repo, 'round1.txt'), 'round 1 content\n')
    await gitRun(repo, ['add', 'round1.txt'])
    await gitRun(repo, ['commit', '-m', 'feat: round 1'])
    const round1Sha = (await gitRun(repo, ['rev-parse', 'HEAD'])).trim()

    await writeFile(join(repo, 'round2.txt'), 'round 2 fix\n')
    await gitRun(repo, ['add', 'round2.txt'])
    await gitRun(repo, ['commit', '-m', 'fix: round 2'])

    const deltaDiff = await getWorktreeDiffSummary({
      cwd: repo,
      state: { settings: { gitEnabled: true }, git: { branch: 'agentteam/run-inc' } },
      item: { git: { worktreeBranch: 'agentteam-wt/run-inc/T1' } },
      maxLines: 120,
      sinceSha: round1Sha,
    })
    assert.ok(deltaDiff !== null)
    assert.match(deltaDiff, /round2\.txt/)
    assert.ok(!deltaDiff.includes('round1.txt'), 'incremental diff must exclude changes already reviewed in round 1')
  })
})

test('lazyWorktreeProvision defers Wave 1+ until Wave 0 merges into runBranch', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      autoWorktree: true,
      lazyWorktreeProvision: true,
      autoMergeWorktree: true,
      autoStaff: false,
    })
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: '2.1.0' })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')

    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }
    const reviewer1Agent = { id: 'session-r1', session: { id: 'session-r1' } }

    await planTool.execute(
      {
        objective: 'Verify lazy wave worktree provisioning',
        acceptance_criteria: ['W2 inherits W1 output'],
        items: [
          {
            id: 'W1',
            subject: 'Wave 0 base module',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            write_scopes: ['wave0.txt'],
            definition_of_done: ['Create wave0.txt'],
            evidence_commands: ['echo ok'],
          },
          {
            id: 'W2',
            subject: 'Wave 1 dependent module',
            owner: 'worker2',
            reviewers: ['reviewer1'],
            blocked_by: ['W1'],
            write_scopes: ['wave1.txt'],
            definition_of_done: ['Consume wave0.txt'],
            evidence_commands: ['echo ok'],
          },
        ],
      },
      { agent: harness.lead },
    )

    let state = await store.readState(harness.lead)
    const w1 = state.items.find((it) => it.id === 'W1')
    const w2Before = state.items.find((it) => it.id === 'W2')
    assert.ok(w1.git?.worktreePath, 'W1 (Wave 0) must be provisioned upfront')
    assert.equal(w2Before.git?.worktreePath ?? null, null, 'W2 (Wave 1) must be deferred until W1 merges')

    await writeFile(join(w1.git.worktreePath, 'wave0.txt'), 'from wave 0\n')
    await reportTool.execute(
      {
        item_id: 'W1',
        summary: 'Implemented wave 0',
        files: ['wave0.txt'],
        commands: [{ command: 'echo ok', exit_code: 0 }],
        evidence: ['wave0.txt created'],
      },
      { agent: worker1Agent },
    )

    await reviewTool.execute(
      {
        item_id: 'W1',
        verdict: 'approve',
        summary: 'Looks good',
        evidence_checked: ['diff verified'],
      },
      { agent: reviewer1Agent },
    )

    state = await store.readState(harness.lead)
    const w1After = state.items.find((it) => it.id === 'W1')
    const w2After = state.items.find((it) => it.id === 'W2')
    assert.ok(w1After.git?.worktreeMergedAt, 'W1 must be merged into runBranch')
    assert.ok(w2After.git?.worktreePath, 'W2 must be lazily provisioned after W1 merges')

    const inherited = await readFile(join(w2After.git.worktreePath, 'wave0.txt'), 'utf8')
    assert.equal(inherited, 'from wave 0\n', 'W2 worktree must be created from updated runBranch containing W1 changes')
  })
})

test('team_flow_report safely auto-commits uncommitted in-scope changes and preserves diff/merge', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      autoWorktree: true,
      autoCommitOnReport: true,
      autoMergeWorktree: true,
      autoStaff: false,
    })
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: '2.1.0' })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')

    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }
    const reviewer1Agent = { id: 'session-r1', session: { id: 'session-r1' } }

    await planTool.execute(
      {
        objective: 'Verify auto-commit on report',
        acceptance_criteria: ['Uncommitted in-scope changes are committed automatically'],
        items: [
          {
            id: 'T1',
            subject: 'Build feature without manual commit',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            write_scopes: ['src'],
            definition_of_done: ['Add src/feature.js'],
            evidence_commands: ['echo ok'],
          },
        ],
      },
      { agent: harness.lead },
    )

    let state = await store.readState(harness.lead)
    const t1 = state.items.find((it) => it.id === 'T1')
    await mkdir(join(t1.git.worktreePath, 'src'), { recursive: true })
    await writeFile(join(t1.git.worktreePath, 'src', 'feature.js'), 'export const ok = true\n')

    const reportRes = await reportTool.execute(
      {
        item_id: 'T1',
        summary: 'Implemented src/feature.js',
        files: [],
        commands: [{ command: 'echo ok', exit_code: 0 }],
        evidence: ['created src/feature.js'],
      },
      { agent: worker1Agent },
    )

    assert.equal(reportRes.auto_commit?.committed, true)
    assert.ok(reportRes.auto_commit?.sha)
    assert.ok(reportRes.auto_commit?.files.includes('src/feature.js'))

    state = await store.readState(harness.lead)
    const reportedT1 = state.items.find((it) => it.id === 'T1')
    assert.ok(reportedT1.report.files.includes('src/feature.js'))

    const diff = await getWorktreeDiffSummary({ cwd: repo, state, item: reportedT1, maxLines: 50 })
    assert.ok(diff && diff.includes('src/feature.js'), 'diff summary must include auto-committed file')

    await reviewTool.execute(
      {
        item_id: 'T1',
        verdict: 'approve',
        summary: 'Verified auto-committed diff',
        evidence_checked: ['diff inspected'],
      },
      { agent: reviewer1Agent },
    )

    const mergedContent = await gitRun(repo, ['show', `${state.git.branch}:src/feature.js`])
    assert.equal(mergedContent, 'export const ok = true\n')
  })
})

test('team_flow_report rejects dirty uncommitted files outside declared writeScopes', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      autoWorktree: true,
      autoCommitOnReport: true,
      autoStaff: false,
    })
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: '2.1.0' })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }

    await planTool.execute(
      {
        objective: 'Reject out-of-scope dirty worktree changes',
        acceptance_criteria: ['Out-of-scope edits rejected'],
        items: [
          {
            id: 'T1',
            subject: 'Scoped edit',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            write_scopes: ['src'],
            definition_of_done: ['Edit src only'],
            evidence_commands: ['echo ok'],
          },
        ],
      },
      { agent: harness.lead },
    )

    const state = await store.readState(harness.lead)
    const t1 = state.items.find((it) => it.id === 'T1')
    await mkdir(join(t1.git.worktreePath, 'docs'), { recursive: true })
    await writeFile(join(t1.git.worktreePath, 'docs', 'outside.md'), 'unauthorized edit\n')

    await assert.rejects(
      () =>
        reportTool.execute(
          {
            item_id: 'T1',
            summary: 'Attempted report with out-of-scope dirty file',
            files: ['docs/outside.md'],
            commands: [{ command: 'echo ok', exit_code: 0 }],
            evidence: ['edited'],
          },
          { agent: worker1Agent },
        ),
      /outside declared writeScopes.*docs\/outside\.md/,
    )

    const wtStatus = await Git.gitStatus({ cwd: t1.git.worktreePath })
    assert.equal(wtStatus.clean, false, 'out-of-scope file must remain uncommitted')
  })
})

test('autoMergeApprovedWorktree refuses silent merge when worktree has uncommitted changes', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      autoWorktree: true,
      autoCommitOnReport: false,
      autoMergeWorktree: true,
      autoStaff: false,
    })
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: '2.1.0' })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')

    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }
    const reviewer1Agent = { id: 'session-r1', session: { id: 'session-r1' } }

    await planTool.execute(
      {
        objective: 'Prevent silent loss on uncommitted worktree',
        acceptance_criteria: ['Dirty worktree blocks merge'],
        items: [
          {
            id: 'T1',
            subject: 'Dirty worktree check',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            write_scopes: ['src'],
            definition_of_done: ['Add src/uncommitted.js'],
            evidence_commands: ['echo ok'],
          },
        ],
      },
      { agent: harness.lead },
    )

    let state = await store.readState(harness.lead)
    const t1 = state.items.find((it) => it.id === 'T1')
    await mkdir(join(t1.git.worktreePath, 'src'), { recursive: true })
    await writeFile(join(t1.git.worktreePath, 'src', 'uncommitted.js'), 'export const dirty = true\n')

    await reportTool.execute(
      {
        item_id: 'T1',
        summary: 'Reported without committing while autoCommitOnReport is off',
        files: ['src/uncommitted.js'],
        commands: [{ command: 'echo ok', exit_code: 0 }],
        evidence: ['created file'],
      },
      { agent: worker1Agent },
    )

    await reviewTool.execute(
      {
        item_id: 'T1',
        verdict: 'approve',
        summary: 'Approved',
        evidence_checked: ['reviewed'],
      },
      { agent: reviewer1Agent },
    )

    state = await store.readState(harness.lead)
    const mergedAttempt = state.items.find((it) => it.id === 'T1')
    assert.equal(mergedAttempt.git?.worktreeMergedAt ?? null, null, 'dirty worktree must not be marked merged')
    assert.match(mergedAttempt.git?.worktreeMergeError ?? '', /uncommitted changes/i)

    const directMerge = await autoMergeApprovedWorktree({
      cwd: repo,
      state,
      itemId: 'T1',
      agent: harness.lead,
      store,
    })
    assert.equal(directMerge.ok, false)
    assert.equal(directMerge.dirty, true)
  })
})

test('post-merge integration gate passes on autoFinalize when merged branches work together', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      autoWorktree: true,
      autoMergeWorktree: true,
      autoCleanupWorktrees: true,
      autoFinalize: true,
      autoStaff: false,
      integrationVerifyCommands: [
        'node -e "import(\'./a.mjs\').then(async a => { const b = await import(\'./b.mjs\'); if (a.val + b.val !== 3) process.exit(1) })"',
      ],
    })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: '2.1.0' })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const gitTool = tools.find((t) => t.name === 'team_flow_git')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')

    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }
    const worker2Agent = { id: 'session-w2', session: { id: 'session-w2' } }
    const reviewer1Agent = { id: 'session-r1', session: { id: 'session-r1' } }

    await planTool.execute(
      {
        objective: 'Verify passing post-merge integration gate',
        acceptance_criteria: ['Integration command passes on runBranch'],
        items: [
          {
            id: 'T1',
            subject: 'Create a.mjs',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            write_scopes: ['a.mjs'],
            definition_of_done: ['Export val = 1'],
            evidence_commands: ['echo ok'],
          },
          {
            id: 'T2',
            subject: 'Create b.mjs',
            owner: 'worker2',
            reviewers: ['reviewer1'],
            write_scopes: ['b.mjs'],
            definition_of_done: ['Export val = 2'],
            evidence_commands: ['echo ok'],
          },
        ],
      },
      { agent: harness.lead },
    )

    let state = await store.readState(harness.lead)
    const t1 = state.items.find((it) => it.id === 'T1')
    const t2 = state.items.find((it) => it.id === 'T2')

    await writeFile(join(t1.git.worktreePath, 'a.mjs'), 'export const val = 1\n')
    await gitTool.execute({ action: 'commit', item_id: 'T1', files: ['a.mjs'], message: 'feat: add a.mjs' }, { agent: worker1Agent })
    await reportTool.execute(
      { item_id: 'T1', summary: 'Added a.mjs', files: ['a.mjs'], commands: [{ command: 'echo ok', exit_code: 0 }], evidence: ['ok'] },
      { agent: worker1Agent },
    )

    await writeFile(join(t2.git.worktreePath, 'b.mjs'), 'export const val = 2\n')
    await gitTool.execute({ action: 'commit', item_id: 'T2', files: ['b.mjs'], message: 'feat: add b.mjs' }, { agent: worker2Agent })
    await reportTool.execute(
      { item_id: 'T2', summary: 'Added b.mjs', files: ['b.mjs'], commands: [{ command: 'echo ok', exit_code: 0 }], evidence: ['ok'] },
      { agent: worker2Agent },
    )

    await reviewTool.execute({ item_id: 'T1', verdict: 'approve', summary: 'Approved', evidence_checked: ['diff'] }, { agent: reviewer1Agent })
    await reviewTool.execute({ item_id: 'T2', verdict: 'approve', summary: 'Approved', evidence_checked: ['diff'] }, { agent: reviewer1Agent })

    const res = await orchestrator.reconcile(harness.lead, { force: true })
    assert.equal(res.finalized, true)

    state = await store.readState(harness.lead)
    assert.equal(state.phase, 'finalized')
    assert.equal(state.integrationGate?.pass, true)
    assert.ok(state.events.some((e) => e.type === 'gate/integration-passed'))
  })
})

test('post-merge integration gate failure blocks autoFinalize and notifies Lead', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      autoWorktree: true,
      autoMergeWorktree: true,
      autoCleanupWorktrees: true,
      autoFinalize: true,
      autoStaff: false,
      integrationVerifyCommands: [
        'node -e "import(\'./api.mjs\').then(async api => { const c = await import(\'./consumer.mjs\'); if (!c.check(api)) { console.error(\'API mismatch\'); process.exit(1) } })"',
      ],
    })
    const store = createStore({ ctx: harness.ctx, settings })
    const orchestrator = createOrchestrator({ ctx: harness.ctx, store, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: '2.1.0' })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const gitTool = tools.find((t) => t.name === 'team_flow_git')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')

    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }
    const worker2Agent = { id: 'session-w2', session: { id: 'session-w2' } }
    const reviewer1Agent = { id: 'session-r1', session: { id: 'session-r1' } }

    await planTool.execute(
      {
        objective: 'Detect cross-branch integration breakage before autoFinalize',
        acceptance_criteria: ['Broken merge blocked before finalize'],
        items: [
          {
            id: 'T1',
            subject: 'API v1',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            write_scopes: ['api.mjs'],
            definition_of_done: ['Export version v1'],
            evidence_commands: ['echo ok'],
          },
          {
            id: 'T2',
            subject: 'Consumer expecting v2',
            owner: 'worker2',
            reviewers: ['reviewer1'],
            write_scopes: ['consumer.mjs'],
            definition_of_done: ['Check version'],
            evidence_commands: ['echo ok'],
          },
        ],
      },
      { agent: harness.lead },
    )

    let state = await store.readState(harness.lead)
    const t1 = state.items.find((it) => it.id === 'T1')
    const t2 = state.items.find((it) => it.id === 'T2')

    await writeFile(join(t1.git.worktreePath, 'api.mjs'), 'export const version = 1\n')
    await gitTool.execute({ action: 'commit', item_id: 'T1', files: ['api.mjs'], message: 'feat: api v1' }, { agent: worker1Agent })
    await reportTool.execute(
      { item_id: 'T1', summary: 'API v1', files: ['api.mjs'], commands: [{ command: 'echo ok', exit_code: 0 }], evidence: ['ok'] },
      { agent: worker1Agent },
    )

    await writeFile(join(t2.git.worktreePath, 'consumer.mjs'), 'export const check = (api) => api.version === 2\n')
    await gitTool.execute({ action: 'commit', item_id: 'T2', files: ['consumer.mjs'], message: 'feat: consumer v2' }, { agent: worker2Agent })
    await reportTool.execute(
      { item_id: 'T2', summary: 'Consumer v2', files: ['consumer.mjs'], commands: [{ command: 'echo ok', exit_code: 0 }], evidence: ['ok'] },
      { agent: worker2Agent },
    )

    await reviewTool.execute({ item_id: 'T1', verdict: 'approve', summary: 'Approved', evidence_checked: ['diff'] }, { agent: reviewer1Agent })
    await reviewTool.execute({ item_id: 'T2', verdict: 'approve', summary: 'Approved', evidence_checked: ['diff'] }, { agent: reviewer1Agent })

    harness.messages.length = 0
    const res = await orchestrator.reconcile(harness.lead, { force: true })
    assert.equal(res.finalized, false)
    assert.equal(res.integrationFailed, true)
    assert.ok(res.actionsTaken.some((a) => a.type === 'integration-gate-failed'))

    state = await store.readState(harness.lead)
    assert.notEqual(state.phase, 'finalized')
    assert.equal(state.integrationGate?.pass, false)
    assert.match(state.integrationGate?.summary ?? '', /API mismatch|exit 1/)
    assert.ok(state.events.some((e) => e.type === 'gate/integration-failed'))

    const leadNotice = harness.messages.find((m) => m.target === 'lead' && m.text.includes('INTEGRATION_GATE_FAILED'))
    assert.ok(leadNotice, 'Lead must be notified when integration gate fails')
  })
})

test('post-merge integration gate failure blocks team_flow_gate finalize', async () => {
  await withRepo(async ({ repo }) => {
    const harness = createHarness(repo)
    const settings = resolveSettings({
      gitEnabled: true,
      gitBaseBranch: 'main',
      worktreeIsolation: 'parallel',
      autoWorktree: true,
      autoMergeWorktree: true,
      autoCleanupWorktrees: true,
      autoStaff: false,
      integrationVerifyCommands: [
        'node -e "import(\'./api.mjs\').then(async api => { const c = await import(\'./consumer.mjs\'); if (!c.check(api)) process.exit(1) })"',
      ],
    })
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: '2.1.0' })

    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const gitTool = tools.find((t) => t.name === 'team_flow_git')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')
    const gateTool = tools.find((t) => t.name === 'team_flow_gate')

    const worker1Agent = { id: 'session-w1', session: { id: 'session-w1' } }
    const worker2Agent = { id: 'session-w2', session: { id: 'session-w2' } }
    const reviewer1Agent = { id: 'session-r1', session: { id: 'session-r1' } }

    await planTool.execute(
      {
        objective: 'Verify team_flow_gate blocks finalize on integration failure',
        acceptance_criteria: ['Manual gate finalize blocked'],
        items: [
          {
            id: 'T1',
            subject: 'API v1',
            owner: 'worker1',
            reviewers: ['reviewer1'],
            write_scopes: ['api.mjs'],
            definition_of_done: ['Export version v1'],
            evidence_commands: ['echo ok'],
          },
          {
            id: 'T2',
            subject: 'Consumer expecting v2',
            owner: 'worker2',
            reviewers: ['reviewer1'],
            write_scopes: ['consumer.mjs'],
            definition_of_done: ['Check version'],
            evidence_commands: ['echo ok'],
          },
        ],
      },
      { agent: harness.lead },
    )

    let state = await store.readState(harness.lead)
    const t1 = state.items.find((it) => it.id === 'T1')
    const t2 = state.items.find((it) => it.id === 'T2')

    await writeFile(join(t1.git.worktreePath, 'api.mjs'), 'export const version = 1\n')
    await gitTool.execute({ action: 'commit', item_id: 'T1', files: ['api.mjs'], message: 'feat: api v1' }, { agent: worker1Agent })
    await reportTool.execute(
      { item_id: 'T1', summary: 'API v1', files: ['api.mjs'], commands: [{ command: 'echo ok', exit_code: 0 }], evidence: ['ok'] },
      { agent: worker1Agent },
    )

    await writeFile(join(t2.git.worktreePath, 'consumer.mjs'), 'export const check = (api) => api.version === 2\n')
    await gitTool.execute({ action: 'commit', item_id: 'T2', files: ['consumer.mjs'], message: 'feat: consumer v2' }, { agent: worker2Agent })
    await reportTool.execute(
      { item_id: 'T2', summary: 'Consumer v2', files: ['consumer.mjs'], commands: [{ command: 'echo ok', exit_code: 0 }], evidence: ['ok'] },
      { agent: worker2Agent },
    )

    await reviewTool.execute({ item_id: 'T1', verdict: 'approve', summary: 'Approved', evidence_checked: ['diff'] }, { agent: reviewer1Agent })
    await reviewTool.execute({ item_id: 'T2', verdict: 'approve', summary: 'Approved', evidence_checked: ['diff'] }, { agent: reviewer1Agent })

    await assert.rejects(
      () => gateTool.execute({ finalize: true }, { agent: harness.lead }),
      /integration gate failed/,
    )

    state = await store.readState(harness.lead)
    assert.notEqual(state.phase, 'finalized')
    assert.equal(state.integrationGate?.pass, false)
    assert.ok(state.events.some((e) => e.type === 'gate/integration-failed'))
  })
})
