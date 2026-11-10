/**
 * Zero-import Git repository inspection & DAG layout engine for DSH.
 *
 * Runs native `git` commands via `node:child_process` and builds a structured,
 * topological commit graph with swimlane assignments and Bezier curves.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Palette for distinct branch swimlanes in the graph */
export const LANE_PALETTE = [
  '#38bdf8', // Cyan / Sky
  '#818cf8', // Indigo
  '#34d399', // Emerald
  '#fbbf24', // Amber
  '#f472b6', // Rose
  '#a78bfa', // Violet / Purple
  '#fb923c', // Orange
  '#2dd4bf', // Teal
]

const RECORD_SEP = '\x1f' // Unit separator for git log format fields
const ROW_HEIGHT = 40
const LANE_WIDTH = 22
const LEFT_OFFSET = 18

/**
 * Execute a git command safely in target directory with timeout.
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function runGit(args, cwd, timeoutMs = 5000) {
  try {
    return await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        LC_ALL: 'C',
        GIT_OPTIONAL_LOCKS: '0',
      },
    })
  } catch (error) {
    if (error && typeof error === 'object') {
      const err = new Error(error.stderr || error.message || 'git command failed')
      err.code = error.code
      err.stdout = error.stdout || ''
      err.stderr = error.stderr || ''
      throw err
    }
    throw error
  }
}

/**
 * Check if target directory is inside a git repository.
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
export async function isGitRepository(cwd) {
  try {
    const { stdout } = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, 2000)
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Parse porcelain v2 git status into structured status metadata.
 * @param {string} rawStatus
 * @returns {object}
 */
export function parseGitStatus(rawStatus) {
  let headOid = ''
  let headBranch = ''
  let upstream = null
  let ahead = 0
  let behind = 0
  let staged = 0
  let unstaged = 0
  let untracked = 0
  const files = []

  const lines = rawStatus.split('\n')
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('# branch.oid ')) {
      headOid = line.slice(13).trim()
    } else if (line.startsWith('# branch.head ')) {
      headBranch = line.slice(14).trim()
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice(18).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+-(\d+)/)
      if (match) {
        ahead = parseInt(match[1], 10)
        behind = parseInt(match[2], 10)
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // Ordinary or renamed changed entry:
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = line.split(' ')
      const xy = parts[1] || '..'
      const path = parts.slice(8).join(' ')
      const stagedChar = xy[0]
      const unstagedChar = xy[1]

      const isStaged = stagedChar !== '.' && stagedChar !== '?'
      const isUnstaged = unstagedChar !== '.' && unstagedChar !== '?'

      if (isStaged) staged++
      if (isUnstaged) unstaged++

      files.push({
        path,
        xy,
        staged: isStaged,
        unstaged: isUnstaged,
        status: translateStatus(xy),
      })
    } else if (line.startsWith('? ')) {
      untracked++
      const path = line.slice(2).trim()
      files.push({
        path,
        xy: '??',
        staged: false,
        unstaged: true,
        status: 'untracked',
      })
    }
  }

  const isDetached = headBranch === '(detached)'
  const totalChanged = staged + unstaged + untracked

  return {
    headOid,
    headBranch: isDetached ? `DETACHED (${headOid.slice(0, 7)})` : headBranch,
    isDetached,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    totalChanged,
    isDirty: totalChanged > 0,
    files: files.slice(0, 50), // Cap files list to 50 items for bounded payload
  }
}

function translateStatus(xy) {
  if (xy === '??') return 'untracked'
  const s = xy[0] !== '.' ? xy[0] : xy[1]
  switch (s) {
    case 'M': return 'modified'
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'U': return 'unmerged'
    default: return 'changed'
  }
}

/**
 * Parse refs decoration string (from %D) into typed ref badges.
 * e.g. "HEAD -> main, origin/main, origin/HEAD, tag: v1.0.0"
 * @param {string} rawRefs
 * @returns {Array<{ type: 'head'|'branch'|'remote'|'tag', name: string }>}
 */
export function parseRefs(rawRefs) {
  if (!rawRefs || !rawRefs.trim()) return []
  const items = rawRefs.split(',').map((r) => r.trim()).filter(Boolean)
  const results = []

  for (const item of items) {
    if (item.startsWith('HEAD -> ')) {
      results.push({ type: 'head', name: item.slice(8) })
    } else if (item === 'HEAD') {
      results.push({ type: 'head', name: 'HEAD' })
    } else if (item.startsWith('tag: ')) {
      results.push({ type: 'tag', name: item.slice(5) })
    } else if (item.startsWith('origin/') || item.includes('/')) {
      if (!item.endsWith('/HEAD')) {
        results.push({ type: 'remote', name: item })
      }
    } else {
      results.push({ type: 'branch', name: item })
    }
  }
  return results
}

