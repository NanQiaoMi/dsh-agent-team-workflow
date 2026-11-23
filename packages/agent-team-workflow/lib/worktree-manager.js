/**
 * Automated Git Worktree Manager for Agent Teams.
 *
 * Implements Phase 2 of the Agent Team workflow:
 * 1. autoProvisionWorktrees: Automatically provisions isolated worktrees and
 *    dedicated branches for planned items so workers never write to the main checkout.
 * 2. autoMergeApprovedWorktree: Automatically merges an item's worktree branch
 *    into the team's run branch upon reviewer approval.
 * 3. autoCleanupRunWorktrees: Cleans up temporary worktrees when the run is finalized.
 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import * as G from './git.js'
import * as W from './workflow.js'

/**
 * Automatically create the run branch and isolated worktrees for all items in the run.
 * @param options - `{ cwd, state, agent, store }`
 * @returns `{ ok, skipped?, provisioned?: Array<{ id, relative, absolute, branch }> }`
 */
export async function autoProvisionWorktrees({ cwd, state, agent, store }) {
  if (
    !state?.settings?.gitEnabled ||
    state?.settings?.worktreeIsolation === 'off' ||
    state?.settings?.autoWorktree === false
  ) {
    return { ok: false, skipped: true }
  }

  const status = await G.gitStatus({ cwd })
  if (!status.ok) return { ok: false, reason: 'not_git_repo' }

  // Ensure .agentteam/ is locally excluded so worktree directories do not dirty git status
  try {
    const fs = await import('node:fs/promises')
    const excludePath = path.join(status.root ?? cwd, '.git', 'info', 'exclude')
    const currentExclude = await fs.readFile(excludePath, 'utf8').catch(() => '')
    if (!currentExclude.includes('.agentteam')) {
      await fs.appendFile(excludePath, '\n.agentteam/\n', 'utf8').catch(() => {})
    }
  } catch {}

  const mode = state.settings.worktreeIsolation // 'parallel' | 'serial'
  const slug = (val) => String(val).replace(/[^A-Za-z0-9._/-]+/g, '-')

  // 1. Ensure run branch exists
  let runBranch = state.git?.branch
  const base = state.settings.gitBaseBranch ?? 'main'
  if (typeof runBranch !== 'string' || runBranch.length === 0) {
    runBranch = `${state.settings.gitBranchPrefix ?? 'agentteam/'}${state.runId}`.replace(/[^A-Za-z0-9._/-]+/g, '-')
    const prepared = await G.gitEnsureBranch({ cwd, branch: runBranch, base })
    if (prepared.ok !== true) return { ok: false, error: prepared.error }
    await store.mutateState(agent, (current) => {
      W.ensureCollaboration(current)
      current.git = {
        branch: runBranch,
        base,
        remote: current.settings.gitRemote ?? 'origin',
        branchCreated: prepared.created === true,
        pushedAt: null,
        pr: null,
        mergedAt: null,
        mergeSha: null,
      }
      W.appendEvent(current, {
        at: new Date().toISOString(),
        type: 'git/prepared',
        actor: 'worktree-manager',
        detail: `${runBranch} (base ${base})`,
      })
      return current
    })
  }

  // 2. Provision worktrees for items
  const provisioned = []
  for (const item of state.items ?? []) {
    if (item.git?.worktreeBranch) continue
    if (mode === 'serial') {
      if (provisioned.length > 0) break
      const otherActive = state.items.find(
        (it) => it.id !== item.id && it.git?.worktreeBranch && !it.git?.worktreeMergedAt,
      )
      if (otherActive) break // in serial mode, only one active worktree allowed
    }

    const relative = `.agentteam/worktrees/${state.runId}/${item.id}`.replace(/[^A-Za-z0-9._/-]+/g, '-')
    const branch = slug(`agentteam-wt/${state.runId}/${item.id}`)
    const added = await G.gitWorktreeAdd({ cwd, path: relative, branch, startPoint: runBranch })
    if (added.ok === true) {
      const absolute = path.resolve(cwd, relative)
      provisioned.push({ id: item.id, relative, absolute, branch })
    }
  }

  if (provisioned.length > 0) {
    await store.mutateState(agent, (current) => {
      W.ensureCollaboration(current)
      for (const p of provisioned) {
        const target = W.findItem(current, p.id)
        if (target) {
          target.git = {
            ...(target.git ?? {}),
            worktree: p.relative,
            worktreePath: p.absolute,
            worktreeBranch: p.branch,
            worktreeBase: runBranch,
            worktreeCreatedAt: new Date().toISOString(),
          }
          W.appendEvent(current, {
            at: new Date().toISOString(),
            type: 'git/worktree',
            actor: 'worktree-manager',
            detail: `${target.id} ${p.relative}`,
          })
        }
      }
      return current
    })
  }

  return { ok: true, provisioned }
}

