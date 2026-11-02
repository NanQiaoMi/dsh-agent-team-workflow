/**
 * Git / PR primitives for the Agent Team workflow (docs/16 §2.1).
 *
 * Zero external dependencies: only Node built-ins (`node:child_process`).
 * Every exported function is **total**: it never throws, it never rejects, and
 * every failure is reported as `{ ok: false, error }` with a one-line,
 * human-readable reason the Lead or a member can act on.
 *
 * Safety rules this module enforces (it is the whole point of the module):
 * - git is always invoked as `git <args array>` via `execFile`, never through a
 *   shell string, so a branch name or file path cannot inject flags;
 * - only `git push -u <remote> <branch>` is available — never `--force`;
 * - no `--amend`, no local `rebase`, no history rewriting, no hard resets;
 * - commits are path-scoped (`git commit -m msg -- <files>`), so a report can
 *   only commit the files it declared;
 * - work on the base branch is refused (no direct commits/pushes to `main`);
 * - a conflicting merge is aborted and reported, never auto-resolved.
 *
 * The only shell usage is `gitVerify`, which runs the *configured* verify
 * commands through `/bin/sh -lc` exactly as docs/16 §2.1 specifies.
 */

import { execFile } from 'node:child_process'

/** Timeout for one git/gh command. */
const GIT_TIMEOUT_MS = 60_000
/** Timeout for one verify command (tests can be slow). */
const VERIFY_TIMEOUT_MS = 10 * 60_000
/** Upper bound for one child process output. */
const MAX_BUFFER = 16 * 1024 * 1024
/** How much command output is kept in one verify result / error message. */
const OUTPUT_TAIL = 2_000
const ERROR_TAIL = 600
/** Conventional exit code for a command killed by its timeout. */
const TIMEOUT_EXIT = 124
/** Shell used only for configured verify commands. */
const SHELL = '/bin/sh'

/** @returns whether one value is a plain object (not null, not an array). */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Coerce a value to text without ever throwing. */
function textOf(value, fallback = '') {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

/** @returns a short message for any thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return textOf(error, 'unknown error')
}

/** Keep the tail of long command output (the interesting part of a failure). */
function tailOf(value, max = OUTPUT_TAIL) {
  const text = textOf(value).replace(/\r\n/g, '\n').trim()
  if (text.length <= max) return text
  return `…${text.slice(-max)}`
}

/** Build a success result. */
function ok(data) {
  return { ok: true, ...data }
}

/** Build a failure result (never throws). */
function fail(error, extra = {}) {
  return { ok: false, error: textOf(error, 'git operation failed'), ...extra }
}

/**
 * Validate one git ref-ish name (branch, base, remote) before it is passed as a
 * positional argv entry. This blocks argv injection (`--force` as a branch
 * name) as well as git's own invalid names.
 * @param value - raw name.
 * @returns the safe name, or null when it must be refused.
 */
function safeRefName(value) {
  const name = textOf(value).trim()
  if (name.length === 0 || name.length > 200) return null
  if (name.startsWith('-')) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return null
  if (name.includes('..') || name.endsWith('/') || name.includes('//')) return null
  return name
}

/**
 * Default process runner: `execFile(file, args, { cwd, timeout })`.
 * Resolves to `{ exitCode, stdout, stderr, timedOut }` and never rejects.
 * @param file - executable (`git`, `gh`, `/bin/sh`).
 * @param args - argv array.
 * @param options - `{ cwd, timeout, env }`.
 * @returns normalized process result.
 */
function defaultExec(file, args, options = {}) {
  return new Promise((resolvePromise) => {
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? Math.trunc(options.timeout) : GIT_TIMEOUT_MS
    try {
      execFile(
        file,
        args,
        { cwd: options.cwd, env: options.env, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          const timedOut =
            error !== null &&
            error !== undefined &&
            (error.killed === true || error.signal === 'SIGTERM' || error.signal === 'SIGKILL' || error.code === 'ETIMEDOUT' || /timed?\s*out|timeout/i.test(messageOf(error)))
          const exitCode =
            error === null || error === undefined ? 0 : timedOut ? TIMEOUT_EXIT : Number.isInteger(error.code) ? error.code : 1
          settle({ exitCode, stdout: textOf(stdout), stderr: textOf(stderr), timedOut })
        },
      )
    } catch (error) {
      settle({ exitCode: 127, stdout: '', stderr: messageOf(error), timedOut: false })
    }
  })
}

/**
 * Run one injected or default process runner and normalize its result.
 * @param exec - optional `(file, args, options) => Promise<{exitCode, stdout, stderr}>`.
 * @param file - executable.
 * @param args - argv array.
 * @param options - `{ cwd, timeout, env }`.
 * @returns `{ exitCode, stdout, stderr, timedOut }`.
 */
async function invoke(exec, file, args, options = {}) {
  const runner = typeof exec === 'function' ? exec : defaultExec
  try {
    const result = await runner(file, args, options)
    if (!isRecord(result)) return { exitCode: 1, stdout: '', stderr: 'the exec runner returned no result', timedOut: false }
    const timedOut = result.timedOut === true
    const exitCode = timedOut
      ? TIMEOUT_EXIT
      : Number.isInteger(result.exitCode)
        ? result.exitCode
        : Number.isInteger(result.code)
          ? result.code
          : result.ok === true
            ? 0
            : 1
    return { exitCode, stdout: textOf(result.stdout), stderr: textOf(result.stderr), timedOut }
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: textOf(error?.stdout),
      stderr: `${textOf(error?.stderr)}${textOf(error?.stderr).length > 0 ? '\n' : ''}${messageOf(error)}`,
      timedOut: false,
    }
  }
}

