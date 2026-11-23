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

const slug = (val) => String(val).replace(/[^A-Za-z0-9._/-]+/g, '-')

async function ensureExcludeAgentteam(status, cwd) {
  try {
    const fs = await import('node:fs/promises')
    const excludePath = path.join(status.root ?? cwd, '.git', 'info', 'exclude')
    const currentExclude = await fs.readFile(excludePath, 'utf8').catch(() => '')
    if (!currentExclude.includes('.agentteam')) {
      await fs.appendFile(excludePath, '\n.agentteam/\n', 'utf8').catch(() => {})
    }
  } catch {}
}

async function ensureRunBranch({ cwd, state, agent, store }) {
  let runBranch = state.git?.branch
  const base = state.settings.gitBaseBranch ?? 'main'
  if (typeof runBranch === 'string' && runBranch.length > 0) {
    return { ok: true, runBranch }
  }
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
  return { ok: true, runBranch }
}

async function recordProvisionedWorktrees({ agent, store, provisioned }) {
  if (provisioned.length === 0) return
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
          worktreeBase: p.runBranch,
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

function execGitRaw(cwd, args, maxBuffer = 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5000, maxBuffer, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(typeof stdout === 'string' ? stdout : null)
    })
  })
}

/**
 * List dirty (staged, unstaged, or untracked) normalized file paths inside a worktree.
 * Avoids trimming the full stdout so the leading porcelain status space is preserved.
 */
async function listDirtyWorktreeFiles(wtPath) {
  if (typeof wtPath !== 'string' || wtPath.length === 0) return []
  const raw = await execGitRaw(wtPath, ['status', '--porcelain', '-uall'])
  if (raw === null || raw.length === 0) return []
  const files = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.length < 4) continue
    let entry = line.slice(3)
    const arrowIdx = entry.indexOf(' -> ')
    if (arrowIdx !== -1) entry = entry.slice(arrowIdx + 4)
    entry = entry.trim()
    if (entry.startsWith('"') && entry.endsWith('"') && entry.length >= 2) {
      entry = entry.slice(1, -1)
    }
    const normalized = W.normalizePath(entry)
    if (normalized.length === 0) continue
    if (normalized === '.agentteam' || normalized.startsWith('.agentteam/')) continue
    files.push(normalized)
  }
  return [...new Set(files)]
}

/**
 * Automatically create the run branch and isolated worktrees for unblocked items in the run.
 * When `lazyWorktreeProvision` is enabled, downstream items wait until upstream dependencies merge.
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

  await ensureExcludeAgentteam(status, cwd)

  const mode = state.settings.worktreeIsolation // 'parallel' | 'serial'
  const lazyWaves = state.settings.lazyWorktreeProvision !== false
  const approvedIds = new Set(
    (state.items ?? []).filter((it) => it.status === W.ITEM_STATUS.APPROVED).map((it) => it.id),
  )

  const branchRes = await ensureRunBranch({ cwd, state, agent, store })
  if (!branchRes.ok) return { ok: false, error: branchRes.error }
  const runBranch = branchRes.runBranch

  const provisioned = []
  for (const item of state.items ?? []) {
    if (item.git?.worktreeBranch) continue
    if (lazyWaves) {
      const blockers = Array.isArray(item.blockedBy) ? item.blockedBy : []
      if (!blockers.every((bid) => approvedIds.has(bid))) continue
    }
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
      provisioned.push({ id: item.id, relative, absolute, branch, runBranch })
    }
  }

  await recordProvisionedWorktrees({ agent, store, provisioned })

  return { ok: true, provisioned }
}

/**
 * Lazily provision an isolated worktree for a single unblocked item from the latest run branch.
 * @param options - `{ cwd, state, itemId, agent, store }`
 * @returns `{ ok, skipped?, alreadyExists?, itemId?, relative?, worktreePath?, branch? }`
 */