/**
 * Automatically merge an approved item's worktree branch into the team run branch.
 * @param options - `{ cwd, state, itemId, agent, store }`
 * @returns `{ ok, skipped?, itemId?, mergedAt? }`
 */
export async function autoMergeApprovedWorktree({ cwd, state, itemId, agent, store }) {
  if (
    !state?.settings?.gitEnabled ||
    state?.settings?.worktreeIsolation === 'off' ||
    state?.settings?.autoMergeWorktree === false
  ) {
    return { ok: false, skipped: true }
  }

  const status = await G.gitStatus({ cwd })
  if (!status.ok) return { ok: false, reason: 'not_git_repo' }

  // Ensure .agentteam/ is locally excluded so worktree directories do not dirty git status
  try {
    const fs = await import('node:fs/promises')
    const excludePath = path.join(status.root ?? cwd, '.git', 'info', 'exclude')
    const currentExclude = await fs.readFile(excludePath, 'utf8').catch(() => '')
    if (!currentExclude.includes('.agentteam')) {
      await fs.appendFile(excludePath, '\n.agentteam/\n', 'utf8').catch(() => {})
    }
  } catch {}

  const item = W.findItem(state, itemId)
  if (!item || !item.git?.worktreeBranch || item.git.worktreeMergedAt) {
    return { ok: false, skipped: true }
  }
  if (item.status !== W.ITEM_STATUS.APPROVED) {
    return { ok: false, reason: 'not_approved' }
  }
  if (!state.git?.branch) {
    return { ok: false, reason: 'no_run_branch' }
  }

  const merged = await G.gitMerge({
    cwd,
    branch: item.git.worktreeBranch,
    into: state.git.branch,
    method: 'squash',
    message: `agentteam(${item.id}): auto-merge worktree ${item.git.worktreeBranch}`,
  })
  if (merged.ok !== true) {
    if (typeof merged.error === 'string' && /nothing to commit/i.test(merged.error)) {
      // Worktree had no new changes; treat as merged cleanly
    } else {
      await store.mutateState(agent, (current) => {
        W.ensureCollaboration(current)
        const target = W.findItem(current, item.id)
        if (target) {
          target.git = {
            ...(target.git ?? {}),
            worktreeMergeError: merged.error,
          }
          W.appendEvent(current, {
            at: new Date().toISOString(),
            type: 'git/worktree-merge-conflict',
            actor: 'worktree-manager',
            detail: `${target.id}: ${merged.error}`,
          })
        }
        return current
      })
      return { ok: false, error: merged.error, conflict: true }
    }
  }

  const mergedAt = new Date().toISOString()
  await store.mutateState(agent, (current) => {
    W.ensureCollaboration(current)
    const target = W.findItem(current, item.id)
    if (target) {
      target.git = {
        ...(target.git ?? {}),
        worktreeMergedAt: mergedAt,
        worktreeMergeMethod: 'squash',
        worktreeMergeError: null,
      }
      W.appendEvent(current, {
        at: mergedAt,
        type: 'git/worktree-merged',
        actor: 'worktree-manager',
        detail: `${target.id} ${target.git.worktreeBranch}`,
      })
    }
    return current
  })

  return { ok: true, itemId: item.id, mergedAt }
}

/**
 * Automatically remove temporary worktrees when the run is finalized.
 * @param options - `{ cwd, state, agent, store }`
 * @returns `{ ok, skipped?, cleaned?: string[] }`
 */