/**
 * Run one git command.
 * @param exec - injected runner (optional).
 * @param cwd - working directory.
 * @param args - git argv.
 * @param timeout - timeout in ms.
 * @returns normalized process result.
 */
function git(exec, cwd, args, timeout = GIT_TIMEOUT_MS) {
  return invoke(exec, 'git', args, { cwd, timeout })
}

/** @returns the repository root, or null when `cwd` is not inside a repository. */
async function repoRoot(exec, cwd) {
  const result = await git(exec, cwd, ['rev-parse', '--show-toplevel'])
  if (result.exitCode !== 0) return null
  const root = result.stdout.trim()
  return root.length > 0 ? root : null
}

/** @returns the current branch name (`HEAD` when detached), or ''. */
async function currentBranch(exec, cwd) {
  const result = await git(exec, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return result.exitCode === 0 ? result.stdout.trim() : ''
}

/** @returns whether one local branch exists. */
async function branchExists(exec, cwd, branch) {
  const name = safeRefName(branch)
  if (name === null) return false
  const result = await git(exec, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
  return result.exitCode === 0
}

/**
 * Detect the repository's base branch without asking the caller: the remote
 * HEAD symbolic ref first, then `init.defaultBranch`, then a local `main` /
 * `master` ref.
 * @returns base branch name, or null when it cannot be determined.
 */
async function detectBaseBranch(exec, cwd, remote = 'origin') {
  const remoteName = safeRefName(remote)
  if (remoteName !== null) {
    const symbolic = await git(exec, cwd, ['symbolic-ref', '--quiet', `refs/remotes/${remoteName}/HEAD`])
    if (symbolic.exitCode === 0) {
      const ref = symbolic.stdout.trim()
      const prefix = `refs/remotes/${remoteName}/`
      if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length)
    }
  }
  const configured = await git(exec, cwd, ['config', '--get', 'init.defaultBranch'])
  if (configured.exitCode === 0 && configured.stdout.trim().length > 0) return configured.stdout.trim()
  for (const candidate of ['main', 'master']) {
    if (await branchExists(exec, cwd, candidate)) return candidate
  }
  return null
}

/**
 * Read the `git status --porcelain=v2 --branch` summary.
 * @returns parsed status, or null when the command failed.
 */
async function porcelainSummary(exec, cwd) {
  const result = await git(exec, cwd, ['status', '--porcelain=v2', '--branch'])
  if (result.exitCode !== 0) return null
  const summary = { branch: '', upstream: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 }
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.length === 0) continue
    if (line.startsWith('# branch.head ')) {
      summary.branch = line.slice('# branch.head '.length).trim()
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      summary.upstream = line.slice('# branch.upstream '.length).trim() || null
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+-(\d+)/)
      if (match !== null) {
        summary.ahead = Number(match[1])
        summary.behind = Number(match[2])
      }
      continue
    }
    if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const xy = line.slice(2, 4)
      if (xy.length < 2) continue
      if (xy[0] !== '.') summary.staged += 1
      if (xy[1] !== '.') summary.unstaged += 1
      continue
    }
    if (line.startsWith('? ')) summary.untracked += 1
  }
  return summary
}