export async function ensureItemWorktree({ cwd, state, itemId, agent, store }) {
  if (
    !state?.settings?.gitEnabled ||
    state?.settings?.worktreeIsolation === 'off' ||
    state?.settings?.autoWorktree === false
  ) {
    return { ok: false, skipped: true }
  }

  const item = (state.items ?? []).find((it) => it.id === itemId)
  if (!item) return { ok: false, reason: 'item_not_found' }

  if (item.git?.worktreeBranch && item.git?.worktreePath) {
    return {
      ok: true,
      alreadyExists: true,
      itemId: item.id,
      branch: item.git.worktreeBranch,
      worktreePath: item.git.worktreePath,
    }
  }

  if (state.settings.worktreeIsolation === 'serial') {
    const otherActive = (state.items ?? []).find(
      (it) => it.id !== item.id && it.git?.worktreeBranch && !it.git?.worktreeMergedAt,
    )
    if (otherActive) return { ok: false, skipped: true, reason: 'serial_busy' }
  }

  const status = await G.gitStatus({ cwd })
  if (!status.ok) return { ok: false, reason: 'not_git_repo' }
  await ensureExcludeAgentteam(status, cwd)

  const branchRes = await ensureRunBranch({ cwd, state, agent, store })
  if (!branchRes.ok) return { ok: false, error: branchRes.error }
  const runBranch = branchRes.runBranch

  const relative = `.agentteam/worktrees/${state.runId}/${item.id}`.replace(/[^A-Za-z0-9._/-]+/g, '-')
  const branch = slug(`agentteam-wt/${state.runId}/${item.id}`)
  const added = await G.gitWorktreeAdd({ cwd, path: relative, branch, startPoint: runBranch })
  if (added.ok !== true) {
    return { ok: false, error: added.error ?? 'gitWorktreeAdd failed' }
  }

  const absolute = path.resolve(cwd, relative)
  await recordProvisionedWorktrees({
    agent,
    store,
    provisioned: [{ id: item.id, relative, absolute, branch, runBranch }],
  })

  return { ok: true, itemId: item.id, relative, worktreePath: absolute, branch }
}

/**
 * Safely auto-commit dirty changes inside an item's isolated worktree if all
 * modified/untracked files lie within the item's declared `writeScopes`.
 * @param options - `{ cwd, state, item }`
 * @returns `{ ok, skipped?, clean?, committed?, sha?, files?, outOfScope?, outside?, dirtyFiles?, error? }`
 */
export async function autoCommitWorktreeIfSafe({ cwd, state, item }) {
  if (
    !state?.settings?.gitEnabled ||
    state?.settings?.autoCommitOnReport === false ||
    !item?.git?.worktreePath
  ) {
    return { ok: true, skipped: true }
  }

  const dirtyFiles = await listDirtyWorktreeFiles(item.git.worktreePath)
  if (dirtyFiles.length === 0) {
    return { ok: true, clean: true, committed: false, files: [] }
  }

  const scopes = Array.isArray(item.writeScopes) ? item.writeScopes : []
  if (scopes.length > 0) {
    const outside = dirtyFiles.filter((f) => !scopes.some((s) => W.pathInScope(f, s)))
    if (outside.length > 0) {
      return {
        ok: false,
        outOfScope: true,
        outside,
        dirtyFiles,
        error: `uncommitted files outside declared writeScopes: ${outside.join(', ')}`,
      }
    }
  }

  const committed = await G.gitCommit({
    cwd: item.git.worktreePath,
    files: dirtyFiles,
    message: `agentteam(${item.id}): auto-commit on report`,
    base: state.settings?.gitBaseBranch ?? 'main',
  })
  if (committed.ok !== true) {
    return { ok: false, error: committed.error ?? 'gitCommit failed', dirtyFiles }
  }

  return {
    ok: true,
    clean: false,
    committed: true,
    sha: committed.sha,
    files: committed.files,
  }
}

/**
 * Automatically merge an approved item's worktree branch into the team run branch.
 * @param options - `{ cwd, state, itemId, agent, store }`
 * @returns `{ ok, skipped?, dirty?, conflict?, itemId?, mergedAt?, error? }`
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

  await ensureExcludeAgentteam(status, cwd)

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

  if (item.git?.worktreePath) {
    const dirtyFiles = await listDirtyWorktreeFiles(item.git.worktreePath)
    if (dirtyFiles.length > 0) {
      const error = `worktree has uncommitted changes (${dirtyFiles.join(', ')}); commit them before merging`
      await store.mutateState(agent, (current) => {
        W.ensureCollaboration(current)
        const target = W.findItem(current, item.id)
        if (target) {
          target.git = {
            ...(target.git ?? {}),
            worktreeMergeError: error,
          }
          W.appendEvent(current, {
            at: new Date().toISOString(),
            type: 'git/worktree-merge-conflict',
            actor: 'worktree-manager',
            detail: `${target.id}: ${error}`,
          })
        }
        return current
      })
      return { ok: false, error, dirty: true }
    }
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

  await ensureExcludeAgentteam(status, cwd)

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

async function execGit(cwd, args, maxBuffer = 1024 * 1024) {
  const raw = await execGitRaw(cwd, args, maxBuffer)
  if (raw === null) return null
  const text = raw.trim()
  return text.length > 0 ? text : null
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