/**
 * Format timestamp into human-readable relative time (e.g. "5m ago").
 * @param {string} isoString
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatRelativeTime(isoString, nowMs = Date.now()) {
  const diffSec = Math.floor((nowMs - new Date(isoString).getTime()) / 1000)
  if (Number.isNaN(diffSec) || diffSec < 0) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths < 12) return `${diffMonths}mo ago`
  return `${Math.floor(diffDays / 365)}y ago`
}

/**
 * Topologically layout raw commits into swimlane DAG coordinates.
 *
 * @param {Array<{ hash: string, shortHash: string, parents: string[], author: string, email: string, date: string, subject: string, rawRefs: string }>} rawCommits
 * @param {object} status
 * @returns {{ nodes: any[], connections: any[], maxLane: number, totalHeight: number }}
 */
export function layoutGitGraph(rawCommits, status) {
  const commitMap = new Map()
  const childrenMap = new Map()

  for (const c of rawCommits) {
    commitMap.set(c.hash, c)
    for (const p of c.parents) {
      if (!childrenMap.has(p)) childrenMap.set(p, [])
      childrenMap.get(p).push(c.hash)
    }
  }

  // Active lanes tracker: index is column slot, value is expected next parent hash
  const activeLanes = []
  const nodes = []
  const connections = []
  let maxLane = 0

  let rowIndex = 0

  // 1. If repository is dirty, prepend a Working Changes virtual node at rowIndex 0
  if (status && status.isDirty) {
    const workingLane = 0
    const workingX = LEFT_OFFSET + workingLane * LANE_WIDTH
    const workingY = ROW_HEIGHT * (rowIndex + 1)
    maxLane = Math.max(maxLane, workingLane)

    nodes.push({
      hash: 'working-tree',
      shortHash: 'changes',
      isWorkingTree: true,
      parents: status.headOid ? [status.headOid] : [],
      author: 'Working Directory',
      email: '',
      date: new Date().toISOString(),
      relativeTime: 'now',
      subject: `Uncommitted Changes (${status.staged} staged, ${status.unstaged} unstaged, ${status.untracked} untracked)`,
      refs: [{ type: 'head', name: status.headBranch || 'working tree' }],
      isHead: false,
      isMerge: false,
      lane: workingLane,
      color: '#f59e0b', // Amber/Yellow
      x: workingX,
      y: workingY,
    })

    // Reserve lane 0 for head connection
    activeLanes[0] = status.headOid
    rowIndex++
  }

  // 2. Layout regular commits
  for (const c of rawCommits) {
    // Find if this commit was expected in any active lane
    let assignedLane = activeLanes.indexOf(c.hash)

    if (assignedLane === -1) {
      // Find the first free slot
      const freeIdx = activeLanes.indexOf(null)
      if (freeIdx !== -1) {
        assignedLane = freeIdx
      } else {
        assignedLane = activeLanes.length
      }
    }

    maxLane = Math.max(maxLane, assignedLane)
    activeLanes[assignedLane] = null // Free current spot

    const isHead = c.hash === status?.headOid
    const isMerge = c.parents.length > 1
    const refs = parseRefs(c.rawRefs)
    const color = LANE_PALETTE[assignedLane % LANE_PALETTE.length]
    const x = LEFT_OFFSET + assignedLane * LANE_WIDTH
    const y = ROW_HEIGHT * (rowIndex + 1)

    nodes.push({
      hash: c.hash,
      shortHash: c.shortHash,
      isWorkingTree: false,
      parents: c.parents,
      author: c.author,
      email: c.email,
      date: c.date,
      relativeTime: formatRelativeTime(c.date),
      subject: c.subject,
      refs,
      isHead,
      isMerge,
      lane: assignedLane,
      color,
      x,
      y,
    })

    // Update active lanes for parents
    for (let pIdx = 0; pIdx < c.parents.length; pIdx++) {
      const parentHash = c.parents[pIdx]
      if (pIdx === 0) {
        // Primary parent stays in the same lane if free, or first free lane
        if (activeLanes[assignedLane] === null || activeLanes[assignedLane] === undefined) {
          activeLanes[assignedLane] = parentHash
        } else {
          const nextFree = activeLanes.indexOf(null)
          if (nextFree !== -1) activeLanes[nextFree] = parentHash
          else activeLanes.push(parentHash)
        }
      } else {
        // Secondary/merge parents go to another lane
        const nextFree = activeLanes.indexOf(null)
        if (nextFree !== -1) {
          activeLanes[nextFree] = parentHash
          maxLane = Math.max(maxLane, nextFree)
        } else {
          activeLanes.push(parentHash)
          maxLane = Math.max(maxLane, activeLanes.length - 1)
        }
      }
    }

    // Compress trailing empty lanes
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop()
    }

    rowIndex++
  }

  // 3. Generate connection Bezier curves between child node and parent node
  const nodeLookup = new Map()
  for (const n of nodes) nodeLookup.set(n.hash, n)

  for (const n of nodes) {
    for (const pHash of n.parents) {
      const parentNode = nodeLookup.get(pHash)
      if (parentNode) {
        const x1 = n.x
        const y1 = n.y
        const x2 = parentNode.x
        const y2 = parentNode.y

        let path = ''
        if (x1 === x2) {
          path = `M ${x1} ${y1} L ${x2} ${y2}`
        } else {
          const cy = (y1 + y2) / 2
          path = `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`
        }

        connections.push({
          fromHash: n.hash,
          toHash: pHash,
          color: n.color,
          path,
          isMerge: n.isMerge && n.parents.indexOf(pHash) > 0,
        })
      }
    }
  }

  return {
    nodes,
    connections,
    maxLane,
    totalWidth: LEFT_OFFSET * 2 + (maxLane + 1) * LANE_WIDTH,
    totalHeight: ROW_HEIGHT * (rowIndex + 1),
  }
}