/** @returns the plain changed-path lister used for dirty checks (`--porcelain` v1). */
async function dirtyEntries(exec, cwd) {
  const result = await git(exec, cwd, ['status', '--porcelain'])
  if (result.exitCode !== 0) return null
  return result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

/** @returns whether the worktree has unmerged (conflicted) paths. */
async function hasConflicts(exec, cwd) {
  const result = await git(exec, cwd, ['diff', '--name-only', '--diff-filter=U'])
  return result.exitCode === 0 && result.stdout.trim().length > 0
}

/**
 * Resolve the remote name a checkout pushes to: the current branch's upstream,
 * then `origin`, then the first configured remote.
 * @returns remote name, or null.
 */
async function resolveRemote(exec, cwd, upstream) {
  if (typeof upstream === 'string' && upstream.includes('/')) {
    const name = safeRefName(upstream.split('/')[0])
    if (name !== null) return name
  }
  const listed = await git(exec, cwd, ['remote'])
  if (listed.exitCode !== 0) return null
  const names = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (names.includes('origin')) return 'origin'
  return names.length > 0 ? names[0] : null
}

/**
 * Parse one git remote URL into provider information.
 *
 * Supported shapes: `git@host:owner/repo.git` (scp-like), `ssh://git@host:port/
 * owner/repo.git`, `https://host/owner/repo.git`, `http://`, `git://`. Local
 * paths (`/tmp/remote.git`, `file://...`) yield no provider.
 * @param raw - remote URL as printed by `git remote get-url`.
 * @returns `{ provider, host, owner, repo, webBase }` (nulls when unparseable).
 */
function parseRemoteUrl(raw) {
  const value = textOf(raw).trim().replace(/\/+$/, '')
  if (value.length === 0) return { provider: null, host: null, owner: null, repo: null, webBase: null }
  let host = null
  let path = ''
  const withScheme = value.match(/^(?:ssh|git|https?|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/)
  if (withScheme !== null) {
    host = withScheme[1]
    path = withScheme[2]
  } else if (!value.startsWith('/') && !value.startsWith('file://')) {
    const scpLike = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/)
    if (scpLike !== null) {
      host = scpLike[1]
      path = scpLike[2]
    }
  }
  if (host === null) return { provider: null, host: null, owner: null, repo: null, webBase: null }
  const cleaned = path
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const segments = cleaned.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 2) return { provider: null, host, owner: null, repo: null, webBase: null }
  const repo = segments[segments.length - 1]
  const owner = segments.slice(0, -1).join('/')
  const normalizedHost = host.toLowerCase().replace(/^www\./, '')
  const provider = normalizedHost === 'github.com' ? 'github' : normalizedHost === 'gitlab.com' ? 'gitlab' : normalizedHost === 'bitbucket.org' ? 'bitbucket' : 'other'
  const webBase = `https://${host}/${owner}/${repo}`
  return { provider, host, owner, repo, webBase }
}

/**
 * Build the provider "compare" URL for a branch pair.
 * Only GitHub produces a usable URL (docs/16 §2.1: non-GitHub → null).
 * @param remoteInfo - `parseRemoteUrl` output.
 * @param base - base branch or null.
 * @param branch - head branch or null.
 * @returns compare URL or null.
 */
function buildCompareUrl(remoteInfo, base, branch) {
  if (remoteInfo === null || remoteInfo.provider !== 'github' || remoteInfo.webBase === null) return null
  const encodeRef = (ref) => ref.split('/').map((part) => encodeURIComponent(part)).join('/')
  if (branch === null) return `${remoteInfo.webBase}/compare`
  if (base === null) return `${remoteInfo.webBase}/compare/${encodeRef(branch)}`
  return `${remoteInfo.webBase}/compare/${encodeRef(base)}...${encodeRef(branch)}`
}

/** @returns the env handed to a child process, merging an optional override. */
function processEnv(env) {
  if (!isRecord(env)) return undefined
  return { ...process.env, ...env }
}

/** @returns the options bag for one gh invocation. */
function ghOptions(input, cwd) {
  return { cwd, timeout: GIT_TIMEOUT_MS, env: processEnv(input.env) }
}

/**
 * Normalize a pull request number.
 * @returns positive integer, or null.
 */