export async function autoCleanupRunWorktrees({ cwd, state, agent, store }) {
  if (!state?.settings?.gitEnabled || state?.settings?.autoCleanupWorktrees === false) {
    return { ok: false, skipped: true }
  }

  const status = await G.gitStatus({ cwd })
  if (!status.ok) return { ok: false, reason: 'not_git_repo' }

  // Ensure .agentteam/ is locally excluded so worktree directories do not dirty git status
  try {
    const fs = await import('node:fs/promises')
    const excludePath = path.join(status.root ?? cwd, '.git', 'info', 'exclude')
    const currentExclude = await fs.readFile(excludePath, 'utf8').catch(() => '')
    if (!currentExclude.includes('.agentteam')) {
      await fs.appendFile(excludePath, '\n.agentteam/\n', 'utf8').catch(() => {})
    }
  } catch {}

  const cleaned = []
  for (const item of state.items ?? []) {
    if (typeof item.git?.worktree === 'string' && item.git.worktree.length > 0) {
      const removed = await G.gitWorktreeRemove({ cwd, path: item.git.worktree })
      if (removed.ok === true) {
        cleaned.push(item.id)
      }
    }
  }

  if (cleaned.length > 0) {
    await store.mutateState(agent, (current) => {
      W.ensureCollaboration(current)
      for (const id of cleaned) {
        const target = W.findItem(current, id)
        if (target?.git) {
          target.git.worktree = null
          target.git.worktreePath = null
          target.git.worktreeRemovedAt = new Date().toISOString()
        }
      }
      W.appendEvent(current, {
        at: new Date().toISOString(),
        type: 'git/worktrees-cleaned',
        actor: 'worktree-manager',
        detail: `${cleaned.length} worktree(s) removed`,
      })
      return current
    })
  }

  return { ok: true, cleaned }
}

function execGit(cwd, args, maxBuffer = 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5000, maxBuffer, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null)
      const text = typeof stdout === 'string' ? stdout.trim() : ''
      resolve(text.length > 0 ? text : null)
    })
  })
}

function formatDiffSummary(stat, diffOut, maxLines) {
  if (!diffOut) return `Diff stat:\n${stat}`
  const lines = diffOut.split('\n')
  const capped = lines.slice(0, maxLines).join('\n')
  const truncated = lines.length > maxLines ? `\n... (${lines.length - maxLines} more lines truncated)` : ''
  return `Diff stat:\n${stat}\n\nDiff patch:\n\`\`\`diff\n${capped}${truncated}\n\`\`\``
}

/**
 * Compute compact diff summary (diffstat and head patch) for an item's worktree
 * branch or, when worktrees are off, for the files declared in the report.
 * @param options - `{ cwd, state, item, maxLines, sinceSha }`
 * @returns Promise<string | null>
 */
export async function getWorktreeDiffSummary({ cwd, state, item, maxLines = 120, sinceSha = null } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const limit = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 120

  // 1. Isolated worktree branch diff (supports incremental sinceSha..wtBranch)
  if (state?.settings?.gitEnabled && item?.git?.worktreeBranch && state?.git?.branch) {
    const baseBranch = state.git.branch
    const wtBranch = item.git.worktreeBranch
    const validSince = typeof sinceSha === 'string' && /^[0-9a-f]{7,40}$/i.test(sinceSha.trim())
      ? sinceSha.trim()
      : null

    if (validSince !== null) {
      const incRange = `${validSince}..${wtBranch}`
      const incStat = await execGit(cwd, ['diff', '--stat', incRange])
      if (incStat !== null) {
        const incDiff = await execGit(cwd, ['diff', '-U2', incRange], 2 * 1024 * 1024)
        return formatDiffSummary(incStat, incDiff, limit)
      }
    }

    const fullRange = `${baseBranch}...${wtBranch}`
    const stat = await execGit(cwd, ['diff', '--stat', fullRange])
    if (stat === null) return null
    const diffOut = await execGit(cwd, ['diff', '-U2', fullRange], 2 * 1024 * 1024)
    return formatDiffSummary(stat, diffOut, limit)
  }

  // 2. Non-worktree fallback: path-scoped diff for reported files in cwd
  const rawFiles = Array.isArray(item?.report?.files) ? item.report.files : []
  const files = [...new Set(rawFiles.map((f) => String(f ?? '').trim()).filter((f) => f.length > 0 && !f.startsWith('-')))]
  if (files.length === 0) return null

  const inside = await execGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') return null

  let stat = await execGit(cwd, ['diff', 'HEAD', '--stat', '--', ...files])
  let useHead = stat !== null
  if (stat === null) {
    stat = await execGit(cwd, ['diff', '--stat', '--', ...files])
  }
  if (stat === null) return null

  const diffArgs = useHead ? ['diff', 'HEAD', '-U2', '--', ...files] : ['diff', '-U2', '--', ...files]
  const diffOut = await execGit(cwd, diffArgs, 2 * 1024 * 1024)
  return formatDiffSummary(stat, diffOut, limit)
}

