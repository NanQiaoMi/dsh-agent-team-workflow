import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseGitStatus,
  parseRefs,
  formatRelativeTime,
  layoutGitGraph,
  getGitSnapshot,
  getCommitDetails,
} from '../lib/git-engine.js'

test('parseGitStatus parses porcelain v2 status correctly', () => {
  const sample = `
# branch.oid 6fe0e3454ad39e30fb61b1d81820607ac0692d1c
# branch.head feature/dsh-git-graph
# branch.upstream origin/feature/dsh-git-graph
# branch.ab +2 -1
1 .M N... 100644 100644 100644 c4b2a8d c4b2a8d packages/dsh-git-graph/index.js
1 M. N... 100644 100644 100644 a1b2c3d a1b2c3d packages/dsh-git-graph/package.json
? packages/dsh-git-graph/test/new.txt
`
  const res = parseGitStatus(sample)
  assert.equal(res.headOid, '6fe0e3454ad39e30fb61b1d81820607ac0692d1c')
  assert.equal(res.headBranch, 'feature/dsh-git-graph')
  assert.equal(res.upstream, 'origin/feature/dsh-git-graph')
  assert.equal(res.ahead, 2)
  assert.equal(res.behind, 1)
  assert.equal(res.staged, 1)
  assert.equal(res.unstaged, 1)
  assert.equal(res.untracked, 1)
  assert.equal(res.totalChanged, 3)
  assert.equal(res.isDirty, true)
  assert.equal(res.files.length, 3)
})

test('parseGitStatus handles clean branch and detached head', () => {
  const cleanSample = `
# branch.oid aabbccdd
# branch.head main
`
  const cleanRes = parseGitStatus(cleanSample)
  assert.equal(cleanRes.headBranch, 'main')
  assert.equal(cleanRes.isDirty, false)
  assert.equal(cleanRes.totalChanged, 0)

  const detachedSample = `
# branch.oid 1234567890abcdef
# branch.head (detached)
`
  const detachedRes = parseGitStatus(detachedSample)
  assert.equal(detachedRes.isDetached, true)
  assert.match(detachedRes.headBranch, /DETACHED/)
})

test('parseRefs categorizes head, branch, remote, and tag', () => {
  const refsStr = 'HEAD -> feature/my-branch, origin/feature/my-branch, tag: v1.0.0, origin/HEAD, develop'
  const refs = parseRefs(refsStr)
  assert.deepEqual(refs, [
    { type: 'head', name: 'feature/my-branch' },
    { type: 'remote', name: 'origin/feature/my-branch' },
    { type: 'tag', name: 'v1.0.0' },
    { type: 'branch', name: 'develop' },
  ])
})

test('formatRelativeTime computes human friendly intervals', () => {
  const now = Date.now()
  assert.equal(formatRelativeTime(new Date(now - 10 * 1000).toISOString(), now), '10s ago')
  assert.equal(formatRelativeTime(new Date(now - 5 * 60 * 1000).toISOString(), now), '5m ago')
  assert.equal(formatRelativeTime(new Date(now - 3 * 3600 * 1000).toISOString(), now), '3h ago')
  assert.equal(formatRelativeTime(new Date(now - 2 * 86400 * 1000).toISOString(), now), '2d ago')
})

test('layoutGitGraph builds nodes and Bezier connections for linear commits', () => {
  const rawCommits = [
    {
      hash: 'commit-2',
      shortHash: 'c2',
      parents: ['commit-1'],
      author: 'Alice',
      email: 'alice@example.com',
      date: new Date().toISOString(),
      subject: 'feat: step 2',
      rawRefs: 'HEAD -> main',
    },
    {
      hash: 'commit-1',
      shortHash: 'c1',
      parents: [],
      author: 'Alice',
      email: 'alice@example.com',
      date: new Date().toISOString(),
      subject: 'chore: initial commit',
      rawRefs: '',
    },
  ]

  const status = { isDirty: false, headOid: 'commit-2', headBranch: 'main' }
  const graph = layoutGitGraph(rawCommits, status)

  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.nodes[0].hash, 'commit-2')
  assert.equal(graph.nodes[0].isHead, true)
  assert.equal(graph.nodes[0].lane, 0)
  assert.equal(graph.connections.length, 1)
  assert.equal(graph.connections[0].fromHash, 'commit-2')
  assert.equal(graph.connections[0].toHash, 'commit-1')
})

test('layoutGitGraph prepends working tree node when dirty', () => {
  const rawCommits = [
    {
      hash: 'commit-1',
      shortHash: 'c1',
      parents: [],
      author: 'Alice',
      email: 'alice@example.com',
      date: new Date().toISOString(),
      subject: 'init',
      rawRefs: 'HEAD -> main',
    },
  ]

  const status = { isDirty: true, staged: 1, unstaged: 2, untracked: 0, headOid: 'commit-1', headBranch: 'main' }
  const graph = layoutGitGraph(rawCommits, status)

  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.nodes[0].isWorkingTree, true)
  assert.equal(graph.nodes[0].hash, 'working-tree')
  assert.equal(graph.nodes[1].hash, 'commit-1')
  assert.equal(graph.connections.length, 1)
  assert.equal(graph.connections[0].fromHash, 'working-tree')
  assert.equal(graph.connections[0].toHash, 'commit-1')
})

test('getGitSnapshot executes on real working directory', async () => {
  const snap = await getGitSnapshot(process.cwd(), 5)
  assert.equal(snap.ok, true)
  assert.equal(snap.isGitRepo, true)
  assert.ok(snap.graph.nodes.length > 0)
  assert.ok(typeof snap.status.headBranch === 'string')
})

test('getCommitDetails retrieves metadata and changed files for a real commit', async () => {
  const snap = await getGitSnapshot(process.cwd(), 3)
  const realCommit = snap.graph.nodes.find((n) => !n.isWorkingTree)
  assert.ok(realCommit, 'should have at least one real commit')

  const details = await getCommitDetails(process.cwd(), realCommit.hash)
  assert.equal(details.ok, true)
  assert.equal(details.hash, realCommit.hash)
  assert.equal(details.shortHash, realCommit.shortHash)
  assert.ok(details.author)
  assert.ok(details.date)
  assert.ok(Array.isArray(details.files))
  assert.ok(details.stats)
  assert.ok(typeof details.stats.filesChanged === 'number')
})