function prNumber(value) {
  if (Number.isInteger(value) && value > 0) return value
  const parsed = Number.parseInt(textOf(value), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Map a workflow review verdict onto a gh review action.
 * @returns `'approve' | 'request-changes' | 'comment'`, or null.
 */
function reviewActionOf(verdict) {
  const value = textOf(verdict).trim().toLowerCase()
  if (value === 'approve' || value === 'approved' || value === 'approve_with_nits' || value === 'approve-with-nits') return 'approve'
  if (value === 'request_changes' || value === 'request-changes' || value === 'requestchanges' || value === 'block' || value === 'blocked') return 'request-changes'
  if (value === 'comment' || value === 'note') return 'comment'
  return null
}

/**
 * Map a merge method onto a local `git merge` strategy.
 * @returns `'no-ff' | 'ff-only' | 'squash'` (default `no-ff`), or null.
 */
function localMergeMethod(method) {
  const value = textOf(method).trim().toLowerCase()
  if (value === '') return 'no-ff'
  if (value === 'no-ff' || value === 'noff' || value === 'merge' || value === 'merge-commit') return 'no-ff'
  if (value === 'ff' || value === 'ff-only' || value === 'fast-forward') return 'ff-only'
  if (value === 'squash') return 'squash'
  return null
}

/**
 * Map a merge method onto the `gh pr merge` flag.
 * @returns `'squash' | 'merge' | 'rebase'` (default `squash`), or null.
 */
function ghMergeMethod(method) {
  const value = textOf(method).trim().toLowerCase()
  if (value === '') return 'squash'
  if (value === 'squash') return 'squash'
  if (value === 'merge' || value === 'no-ff' || value === 'noff' || value === 'merge-commit') return 'merge'
  // A rebase here is the *GitHub* merge strategy, not a local history rewrite.
  if (value === 'rebase') return 'rebase'
  return null
}

/**
 * Read the current state of one repository.
 * @param input - `{ cwd, exec }`.
 * @returns `{ ok, root, branch, clean, staged, unstaged, untracked, remote, ahead, behind }`.
 */
export async function gitStatus(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim()
    if (cwd.length === 0) return fail('gitStatus needs a cwd (repository path)')
    const root = await repoRoot(input.exec, cwd)
    if (root === null) return fail(`"${cwd}" is not a git repository`)
    const summary = await porcelainSummary(input.exec, root)
    if (summary === null) return fail('cannot read the git status of the repository')
    const remote = await resolveRemote(input.exec, root, summary.upstream)
    const staged = summary.staged
    const unstaged = summary.unstaged
    const untracked = summary.untracked
    return ok({
      root,
      branch: summary.branch,
      clean: staged + unstaged + untracked === 0,
      staged,
      unstaged,
      untracked,
      remote,
      ahead: summary.ahead,
      behind: summary.behind,
    })
  } catch (error) {
    return fail(`gitStatus failed: ${messageOf(error)}`)
  }
}

/**
 * Create or switch to one feature branch, refusing a dirty worktree and the
 * base branch itself (docs/16 §2.1).
 * @param input - `{ cwd, branch, base, exec }`.
 * @returns `{ ok, branch, base, created, switched }`.
 */
export async function gitEnsureBranch(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim()
    if (cwd.length === 0) return fail('gitEnsureBranch needs a cwd (repository path)')
    const branch = safeRefName(input.branch)
    if (branch === null) return fail(`"${textOf(input.branch)}" is not a valid branch name`)
    const root = await repoRoot(input.exec, cwd)
    if (root === null) return fail(`"${cwd}" is not a git repository`)
    const declaredBase = textOf(input.base).trim()
    const base = declaredBase.length > 0 ? safeRefName(declaredBase) : await detectBaseBranch(input.exec, root)
    if (base === null) return fail(`"${declaredBase}" is not a valid base branch name`)
    if (branch === base) return fail(`branch "${branch}" cannot be its own base; create a feature branch instead`)

    const dirty = await dirtyEntries(input.exec, root)
    if (dirty === null) return fail('cannot read the git status of the repository')
    if (dirty.length > 0) return fail(`the worktree is dirty (${dirty.length} change(s)); commit or clean it before switching branches`)

    const current = await currentBranch(input.exec, root)
    if (await branchExists(input.exec, root, branch)) {
      if (current === branch) return ok({ branch, base, created: false, switched: false })
      const switched = await git(input.exec, root, ['switch', branch])
      if (switched.exitCode !== 0) return fail(`cannot switch to branch "${branch}": ${tailOf(switched.stderr || switched.stdout, ERROR_TAIL)}`)
      return ok({ branch, base, created: false, switched: true })
    }

    if (!(await branchExists(input.exec, root, base))) return fail(`base branch "${base}" does not exist in this repository`)
    if (current !== base) {
      const toBase = await git(input.exec, root, ['switch', base])
      if (toBase.exitCode !== 0) return fail(`cannot switch to base branch "${base}": ${tailOf(toBase.stderr || toBase.stdout, ERROR_TAIL)}`)
    }
    const created = await git(input.exec, root, ['switch', '-c', branch])
    if (created.exitCode !== 0) return fail(`cannot create branch "${branch}": ${tailOf(created.stderr || created.stdout, ERROR_TAIL)}`)
    return ok({ branch, base, created: true, switched: true })
  } catch (error) {
    return fail(`gitEnsureBranch failed: ${messageOf(error)}`)
  }
}

/**
 * Commit only the requested files (path-scoped: nothing else can slip in).
 * @param input - `{ cwd, files, message, base, exec }` (`base` is optional; it
 *   is detected when omitted so commits to the baseline can be refused).
 * @returns `{ ok, sha, files }`.
 */
