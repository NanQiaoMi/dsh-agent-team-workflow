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
      return { ok: false, error: merged.error }
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
