/**
 * Offline tests for the git / PR primitives (docs/16 §2.1).
 *
 * These tests build a real temporary repository (with a real bare remote) for
 * every case, so status/branch/commit/verify/push/merge are exercised through
 * actual git — no mocking of the git layer. The GitHub CLI is the one exception:
 * `gh` is always injected as a fake exec, so the suite never depends on a
 * machine-local gh install or login state and never talks to the network.
 * Only `file://`-style local remotes are used; nothing is pushed anywhere.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as Git from '../lib/git.js'

/** The module source, used by the no-history-rewriting safety test. */
const SOURCE_URL = new URL('../lib/git.js', import.meta.url)

/** The contracts this module must export (docs/16 §2.1). */
const CONTRACT_FUNCTIONS = [
  'gitStatus',
  'gitEnsureBranch',
  'gitCommit',
  'gitVerify',
  'gitPush',
  'gitMerge',
  'gitRemoteInfo',
  'ghAvailable',
  'gitPrCreateOrUpdate',
  'gitPrReview',
  'gitPrMerge',
].sort()

/**
 * Real process runner used by the fixtures and by the injected hybrid exec.
 * @returns `{ exitCode, stdout, stderr }`.
 */
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

/** Run one git command and assert it succeeded. */
async function gitRun(cwd, args) {
  const result = await realExec('git', args, { cwd })
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** Build a real repository with one commit on `main` and a bare `origin`. */
async function withRepo(fn) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'atw-git-')))
  const repo = join(dir, 'repo')
  const remote = join(dir, 'remote.git')
  try {
    await mkdir(repo)
    await gitRun(dir, ['init', '-q', '-b', 'main', 'repo'])
    await gitRun(repo, ['config', 'user.email', 'agentteam@example.test'])
    await gitRun(repo, ['config', 'user.name', 'Agent Team'])
    await gitRun(repo, ['config', 'commit.gpgsign', 'false'])
    await writeFile(join(repo, 'README.md'), '# demo\n')
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    await gitRun(repo, ['add', 'README.md', 'shared.txt'])
    await gitRun(repo, ['commit', '-q', '-m', 'initial commit'])
    await gitRun(dir, ['init', '-q', '--bare', 'remote.git'])
    await gitRun(repo, ['remote', 'add', 'origin', remote])
    await gitRun(repo, ['push', '-q', '-u', 'origin', 'main'])
    return await fn({ dir, repo, remote })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Run one async fixture inside a throwaway temp directory. */
async function withTempDir(fn) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'atw-git-outside-')))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Build an exec that answers every `gh` call with the given responder and
 * delegates every other command to the real process runner.
 * @param respond - `(args) => { exitCode, stdout, stderr }`.
 * @returns `{ exec, calls }` where `calls` keeps every gh argv.
 */
function ghFake(respond) {
  const calls = []
  const exec = (file, args, options) => {
    if (file === 'gh') {
      calls.push(args.slice())
      return Promise.resolve(respond(args.slice()))
    }
    return realExec(file, args, options)
  }
  return { exec, calls }
}

/** A fake gh whose CLI is not installed. */
function ghMissing() {
  return ghFake(() => ({ exitCode: 127, stdout: '', stderr: 'gh: command not found' }))
}