export async function gitCommit(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim()
    if (cwd.length === 0) return fail('gitCommit needs a cwd (repository path)')
    const files = Array.isArray(input.files)
      ? [...new Set(input.files.map((file) => textOf(file).trim()).filter((file) => file.length > 0))]
      : []
    if (files.length === 0) return fail('git commit needs at least one file; refusing to commit an empty file set')
    const message = textOf(input.message).trim()
    if (message.length === 0) return fail('a commit needs a non-empty message')
    const root = await repoRoot(input.exec, cwd)
    if (root === null) return fail(`"${cwd}" is not a git repository`)

    const declaredBase = textOf(input.base).trim()
    const base = declaredBase.length > 0 ? declaredBase : await detectBaseBranch(input.exec, root)
    const current = await currentBranch(input.exec, root)
    if (base !== null && current === base) return fail(`refusing to commit on the base branch "${base}"; create a feature branch first`)

    const added = await git(input.exec, root, ['add', '--', ...files])
    if (added.exitCode !== 0) return fail(`cannot stage the requested files: ${tailOf(added.stderr || added.stdout, ERROR_TAIL)}`)
    const staged = await git(input.exec, root, ['diff', '--cached', '--name-only', '--', ...files])
    if (staged.exitCode !== 0) return fail('cannot inspect the staged changes')
    const stagedFiles = staged.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (stagedFiles.length === 0) return fail('there is nothing to commit; the requested files have no staged changes')

    // `-- <files>` keeps the commit path-scoped even if something else was staged.
    const committed = await git(input.exec, root, ['commit', '-m', message, '--', ...files])
    if (committed.exitCode !== 0) return fail(`git commit failed: ${tailOf(committed.stderr || committed.stdout, ERROR_TAIL)}`)
    const revision = await git(input.exec, root, ['rev-parse', 'HEAD'])
    const sha = revision.exitCode === 0 ? revision.stdout.trim() : null
    return ok({ sha, files: stagedFiles })
  } catch (error) {
    return fail(`gitCommit failed: ${messageOf(error)}`)
  }
}

/**
 * Run the configured verify commands through `/bin/sh -lc`.
 * @param input - `{ cwd, commands, timeoutMs, exec }`.
 * @returns `{ ok, results: [{ command, exitCode, outputTail }] }`.
 */
export async function gitVerify(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim() || process.cwd()
    const commands = Array.isArray(input.commands) ? input.commands.map((command) => textOf(command)).filter((command) => command.trim().length > 0) : []
    if (commands.length === 0) return { ok: false, error: 'no verify commands are configured', results: [] }
    const timeout = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? Math.trunc(input.timeoutMs) : VERIFY_TIMEOUT_MS
    const results = []
    let failed = null
    for (const command of commands) {
      const run = await invoke(input.exec, SHELL, ['-lc', command], { cwd, timeout })
      const outputTail = tailOf(`${run.stdout}${run.stderr}`)
      const passed = run.exitCode === 0
      if (!passed && failed === null) failed = command
      results.push({ command, exitCode: run.exitCode, outputTail })
    }
    if (failed === null) return { ok: true, results }
    return { ok: false, error: `verify command failed: ${failed}`, results }
  } catch (error) {
    return { ok: false, error: `gitVerify failed: ${messageOf(error)}`, results: [] }
  }
}

/**
 * Push one branch to its remote (always `push -u`, never `--force`).
 * @param input - `{ cwd, remote, branch, base, exec }` (`base` optional).
 * @returns `{ ok, remote, branch, sha }`.
 */
export async function gitPush(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim()
    if (cwd.length === 0) return fail('gitPush needs a cwd (repository path)')
    const root = await repoRoot(input.exec, cwd)
    if (root === null) return fail(`"${cwd}" is not a git repository`)
    const declaredRemote = textOf(input.remote).trim()
    const remote = declaredRemote.length > 0 ? safeRefName(declaredRemote) : 'origin'
    if (remote === null) return fail(`"${declaredRemote}" is not a valid remote name`)
    const declaredBranch = textOf(input.branch).trim()
    const branch = declaredBranch.length > 0 ? safeRefName(declaredBranch) : await currentBranch(input.exec, root)
    if (branch === null) return fail(`"${declaredBranch}" is not a valid branch name`)
    if (branch.length === 0) return fail('gitPush needs a branch name (or a checked-out branch)')

    const declaredBase = textOf(input.base).trim()
    const base = declaredBase.length > 0 ? declaredBase : await detectBaseBranch(input.exec, root, remote)
    if (base !== null && branch === base) return fail(`refusing to push the base branch "${base}"; push a feature branch and open a PR instead`)

    const url = await git(input.exec, root, ['remote', 'get-url', remote])
    if (url.exitCode !== 0) return fail(`remote "${remote}" is not configured`)
    const pushed = await git(input.exec, root, ['push', '-u', remote, branch])
    if (pushed.exitCode !== 0) return fail(`git push failed: ${tailOf(pushed.stderr || pushed.stdout, ERROR_TAIL)}`)
    const revision = await git(input.exec, root, ['rev-parse', branch])
    return ok({ remote, branch, sha: revision.exitCode === 0 ? revision.stdout.trim() : null })
  } catch (error) {
    return fail(`gitPush failed: ${messageOf(error)}`)
  }
}

/**
 * Merge one branch into a target branch (`--no-ff` by default).
 * Merging into the base branch is the sanctioned release path; merging a
 * branch into itself is refused, and conflicts are aborted, never resolved.
 * @param input - `{ cwd, branch, into, method, message, exec }`.
 * @returns `{ ok, sha }`.
 */