/**
 * Retrieve a complete Git snapshot of current repository.
 *
 * @param {string} cwd - Directory to inspect
 * @param {number} [limit=60] - Max commits to load
 * @returns {Promise<object>} Complete Git snapshot
 */
export async function getGitSnapshot(cwd, limit = 60) {
  const isRepo = await isGitRepository(cwd)
  if (!isRepo) {
    return {
      ok: true,
      isGitRepo: false,
      cwd,
      error: 'Not a git repository (or git is not installed)',
      generatedAt: new Date().toISOString(),
    }
  }

  // Get top level repo root
  let repoRoot = cwd
  try {
    const { stdout } = await runGit(['rev-parse', '--show-toplevel'], cwd, 2000)
    repoRoot = stdout.trim() || cwd
  } catch {
    /* fallback to cwd */
  }

  // Get status
  let status = { isDirty: false, staged: 0, unstaged: 0, untracked: 0, headBranch: 'unknown', headOid: '' }
  try {
    const { stdout: statusRaw } = await runGit(['status', '--porcelain=v2', '--branch'], repoRoot, 3000)
    status = parseGitStatus(statusRaw)
  } catch {
    /* status query best-effort */
  }

  // Get log commits
  const format = `%H${RECORD_SEP}%h${RECORD_SEP}%P${RECORD_SEP}%an${RECORD_SEP}%ae${RECORD_SEP}%aI${RECORD_SEP}%s${RECORD_SEP}%D`
  let rawCommits = []
  try {
    const { stdout: logRaw } = await runGit(
      ['log', `-${limit}`, '--all', '--date=iso-strict', `--format=${format}`],
      repoRoot,
      4000
    )

    const rawLines = logRaw.trim().split('\n')
    for (const line of rawLines) {
      if (!line) continue
      const fields = line.split(RECORD_SEP)
      if (fields.length >= 7) {
        rawCommits.push({
          hash: fields[0],
          shortHash: fields[1],
          parents: fields[2] ? fields[2].split(' ').filter(Boolean) : [],
          author: fields[3],
          email: fields[4],
          date: fields[5],
          subject: fields[6],
          rawRefs: fields[7] || '',
        })
      }
    }
  } catch {
    /* log query might fail on fresh empty repo with no commits */
  }

  // Get branches list
  let branches = []
  try {
    const { stdout: branchOut } = await runGit(['branch', '--list', '--no-color'], repoRoot, 2000)
    branches = branchOut
      .split('\n')
      .map((b) => b.replace(/^\*?\s+/, '').trim())
      .filter((b) => b && !b.startsWith('('))
  } catch {
    /* branches query best-effort */
  }

  // Build DAG layout
  const graph = layoutGitGraph(rawCommits, status)

  return {
    ok: true,
    isGitRepo: true,
    cwd,
    repoRoot,
    generatedAt: new Date().toISOString(),
    status,
    branches,
    graph,
  }
}