/** A fake gh whose CLI is installed but logged out. */
function ghLoggedOut() {
  return ghFake((args) => {
    if (args[0] === '--version') return { exitCode: 0, stdout: 'gh version 2.103.3 (2026-10-26)\n', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' }
  })
}

/** A fake gh whose CLI is installed and logged in. */
function ghLoggedIn(extra = {}) {
  return ghFake((args) => {
    if (args[0] === '--version') return { exitCode: 0, stdout: 'gh version 2.103.3 (2026-10-26)\n', stderr: '' }
    if (args[0] === 'auth') return { exitCode: 0, stdout: 'Logged in to github.com account lead\n', stderr: '' }
    const handlers = extra
    for (const [prefix, respond] of Object.entries(handlers)) {
      const parts = prefix.split(' ')
      if (parts.every((part, index) => args[index] === part)) return respond(args)
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` }
  })
}

/** @returns the gh argv of the first call matching a argv prefix. */
function findGhCall(calls, prefix) {
  const parts = prefix.split(' ')
  return calls.find((args) => parts.every((part, index) => args[index] === part)) ?? null
}

test('exports exactly the functions promised by the contract', () => {
  assert.deepEqual(Object.keys(Git).sort(), CONTRACT_FUNCTIONS)
  for (const name of CONTRACT_FUNCTIONS) assert.equal(typeof Git[name], 'function')
})

test('gitStatus reports a clean repository with its branch and remote', async () => {
  await withRepo(async ({ repo }) => {
    const status = await Git.gitStatus({ cwd: repo })
    assert.equal(status.ok, true)
    assert.equal(status.root, repo)
    assert.equal(status.branch, 'main')
    assert.equal(status.clean, true)
    assert.equal(status.staged, 0)
    assert.equal(status.unstaged, 0)
    assert.equal(status.untracked, 0)
    assert.equal(status.remote, 'origin')
    assert.equal(status.ahead, 0)
    assert.equal(status.behind, 0)
  })
  await withTempDir(async (outside) => {
    const status = await Git.gitStatus({ cwd: outside })
    assert.equal(status.ok, false)
    assert.match(status.error, /not a git repository/)
  })
})

test('gitStatus separates staged, unstaged and untracked changes', async () => {
  await withRepo(async ({ repo }) => {
    await writeFile(join(repo, 'README.md'), '# changed\n')
    let status = await Git.gitStatus({ cwd: repo })
    assert.equal(status.clean, false)
    assert.deepEqual([status.staged, status.unstaged, status.untracked], [0, 1, 0])

    await gitRun(repo, ['add', 'README.md'])
    status = await Git.gitStatus({ cwd: repo })
    assert.deepEqual([status.staged, status.unstaged, status.untracked], [1, 0, 0])

    await writeFile(join(repo, 'new.txt'), 'new\n')
    status = await Git.gitStatus({ cwd: repo })
    assert.deepEqual([status.staged, status.unstaged, status.untracked], [1, 0, 1])

    await gitRun(repo, ['restore', '--staged', 'README.md'])
    status = await Git.gitStatus({ cwd: repo })
    assert.deepEqual([status.staged, status.unstaged, status.untracked], [0, 1, 1])
    assert.equal(status.clean, false)
  })
})

test('gitEnsureBranch creates a feature branch and is idempotent', async () => {
  await withRepo(async ({ repo }) => {
    const branch = 'agentteam/run-1/J1'
    const created = await Git.gitEnsureBranch({ cwd: repo, branch, base: 'main' })
    assert.equal(created.ok, true)
    assert.equal(created.branch, branch)
    assert.equal(created.base, 'main')
    assert.equal(created.created, true)
    assert.equal(created.switched, true)
    assert.equal((await gitRun(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), branch)

    const again = await Git.gitEnsureBranch({ cwd: repo, branch, base: 'main' })
    assert.deepEqual({ created: again.created, switched: again.switched }, { created: false, switched: false })

    await gitRun(repo, ['switch', '-q', 'main'])
    const switched = await Git.gitEnsureBranch({ cwd: repo, branch, base: 'main' })
    assert.deepEqual({ created: switched.created, switched: switched.switched }, { created: false, switched: true })
    assert.equal((await gitRun(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), branch)
  })
})

test('gitEnsureBranch refuses the base branch, a dirty worktree and unsafe names', async () => {
  await withRepo(async ({ repo }) => {
    const onBase = await Git.gitEnsureBranch({ cwd: repo, branch: 'main', base: 'main' })
    assert.equal(onBase.ok, false)
    assert.match(onBase.error, /base/)

    await writeFile(join(repo, 'README.md'), '# dirty\n')
    const dirty = await Git.gitEnsureBranch({ cwd: repo, branch: 'agentteam/run-1/J1', base: 'main' })
    assert.equal(dirty.ok, false)
    assert.match(dirty.error, /dirty/)

    await gitRun(repo, ['restore', 'README.md'])
    await writeFile(join(repo, 'untracked.txt'), 'x\n')
    const stillDirty = await Git.gitEnsureBranch({ cwd: repo, branch: 'agentteam/run-1/J1', base: 'main' })
    assert.equal(stillDirty.ok, false)
    assert.match(stillDirty.error, /dirty/)

    await rm(join(repo, 'untracked.txt'))
    const injected = await Git.gitEnsureBranch({ cwd: repo, branch: '--force', base: 'main' })
    assert.equal(injected.ok, false)
    assert.match(injected.error, /valid branch name/)
  })
})

test('gitCommit commits only the files it is given', async () => {
  await withRepo(async ({ repo }) => {
    await Git.gitEnsureBranch({ cwd: repo, branch: 'agentteam/run-1/J1', base: 'main' })
    await writeFile(join(repo, 'a.txt'), 'a\n')
    await writeFile(join(repo, 'b.txt'), 'b\n')
    await writeFile(join(repo, 'README.md'), '# changed\n')

    const commit = await Git.gitCommit({ cwd: repo, files: ['a.txt'], message: 'agentteam(J1): add a' })
    assert.equal(commit.ok, true)
    assert.match(commit.sha, /^[0-9a-f]{40}$/)
    assert.deepEqual(commit.files, ['a.txt'])

    const committedFiles = (await gitRun(repo, ['show', '--name-only', '--format=', 'HEAD']))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    assert.deepEqual(committedFiles, ['a.txt'])

    // The out-of-scope files are untouched: b.txt is still untracked, README
    // is still modified, and nothing of theirs is in the commit.
    const porcelain = await gitRun(repo, ['status', '--porcelain'])
    assert.match(porcelain, /\?\? b\.txt/)
    assert.match(porcelain, / M README\.md/)
    assert.doesNotMatch(porcelain, /a\.txt/)
  })
})

test('gitCommit refuses empty file lists, no-op commits and non-repositories', async () => {
  await withRepo(async ({ repo }) => {
    await Git.gitEnsureBranch({ cwd: repo, branch: 'agentteam/run-1/J1', base: 'main' })
    const empty = await Git.gitCommit({ cwd: repo, files: [], message: 'nothing' })
    assert.equal(empty.ok, false)
    assert.match(empty.error, /at least one file/)

    await writeFile(join(repo, 'a.txt'), 'a\n')
    const first = await Git.gitCommit({ cwd: repo, files: ['a.txt'], message: 'first' })
    assert.equal(first.ok, true)
    const noop = await Git.gitCommit({ cwd: repo, files: ['a.txt'], message: 'again' })
    assert.equal(noop.ok, false)
    assert.match(noop.error, /nothing to commit/)
  })
  await withTempDir(async (outside) => {
    const result = await Git.gitCommit({ cwd: outside, files: ['x.txt'], message: 'nope' })
    assert.equal(result.ok, false)
    assert.match(result.error, /not a git repository/)
  })
})

test('gitCommit refuses to commit on the base branch', async () => {
  await withRepo(async ({ repo }) => {
    await writeFile(join(repo, 'README.md'), '# dirty\n')
    // base is detected (refs/heads/main), so no explicit `base` is needed.
    const detected = await Git.gitCommit({ cwd: repo, files: ['README.md'], message: 'direct to main' })
    assert.equal(detected.ok, false)
    assert.match(detected.error, /base branch/)

    const declared = await Git.gitCommit({ cwd: repo, files: ['README.md'], message: 'direct to main', base: 'main' })
    assert.equal(declared.ok, false)
    assert.match(declared.error, /base branch/)

    // A feature branch commits fine.
    await gitRun(repo, ['restore', 'README.md'])
    await Git.gitEnsureBranch({ cwd: repo, branch: 'agentteam/run-1/J1', base: 'main' })
    await writeFile(join(repo, 'README.md'), '# feature\n')
    const featureCommit = await Git.gitCommit({ cwd: repo, files: ['README.md'], message: 'feat: readme' })
    assert.equal(featureCommit.ok, true)
  })
})

test('gitVerify runs commands through /bin/sh and reports failures', async () => {
  await withRepo(async ({ repo }) => {
    const success = await Git.gitVerify({ cwd: repo, commands: ['true', 'echo ok'] })
    assert.equal(success.ok, true)
    assert.deepEqual(success.results.map((entry) => entry.exitCode), [0, 0])
    assert.equal(success.results[1].outputTail, 'ok')

    const failure = await Git.gitVerify({ cwd: repo, commands: ['echo hello >&2; exit 3', 'echo after'] })
    assert.equal(failure.ok, false)
    assert.match(failure.error, /verify command failed/)
    assert.deepEqual(failure.results.map((entry) => entry.exitCode), [3, 0])
    assert.match(failure.results[0].outputTail, /hello/)

    const none = await Git.gitVerify({ cwd: repo, commands: [] })
    assert.equal(none.ok, false)
    assert.match(none.error, /no verify commands/)
    assert.deepEqual(none.results, [])

    // The configured commands really are executed by /bin/sh -lc.
    const captured = []
    const fakeExec = (file, args, options) => {
      captured.push({ file, args, options })
      return Promise.resolve({ exitCode: 0, stdout: 'shell-ok', stderr: '' })
    }
    const injected = await Git.gitVerify({ cwd: repo, commands: ['echo hi'], exec: fakeExec })
    assert.equal(injected.ok, true)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].file, '/bin/sh')
    assert.deepEqual(captured[0].args, ['-lc', 'echo hi'])
    assert.equal(captured[0].options.cwd, repo)
  })
})

test('gitVerify honors its timeout', async () => {
  await withRepo(async ({ repo }) => {
    const started = Date.now()
    const timed = await Git.gitVerify({ cwd: repo, commands: ['sleep 2'], timeoutMs: 200 })
    const elapsed = Date.now() - started
    assert.equal(timed.ok, false)
    assert.equal(timed.results.length, 1)
    assert.equal(timed.results[0].exitCode, 124)
    assert.ok(elapsed < 1_800, `the timeout should have killed the command early, took ${elapsed}ms`)
  })
})

test('gitPush pushes a feature branch to the bare remote and tracks it', async () => {
  await withRepo(async ({ repo, remote }) => {
    const branch = 'agentteam/run-1/J1'
    await Git.gitEnsureBranch({ cwd: repo, branch, base: 'main' })
    await writeFile(join(repo, 'a.txt'), 'a\n')
    const commit = await Git.gitCommit({ cwd: repo, files: ['a.txt'], message: 'feat: a' })
    assert.equal(commit.ok, true)

    const pushed = await Git.gitPush({ cwd: repo, remote: 'origin', branch, base: 'main' })
    assert.equal(pushed.ok, true)
    assert.deepEqual({ remote: pushed.remote, branch: pushed.branch, sha: pushed.sha }, { remote: 'origin', branch, sha: commit.sha })

    const remoteSha = await realExec('git', ['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${branch}`])
    assert.equal(remoteSha.exitCode, 0)
    assert.equal(remoteSha.stdout.trim(), commit.sha)

    const upstream = (await gitRun(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim()
    assert.equal(upstream, `origin/${branch}`)

    // A local commit after the push shows up as ahead of the tracked remote.
    await writeFile(join(repo, 'b.txt'), 'b\n')
    await Git.gitCommit({ cwd: repo, files: ['b.txt'], message: 'feat: b' })
    const status = await Git.gitStatus({ cwd: repo })
    assert.equal(status.branch, branch)
    assert.equal(status.ahead, 1)
    assert.equal(status.behind, 0)
  })
})

test('gitPush refuses the base branch and an unknown remote', async () => {
  await withRepo(async ({ repo }) => {
    const onBase = await Git.gitPush({ cwd: repo, remote: 'origin', branch: 'main', base: 'main' })
    assert.equal(onBase.ok, false)
    assert.match(onBase.error, /base branch/)

    const detected = await Git.gitPush({ cwd: repo, remote: 'origin', branch: 'main' })
    assert.equal(detected.ok, false)
    assert.match(detected.error, /base branch/)

    await Git.gitEnsureBranch({ cwd: repo, branch: 'agentteam/run-1/J1', base: 'main' })
    const missingRemote = await Git.gitPush({ cwd: repo, remote: 'no-such-remote', branch: 'agentteam/run-1/J1' })
    assert.equal(missingRemote.ok, false)
    assert.match(missingRemote.error, /remote "no-such-remote" is not configured/)
  })
})

test('gitMerge merges a feature branch into base with --no-ff by default', async () => {
  await withRepo(async ({ repo }) => {
    const branch = 'agentteam/run-1/J1'
    await Git.gitEnsureBranch({ cwd: repo, branch, base: 'main' })
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await Git.gitCommit({ cwd: repo, files: ['feature.txt'], message: 'feat: feature file' })

    const merged = await Git.gitMerge({ cwd: repo, branch, into: 'main' })
    assert.equal(merged.ok, true)
    assert.match(merged.sha, /^[0-9a-f]{40}$/)
    assert.equal(merged.method, 'no-ff')
    assert.equal((await gitRun(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main')
    assert.equal((await gitRun(repo, ['rev-list', '--count', '--merges', 'HEAD'])).trim(), '1')
    assert.match((await gitRun(repo, ['log', '-1', '--pretty=%s'])).trim(), /^Merge branch/)
    assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'feature\n')

    const self = await Git.gitMerge({ cwd: repo, branch: 'main', into: 'main' })
    assert.equal(self.ok, false)
    assert.match(self.error, /itself/)
  })
})

test('gitMerge squashes on request and rejects unknown methods', async () => {
  await withRepo(async ({ repo }) => {
    await Git.gitEnsureBranch({ cwd: repo, branch: 'agentteam/run-1/J2', base: 'main' })
    await writeFile(join(repo, 'g.txt'), 'g\n')
    await Git.gitCommit({ cwd: repo, files: ['g.txt'], message: 'feat: g' })
    const squashed = await Git.gitMerge({ cwd: repo, branch: 'agentteam/run-1/J2', into: 'main', method: 'squash' })
    assert.equal(squashed.ok, true)
    assert.equal(squashed.method, 'squash')
    // A squash merge produces one ordinary commit, not a merge commit.
    assert.equal((await gitRun(repo, ['rev-list', '--count', '--merges', 'HEAD'])).trim(), '0')
    assert.equal((await gitRun(repo, ['show', '--name-only', '--format=', 'HEAD'])).trim(), 'g.txt')

    const badMethod = await Git.gitMerge({ cwd: repo, branch: 'agentteam/run-1/J2', into: 'main', method: 'octopus' })
    assert.equal(badMethod.ok, false)
    assert.match(badMethod.error, /unknown merge method/)
  })
})

test('gitMerge reports conflicts without resolving them', async () => {
  await withRepo(async ({ repo }) => {
    const branch = 'agentteam/run-1/J3'
    await Git.gitEnsureBranch({ cwd: repo, branch, base: 'main' })
    await writeFile(join(repo, 'shared.txt'), 'feature side\n')
    await Git.gitCommit({ cwd: repo, files: ['shared.txt'], message: 'feat: shared' })

    await gitRun(repo, ['switch', '-q', 'main'])
    await writeFile(join(repo, 'shared.txt'), 'main side\n')
    await gitRun(repo, ['commit', '-q', '-am', 'main: shared'])

    const conflicted = await Git.gitMerge({ cwd: repo, branch, into: 'main' })
    assert.equal(conflicted.ok, false)
    assert.match(conflicted.error, /conflicts/)
    // The merge is aborted, never auto-resolved: no merge in progress, no
    // unmerged paths, and the target content is byte-identical to before.
    assert.equal((await gitRun(repo, ['status', '--porcelain'])).trim(), '')
    const mergeHead = await realExec('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repo })
    assert.notEqual(mergeHead.exitCode, 0)
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'main side\n')
  })
})

test('gitRemoteInfo derives a GitHub compare URL from https and ssh remotes', async () => {
  await withRepo(async ({ repo }) => {
    // The fixture's origin is a local bare path: no provider, no compare URL.
    const local = await Git.gitRemoteInfo({ cwd: repo, remote: 'origin' })
    assert.equal(local.ok, true)
    assert.equal(local.provider, null)
    assert.equal(local.compareUrl, null)

    await gitRun(repo, ['remote', 'set-url', 'origin', 'https://github.com/acme/demo.git'])
    const https = await Git.gitRemoteInfo({ cwd: repo, base: 'main', branch: 'agentteam/run-1/J1' })
    assert.equal(https.ok, true)
    assert.equal(https.url, 'https://github.com/acme/demo.git')
    assert.equal(https.provider, 'github')
    assert.equal(https.compareUrl, 'https://github.com/acme/demo/compare/main...agentteam/run-1/J1')

    const withoutBranch = await Git.gitRemoteInfo({ cwd: repo })
    assert.equal(withoutBranch.compareUrl, 'https://github.com/acme/demo/compare')

    await gitRun(repo, ['remote', 'set-url', 'origin', 'git@github.com:acme/demo.git'])
    const ssh = await Git.gitRemoteInfo({ cwd: repo, base: 'main', branch: 'agentteam/run-1/J1' })
    assert.equal(ssh.provider, 'github')
    assert.equal(ssh.compareUrl, 'https://github.com/acme/demo/compare/main...agentteam/run-1/J1')

    await gitRun(repo, ['remote', 'set-url', 'origin', 'ssh://git@github.com:22/acme/demo.git'])
    const sshUrl = await Git.gitRemoteInfo({ cwd: repo, base: 'main', branch: 'agentteam/run-1/J1' })
    assert.equal(sshUrl.provider, 'github')
    assert.equal(sshUrl.compareUrl, 'https://github.com/acme/demo/compare/main...agentteam/run-1/J1')

    // Non-GitHub providers have no compare URL (docs/16 §2.1).
    await gitRun(repo, ['remote', 'set-url', 'origin', 'https://gitlab.com/acme/demo.git'])
    const gitlab = await Git.gitRemoteInfo({ cwd: repo, base: 'main', branch: 'agentteam/run-1/J1' })
    assert.equal(gitlab.provider, 'gitlab')
    assert.equal(gitlab.compareUrl, null)

    await gitRun(repo, ['remote', 'set-url', 'origin', 'https://gitea.internal/acme/demo.git'])
    const other = await Git.gitRemoteInfo({ cwd: repo })
    assert.equal(other.provider, 'other')
    assert.equal(other.compareUrl, null)

    const missing = await Git.gitRemoteInfo({ cwd: repo, remote: 'nope' })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /not configured/)
  })
})

test('ghAvailable distinguishes missing, logged-out and logged-in states', async () => {
  const missing = ghMissing()
  assert.deepEqual(await Git.ghAvailable({ exec: missing.exec }), { installed: false, authenticated: false, version: null })

  const loggedOut = ghLoggedOut()
  assert.deepEqual(await Git.ghAvailable({ exec: loggedOut.exec }), { installed: true, authenticated: false, version: '2.103.3' })

  const loggedIn = ghLoggedIn()
  assert.deepEqual(await Git.ghAvailable({ exec: loggedIn.exec }), { installed: true, authenticated: true, version: '2.103.3' })

  // A broken runner must degrade to "not installed", not throw.
  const broken = await Git.ghAvailable({
    exec: () => {
      throw new Error('spawn failed')
    },
  })
  assert.deepEqual(broken, { installed: false, authenticated: false, version: null })
})

test('gitPrCreateOrUpdate falls back to manual mode with a compare URL', async () => {
  await withRepo(async ({ repo }) => {
    const branch = 'agentteam/run-1/J1'

    // The fixture's origin is a local bare path. Even with a usable gh, a
    // remote that is not a GitHub host cannot back a PR, so the workflow keeps
    // the manual path (this is what the live run with a bare remote relies on)
    // and has no compare URL for it.
    const bareRemote = await Git.gitPrCreateOrUpdate({ cwd: repo, branch, base: 'main', title: 'J1', exec: ghLoggedIn().exec })
    assert.equal(bareRemote.ok, true)
    assert.equal(bareRemote.mode, 'manual')
    assert.equal(bareRemote.url, null)
    assert.match(bareRemote.reason, /not a GitHub host/)

    await gitRun(repo, ['remote', 'set-url', 'origin', 'https://github.com/acme/demo.git'])

    const uninstalled = await Git.gitPrCreateOrUpdate({ cwd: repo, branch, base: 'main', title: 'J1', body: 'body', exec: ghMissing().exec })
    assert.equal(uninstalled.ok, true)
    assert.equal(uninstalled.mode, 'manual')
    assert.equal(uninstalled.url, 'https://github.com/acme/demo/compare/main...agentteam/run-1/J1')
    assert.equal(uninstalled.number, null)
    assert.match(uninstalled.reason, /not installed/)

    const loggedOut = await Git.gitPrCreateOrUpdate({ cwd: repo, branch, base: 'main', title: 'J1', body: 'body', exec: ghLoggedOut().exec })
    assert.equal(loggedOut.mode, 'manual')
    assert.match(loggedOut.reason, /not authenticated/)
    assert.equal(loggedOut.url, 'https://github.com/acme/demo/compare/main...agentteam/run-1/J1')

    // The base branch is detected when the caller omits it.
    const detectedBase = await Git.gitPrCreateOrUpdate({ cwd: repo, branch, title: 'J1', exec: ghMissing().exec })
    assert.equal(detectedBase.mode, 'manual')
    assert.equal(detectedBase.url, 'https://github.com/acme/demo/compare/main...agentteam/run-1/J1')

    await gitRun(repo, ['remote', 'set-url', 'origin', 'git@github.com:acme/demo.git'])
    const ssh = await Git.gitPrCreateOrUpdate({ cwd: repo, branch, base: 'main', title: 'J1', exec: ghMissing().exec })
    assert.equal(ssh.url, 'https://github.com/acme/demo/compare/main...agentteam/run-1/J1')

    const fromBase = await Git.gitPrCreateOrUpdate({ cwd: repo, branch: 'main', base: 'main', title: 'nope', exec: ghMissing().exec })
    assert.equal(fromBase.ok, false)
    assert.match(fromBase.error, /base branch/)
  })
})

test('gitPrCreateOrUpdate creates or updates the PR through gh', async () => {
  await withRepo(async ({ repo }) => {
    const branch = 'agentteam/run-1/J1'
    await gitRun(repo, ['remote', 'set-url', 'origin', 'https://github.com/acme/demo.git'])

    const created = ghLoggedIn({
      'pr view': () => ({ exitCode: 1, stdout: '', stderr: 'no pull requests found' }),
      'pr create': () => ({ exitCode: 0, stdout: 'https://github.com/acme/demo/pull/42\n', stderr: '' }),
    })
    const result = await Git.gitPrCreateOrUpdate({ cwd: repo, branch, base: 'main', title: 'J1 subject', body: 'the body', exec: created.exec })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'gh')
    assert.equal(result.url, 'https://github.com/acme/demo/pull/42')
    assert.equal(result.number, 42)
    assert.equal(result.updated, false)
    const createCall = findGhCall(created.calls, 'pr create')
    assert.deepEqual(createCall, ['pr', 'create', '--head', branch, '--base', 'main', '--title', 'J1 subject', '--body', 'the body'])

    const updatedFixture = ghLoggedIn({
      'pr view': () => ({ exitCode: 0, stdout: JSON.stringify({ number: 7, url: 'https://github.com/acme/demo/pull/7' }), stderr: '' }),
      'pr edit': () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })
    const updated = await Git.gitPrCreateOrUpdate({ cwd: repo, branch, base: 'main', title: 'New title', body: 'New body', exec: updatedFixture.exec })
    assert.equal(updated.ok, true)
    assert.equal(updated.mode, 'gh')
    assert.equal(updated.number, 7)
    assert.equal(updated.url, 'https://github.com/acme/demo/pull/7')
    assert.equal(updated.updated, true)
    const editCall = findGhCall(updatedFixture.calls, 'pr edit')
    assert.deepEqual(editCall, ['pr', 'edit', '7', '--title', 'New title', '--body', 'New body', '--base', 'main'])

    const failing = ghLoggedIn({
      'pr view': () => ({ exitCode: 1, stdout: '', stderr: '' }),
      'pr create': () => ({ exitCode: 1, stdout: '', stderr: 'pull request create failed: no commits between main and branch' }),
    })
    const failure = await Git.gitPrCreateOrUpdate({ cwd: repo, branch, base: 'main', title: 'T', exec: failing.exec })
    assert.equal(failure.ok, false)
    assert.match(failure.error, /gh pr create failed/)
  })
})

test('gitPrReview maps workflow verdicts and records manual reviews', async () => {
  const fixture = ghLoggedIn({
    'pr review': () => ({ exitCode: 0, stdout: '', stderr: '' }),
  })
  const approve = await Git.gitPrReview({ number: 42, verdict: 'approve_with_nits', body: 'LGTM', exec: fixture.exec })
  assert.deepEqual({ ok: approve.ok, mode: approve.mode, action: approve.action }, { ok: true, mode: 'gh', action: 'approve' })
  assert.deepEqual(findGhCall(fixture.calls, 'pr review'), ['pr', 'review', '42', '--approve', '--body', 'LGTM'])

  const requestChanges = await Git.gitPrReview({ number: '42', verdict: 'request_changes', exec: fixture.exec })
  assert.equal(requestChanges.action, 'request-changes')
  assert.deepEqual(findGhCall(fixture.calls, 'pr review'), ['pr', 'review', '42', '--approve', '--body', 'LGTM'])
  assert.deepEqual(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'review').at(-1), ['pr', 'review', '42', '--request-changes'])

  const blocked = await Git.gitPrReview({ number: 42, verdict: 'block', exec: fixture.exec })
  assert.equal(blocked.action, 'request-changes')

  const manual = await Git.gitPrReview({ number: 42, verdict: 'approve', exec: ghMissing().exec })
  assert.deepEqual({ ok: manual.ok, mode: manual.mode, action: manual.action }, { ok: true, mode: 'manual', action: 'approve' })
  assert.match(manual.reason, /not installed/)

  const unknownVerdict = await Git.gitPrReview({ number: 42, verdict: 'meh', exec: fixture.exec })
  assert.equal(unknownVerdict.ok, false)
  assert.match(unknownVerdict.error, /verdict/)

  const noNumber = await Git.gitPrReview({ verdict: 'approve', exec: fixture.exec })
  assert.equal(noNumber.ok, false)
  assert.match(noNumber.error, /number/)
})