export async function gitMerge(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim()
    if (cwd.length === 0) return fail('gitMerge needs a cwd (repository path)')
    const root = await repoRoot(input.exec, cwd)
    if (root === null) return fail(`"${cwd}" is not a git repository`)
    const branch = safeRefName(input.branch)
    if (branch === null) return fail(`"${textOf(input.branch)}" is not a valid source branch name`)
    const declaredInto = textOf(input.into).trim()
    const into = declaredInto.length > 0 ? safeRefName(declaredInto) : await detectBaseBranch(input.exec, root)
    if (into === null) return fail(`"${declaredInto}" is not a valid target branch name`)
    if (branch === into) return fail(`cannot merge a branch into itself (branch === into: "${branch}")`)
    if (!(await branchExists(input.exec, root, branch))) return fail(`source branch "${branch}" does not exist in this repository`)
    if (!(await branchExists(input.exec, root, into))) return fail(`target branch "${into}" does not exist in this repository`)

    const method = localMergeMethod(input.method)
    if (method === null) return fail(`unknown merge method "${textOf(input.method)}"; use no-ff, ff-only or squash`)
    const message = textOf(input.message).trim() || `Merge branch "${branch}" into "${into}"`

    const current = await currentBranch(input.exec, root)
    if (current !== into) {
      const switched = await git(input.exec, root, ['switch', into])
      if (switched.exitCode !== 0) return fail(`cannot switch to "${into}" to merge: ${tailOf(switched.stderr || switched.stdout, ERROR_TAIL)}`)
    }

    let result
    if (method === 'squash') {
      result = await git(input.exec, root, ['merge', '--squash', '--', branch])
      if (result.exitCode === 0) {
        const committed = await git(input.exec, root, ['commit', '-m', message])
        if (committed.exitCode !== 0) result = { ...committed, stderr: committed.stderr || committed.stdout }
      }
    } else if (method === 'ff-only') {
      result = await git(input.exec, root, ['merge', '--ff-only', branch])
    } else {
      result = await git(input.exec, root, ['merge', '--no-ff', '-m', message, branch])
    }

    if (result.exitCode !== 0) {
      const conflicted = await hasConflicts(input.exec, root)
      if (conflicted) {
        // Never auto-resolve: abort so the worktree is left as it was.
        await git(input.exec, root, ['merge', '--abort'])
        return fail(`merge of "${branch}" into "${into}" has conflicts; resolve them manually (the merge was aborted)`)
      }
      return fail(`git merge failed: ${tailOf(result.stderr || result.stdout, ERROR_TAIL)}`)
    }
    const revision = await git(input.exec, root, ['rev-parse', 'HEAD'])
    return ok({ sha: revision.exitCode === 0 ? revision.stdout.trim() : null, branch, into, method })
  } catch (error) {
    return fail(`gitMerge failed: ${messageOf(error)}`)
  }
}

/**
 * Describe one remote and, for GitHub, the compare URL for a branch pair.
 * @param input - `{ cwd, remote, base, branch, exec }` (`base`/`branch` optional).
 * @returns `{ ok, remote, url, provider, compareUrl }`.
 */
export async function gitRemoteInfo(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim()
    if (cwd.length === 0) return fail('gitRemoteInfo needs a cwd (repository path)')
    const root = await repoRoot(input.exec, cwd)
    if (root === null) return fail(`"${cwd}" is not a git repository`)
    const declaredRemote = textOf(input.remote).trim()
    const remote = declaredRemote.length > 0 ? safeRefName(declaredRemote) : 'origin'
    if (remote === null) return fail(`"${declaredRemote}" is not a valid remote name`)
    const url = await git(input.exec, root, ['remote', 'get-url', remote])
    if (url.exitCode !== 0) return fail(`remote "${remote}" is not configured`)
    const rawUrl = url.stdout.trim()
    const parsed = parseRemoteUrl(rawUrl)
    const base = safeRefName(input.base)
    const branch = safeRefName(input.branch)
    return ok({ remote, url: rawUrl, provider: parsed.provider, compareUrl: buildCompareUrl(parsed, base, branch) })
  } catch (error) {
    return fail(`gitRemoteInfo failed: ${messageOf(error)}`)
  }
}

/**
 * Probe the GitHub CLI: installed (`gh --version`) and logged in
 * (`gh auth status`). Never throws; a probe is always "ok".
 * @param input - `{ exec, env }`.
 * @returns `{ installed, authenticated, version }`.
 */
export async function ghAvailable(input = {}) {
  try {
    const options = ghOptions(input)
    const version = await invoke(input.exec, 'gh', ['--version'], options)
    if (version.exitCode !== 0) return { installed: false, authenticated: false, version: null }
    const match = version.stdout.match(/gh version\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)
    const parsedVersion = match !== null ? match[1] : null
    const auth = await invoke(input.exec, 'gh', ['auth', 'status'], options)
    return { installed: true, authenticated: auth.exitCode === 0, version: parsedVersion }
  } catch {
    return { installed: false, authenticated: false, version: null }
  }
}