function execGitResult(cwd, args, timeout = 15_000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const exitCode = err === null || err === undefined ? 0 : Number.isInteger(err.code) ? err.code : 1
      resolve({ exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * Normalize a `runIntegrationVerify` result into the persisted `state.integrationGate`
 * and `gate.integration` structure.
 */
export function toIntegrationGateRecord(integration) {
  return {
    pass: integration.ok === true,
    branch: integration.branch ?? null,
    ranAt: integration.ranAt ?? new Date().toISOString(),
    durationMs: Number.isFinite(integration.durationMs) ? integration.durationMs : 0,
    results: Array.isArray(integration.results) ? integration.results : [],
    summary: integration.summary ?? null,
  }
}

/**
 * Run post-merge integration verification commands against the run branch (using
 * an isolated detached temporary worktree when the main checkout is on another branch).
 * @param options - `{ cwd, state, timeoutMs? }`
 * @returns `{ ok, skipped, branch, ranAt?, durationMs?, results, error?, summary? }`
 */
export async function runIntegrationVerify({ cwd, state, timeoutMs = 120_000 } = {}) {
  const commands = Array.isArray(state?.settings?.integrationVerifyCommands)
    ? state.settings.integrationVerifyCommands.map((c) => String(c ?? '').trim()).filter((c) => c.length > 0)
    : []
  const runBranch = typeof state?.git?.branch === 'string' && state.git.branch.length > 0 ? state.git.branch : null

  if (commands.length === 0) {
    return { ok: true, skipped: true, branch: runBranch, commands: [], results: [] }
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return {
      ok: false,
      skipped: false,
      branch: runBranch,
      ranAt: new Date().toISOString(),
      durationMs: 0,
      results: [],
      error: 'integration verification requires a workspace cwd',
      summary: 'integration verification requires a workspace cwd',
    }
  }

  const startedAt = Date.now()
  let verifyCwd = cwd
  let tempWorktreeRel = null

  if (runBranch !== null) {
    const status = await G.gitStatus({ cwd })
    if (status.ok && status.branch !== runBranch) {
      await ensureExcludeAgentteamHelper(status, cwd)
      const safeRunId = String(state?.runId ?? 'run').replace(/[^A-Za-z0-9._-]+/g, '-')
      tempWorktreeRel = `.agentteam/worktrees/${safeRunId}/__integration__-${Date.now()}`
      const added = await execGitResult(cwd, ['worktree', 'add', '--detach', tempWorktreeRel, runBranch])
      if (added.exitCode !== 0) {
        const errMsg = (added.stderr || added.stdout || 'git worktree add --detach failed').trim()
        return {
          ok: false,
          skipped: false,
          branch: runBranch,
          ranAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          results: [],
          error: errMsg,
          summary: errMsg,
        }
      }
      verifyCwd = path.resolve(cwd, tempWorktreeRel)
    }
  }

  try {
    const verified = await G.gitVerify({ cwd: verifyCwd, commands, timeoutMs })
    const durationMs = Date.now() - startedAt
    const ranAt = new Date().toISOString()
    const results = Array.isArray(verified.results) ? verified.results : []
    if (verified.ok === true) {
      return { ok: true, skipped: false, branch: runBranch, ranAt, durationMs, results }
    }
    const failing = results.filter((r) => r.exitCode !== 0)
    const summary = failing.length > 0
      ? failing
          .map((r) => {
            const tail = String(r.outputTail ?? '').slice(-250).trim()
            return tail.length > 0 ? `${r.command} (exit ${r.exitCode}): ${tail}` : `${r.command} (exit ${r.exitCode})`
          })
          .join('; ')
      : (verified.error ?? 'integration verification failed')
    return {
      ok: false,
      skipped: false,
      branch: runBranch,
      ranAt,
      durationMs,
      results,
      error: verified.error ?? summary,
      summary,
    }
  } finally {
    if (tempWorktreeRel !== null) {
      await execGitResult(cwd, ['worktree', 'remove', '--force', tempWorktreeRel]).catch(() => {})
    }
  }
}

async function ensureExcludeAgentteamHelper(status, cwd) {
  try {
    const fs = await import('node:fs/promises')
    const excludePath = path.join(status.root ?? cwd, '.git', 'info', 'exclude')
    const currentExclude = await fs.readFile(excludePath, 'utf8').catch(() => '')
    if (!currentExclude.includes('.agentteam')) {
      await fs.appendFile(excludePath, '\n.agentteam/\n', 'utf8').catch(() => {})
    }
  } catch {}
}