test('gitPrMerge passes the merge method through and falls back to manual', async () => {
  const fixture = ghLoggedIn({
    'pr merge': () => ({ exitCode: 0, stdout: '', stderr: '' }),
    'pr view': () => ({ exitCode: 0, stdout: JSON.stringify({ mergeCommit: { oid: 'a'.repeat(40) }, headRefOid: 'b'.repeat(40) }), stderr: '' }),
  })
  const squashed = await Git.gitPrMerge({ number: 42, exec: fixture.exec })
  assert.deepEqual({ ok: squashed.ok, mode: squashed.mode, sha: squashed.sha }, { ok: true, mode: 'gh', sha: 'a'.repeat(40) })
  assert.deepEqual(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').at(-1), ['pr', 'merge', '42', '--squash'])

  const byMerge = await Git.gitPrMerge({ number: 42, method: 'merge', exec: fixture.exec })
  assert.equal(byMerge.method, 'merge')
  assert.deepEqual(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').at(-1), ['pr', 'merge', '42', '--merge'])

  const byRebase = await Git.gitPrMerge({ number: 42, method: 'rebase', exec: fixture.exec })
  assert.equal(byRebase.method, 'rebase')
  assert.deepEqual(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').at(-1), ['pr', 'merge', '42', '--rebase'])

  const manual = await Git.gitPrMerge({ number: 42, exec: ghMissing().exec })
  assert.deepEqual({ ok: manual.ok, mode: manual.mode, sha: manual.sha, method: manual.method }, { ok: true, mode: 'manual', sha: null, method: 'squash' })
  assert.match(manual.reason, /not installed/)

  const badMethod = await Git.gitPrMerge({ number: 42, method: 'octopus', exec: fixture.exec })
  assert.equal(badMethod.ok, false)
  assert.match(badMethod.error, /merge method/)

  const noNumber = await Git.gitPrMerge({ exec: fixture.exec })
  assert.equal(noNumber.ok, false)
  assert.match(noNumber.error, /number/)
})

test('the module never forces, amends or rewrites history', async () => {
  const source = await readFile(SOURCE_URL, 'utf8')
  // Look at code only, not at the comments that document the safety rules.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  // No history-rewriting or history-skipping flags anywhere in the argv.
  assert.equal(code.includes('--force'), false)
  assert.equal(code.includes('--amend'), false)
  assert.equal(code.includes('--no-verify'), false)
  assert.equal(code.includes('--hard'), false)
  // No local `git rebase` / `git reset` argv. (`rebase` may still appear as the
  // GitHub merge-strategy token, which docs/16 §2.1 explicitly allows.)
  assert.equal(/\[\s*'(?:rebase|reset)'/.test(code), false)
  // The only shell usage is the configured verify path, not a git invocation.
  assert.equal(code.split("'/bin/sh'").length - 1, 1)
  assert.equal(code.includes("'-lc'"), true)
  // git itself is always spawned as an argv array, and push has no force form.
  assert.equal(code.includes('execFile('), true)
  assert.equal(code.includes("['push', '-u', remote, branch]"), true)
})

test('every exported function fails gracefully instead of throwing', async () => {
  const garbage = [{}, null, 42, { cwd: 5 }, { cwd: '/no/such/path' }]
  for (const name of CONTRACT_FUNCTIONS) {
    if (name === 'ghAvailable') continue
    for (const input of garbage) {
      const result = await Git[name](input)
      assert.equal(typeof result, 'object', `${name}(${JSON.stringify(input)}) must return an object`)
      assert.equal(result.ok, false, `${name}(${JSON.stringify(input)}) must fail gracefully`)
      assert.equal(typeof result.error, 'string', `${name}(${JSON.stringify(input)}) must explain the failure`)
    }
  }
  const probe = await Git.ghAvailable({ exec: () => Promise.reject(new Error('boom')) })
  assert.deepEqual(probe, { installed: false, authenticated: false, version: null })
})