/**
 * Create or update the pull request for one branch.
 * With a usable gh this creates/edits the PR; otherwise it returns
 * `mode: 'manual'` with a GitHub compare URL the Lead can open by hand.
 * @param input - `{ cwd, branch, base, title, body, remote, exec, env }`.
 * @returns `{ ok, mode: 'gh'|'manual', url, number }`.
 */
export async function gitPrCreateOrUpdate(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim()
    if (cwd.length === 0) return fail('gitPrCreateOrUpdate needs a cwd (repository path)')
    const root = await repoRoot(input.exec, cwd)
    if (root === null) return fail(`"${cwd}" is not a git repository`)
    const branch = safeRefName(input.branch) ?? (await currentBranch(input.exec, root))
    if (branch === null || branch.length === 0) return fail('gitPrCreateOrUpdate needs a branch name')
    const declaredBase = textOf(input.base).trim()
    const base = declaredBase.length > 0 ? safeRefName(declaredBase) : await detectBaseBranch(input.exec, root)
    if (base === null) return fail(`"${declaredBase}" is not a valid base branch name`)
    if (branch === base) return fail(`refusing to open a PR from the base branch "${base}"`)
    const title = textOf(input.title).trim() || `agentteam: ${branch}`
    const body = textOf(input.body)

    const remoteInfo = await gitRemoteInfo({ cwd: root, remote: input.remote, base, branch, exec: input.exec })
    if (!remoteInfo.ok || remoteInfo.provider !== 'github') {
      return ok({
        mode: 'manual',
        url: remoteInfo.ok ? remoteInfo.compareUrl : null,
        number: null,
        reason: remoteInfo.ok ? `remote "${remoteInfo.remote}" is not a GitHub host` : 'no usable remote',
      })
    }
    const gh = await ghAvailable({ exec: input.exec, env: input.env })
    if (!gh.installed || !gh.authenticated) {
      return ok({
        mode: 'manual',
        url: remoteInfo.compareUrl,
        number: null,
        reason: gh.installed ? 'gh is not authenticated' : 'gh is not installed',
      })
    }

    const options = ghOptions(input, root)
    const existing = await invoke(input.exec, 'gh', ['pr', 'view', branch, '--json', 'number,url'], options)
    if (existing.exitCode === 0) {
      let parsed = null
      try {
        parsed = JSON.parse(existing.stdout)
      } catch {
        parsed = null
      }
      const number = prNumber(parsed?.number)
      const url = textOf(parsed?.url).trim() || null
      if (number === null) return fail('gh found a pull request but reported no usable number')
      const edited = await invoke(input.exec, 'gh', ['pr', 'edit', String(number), '--title', title, '--body', body, '--base', base], options)
      if (edited.exitCode !== 0) return fail(`gh pr edit failed: ${tailOf(edited.stderr || edited.stdout, ERROR_TAIL)}`)
      return ok({ mode: 'gh', url, number, updated: true })
    }

    const created = await invoke(input.exec, 'gh', ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body], options)
    if (created.exitCode !== 0) return fail(`gh pr create failed: ${tailOf(created.stderr || created.stdout, ERROR_TAIL)}`)
    const url = created.stdout.trim().split('\n').map((line) => line.trim()).filter((line) => line.length > 0).pop() ?? null
    const numberMatch = typeof url === 'string' ? url.match(/\/pull\/(\d+)/) : null
    return ok({ mode: 'gh', url, number: numberMatch !== null ? Number(numberMatch[1]) : null, updated: false })
  } catch (error) {
    return fail(`gitPrCreateOrUpdate failed: ${messageOf(error)}`)
  }
}

/**
 * Submit a review verdict on a pull request (manual mode records the intent).
 * @param input - `{ cwd, number, verdict, body, exec, env }`.
 * @returns `{ ok, mode: 'gh'|'manual', action, number }`.
 */
export async function gitPrReview(input = {}) {
  try {
    const number = prNumber(input.number)
    if (number === null) return fail('gitPrReview needs a pull request number')
    const action = reviewActionOf(input.verdict)
    if (action === null) return fail(`unknown review verdict "${textOf(input.verdict)}"; expected approve / approve_with_nits / request_changes / block / comment`)
    const gh = await ghAvailable({ exec: input.exec, env: input.env })
    if (!gh.installed || !gh.authenticated) {
      return ok({ mode: 'manual', action, number, reason: gh.installed ? 'gh is not authenticated' : 'gh is not installed' })
    }
    const body = textOf(input.body).trim()
    const args = ['pr', 'review', String(number), `--${action}`]
    if (body.length > 0) args.push('--body', body)
    const reviewed = await invoke(input.exec, 'gh', args, ghOptions(input, textOf(input.cwd).trim() || undefined))
    if (reviewed.exitCode !== 0) return fail(`gh pr review failed: ${tailOf(reviewed.stderr || reviewed.stdout, ERROR_TAIL)}`)
    return ok({ mode: 'gh', action, number })
  } catch (error) {
    return fail(`gitPrReview failed: ${messageOf(error)}`)
  }
}

/**
 * Merge a pull request (manual mode hands the local merge to the caller).
 * @param input - `{ cwd, number, method, exec, env }`.
 * @returns `{ ok, mode: 'gh'|'manual', sha }`.
 */
export async function gitPrMerge(input = {}) {
  try {
    const number = prNumber(input.number)
    if (number === null) return fail('gitPrMerge needs a pull request number')
    const method = ghMergeMethod(input.method)
    if (method === null) return fail(`unknown merge method "${textOf(input.method)}"; use squash, merge or rebase`)
    const gh = await ghAvailable({ exec: input.exec, env: input.env })
    if (!gh.installed || !gh.authenticated) {
      return ok({ mode: 'manual', number, method, sha: null, reason: gh.installed ? 'gh is not authenticated' : 'gh is not installed' })
    }
    const options = ghOptions(input, textOf(input.cwd).trim() || undefined)
    const merged = await invoke(input.exec, 'gh', ['pr', 'merge', String(number), `--${method}`], options)
    if (merged.exitCode !== 0) return fail(`gh pr merge failed: ${tailOf(merged.stderr || merged.stdout, ERROR_TAIL)}`)
    const view = await invoke(input.exec, 'gh', ['pr', 'view', String(number), '--json', 'mergeCommit,headRefOid'], options)
    let sha = null
    if (view.exitCode === 0) {
      try {
        const parsed = JSON.parse(view.stdout)
        sha = textOf(parsed?.mergeCommit?.oid).trim() || textOf(parsed?.headRefOid).trim() || null
      } catch {
        sha = null
      }
    }
    return ok({ mode: 'gh', number, method, sha })
  } catch (error) {
    return fail(`gitPrMerge failed: ${messageOf(error)}`)
  }
}

/**
 * Create one isolated git worktree (docs/19 §6 P1-2).
 *
 * Worktrees are the only real isolation git offers without rewriting the
 * shared checkout; callers serialize item work because members share a cwd.
 * @param input - `{ cwd, path, branch, startPoint?, exec }`.
 * @returns `{ ok, path, branch }`.
 */
export async function gitWorktreeAdd(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim()
    if (cwd.length === 0) return fail('gitWorktreeAdd needs a cwd (repository path)')
    const root = await repoRoot(input.exec, cwd)
    if (root === null) return fail(`"${cwd}" is not a git repository`)
    const target = textOf(input.path).trim()
    if (target.length === 0 || target.startsWith('/')) return fail('worktreeAdd needs a relative path')
    const branch = safeRefName(input.branch)
    if (branch === null) return fail(`"${textOf(input.branch)}" is not a valid branch name`)
    const start = textOf(input.startPoint).trim()
    const args = ['worktree', 'add', '-b', branch, '--', target]
    if (start.length > 0) args.push(start)
    const added = await git(input.exec, root, args)
    if (added.exitCode !== 0) return fail(`worktree add failed: ${tailOf(added.stderr || added.stdout, ERROR_TAIL)}`)
    return ok({ path: target, branch })
  } catch (error) {
    return fail(`gitWorktreeAdd failed: ${messageOf(error)}`)
  }
}

/** Remove one worktree (the branch is kept). */
export async function gitWorktreeRemove(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim()
    if (cwd.length === 0) return fail('gitWorktreeRemove needs a cwd (repository path)')
    const root = await repoRoot(input.exec, cwd)
    if (root === null) return fail(`"${cwd}" is not a git repository`)
    const target = textOf(input.path).trim()
    if (target.length === 0) return fail('worktreeRemove needs a path')
    const removed = await git(input.exec, root, ['worktree', 'remove', '--', target])
    if (removed.exitCode !== 0) return fail(`worktree remove failed: ${tailOf(removed.stderr || removed.stdout, ERROR_TAIL)}`)
    return ok({ path: target })
  } catch (error) {
    return fail(`gitWorktreeRemove failed: ${messageOf(error)}`)
  }
}

/** @returns the registered worktrees `{ ok, worktrees: [{path, branch}] }`. */
export async function gitWorktreeList(input = {}) {
  try {
    const cwd = textOf(input.cwd).trim()
    if (cwd.length === 0) return fail('gitWorktreeList needs a cwd (repository path)')
    const root = await repoRoot(input.exec, cwd)
    if (root === null) return fail(`"${cwd}" is not a git repository`)
    const listed = await git(input.exec, root, ['worktree', 'list', '--porcelain'])
    if (listed.exitCode !== 0) return fail(`worktree list failed: ${tailOf(listed.stderr || listed.stdout, ERROR_TAIL)}`)
    const worktrees = []
    let current = {}
    for (const line of listed.stdout.split('\n')) {
      if (line.startsWith('worktree ')) current = { path: line.slice(9).trim(), branch: null }
      else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
        worktrees.push(current)
        current = {}
      }
    }
    return ok({ worktrees })
  } catch (error) {
    return fail(`gitWorktreeList failed: ${messageOf(error)}`)
  }
}
