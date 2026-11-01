/**
 * Run-state persistence: one JSON blackboard per Team under the working
 * directory, written atomically and mutated under a per-file in-process lock.
 *
 * Agent Teams members run in one Host process and share a filesystem, so a
 * process-local lock plus read-modify-write is sufficient to prevent lost
 * updates between members. Cross-process writers are not supported, which
 * matches the runtime: a Team lives in exactly one Host process.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

/** Pending tail promise per state file, so mutations serialize in arrival order. */
const locks = new Map()

/**
 * Serialize one async operation behind the previous operation on the same key.
 * @param key - lock identity (absolute state file path).
 * @param task - operation to run exclusively.
 * @returns the operation result.
 */
export function withLock(key, task) {
  const previous = locks.get(key) ?? Promise.resolve()
  const run = previous.then(() => task(), () => task())
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  locks.set(key, settled)
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return run
}

/** Error type for a missing or unusable run state file. */
export class RunStateError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RunStateError'
    this.code = code
  }
}

/**
 * Build the persistence layer bound to one plugin instance.
 * @param options - `{ ctx, settings }` from the plugin.
 * @returns state accessors used by tool implementations.
 */
export function createStore({ ctx, settings }) {
  /** Last summary per state path, used by the synchronous prompt-context hook. */
  const summaries = new Map()
  /**
   * Write-through state cache. It is the only copy when `writeArtifacts` is
   * off, and it keeps a deleted board readable without silently resetting the
   * run; disk stays authoritative whenever it has a readable value.
   */
  const memoryStates = new Map()

  /** Deep-clone one JSON value so callers can never mutate cached state. */
  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value))
  }

  /**
   * Resolve the Team working directory. Every member resolves the Lead's
   * directory so a teammate with a different Session cwd still sees one board.
   * @param agent - exact live Agent.
   * @returns absolute working directory.
   */
  function workingDir(agent) {
    const membership = ctx.agentTeams.tryMembership(agent)
    const owner = membership?.root ?? agent
    const session = owner.session
    try {
      return ctx.workingDirectory.get(session)
    } catch {
      const fallback = ctx.workingDirectory.defaultDirectory
      if (typeof fallback === 'string' && fallback.length > 0) return fallback
      throw new RunStateError('the workflow plugin cannot resolve the Team working directory', 'WORKFLOW_NO_CWD')
    }
  }

  /** @returns the artifact root directory for one member. */
  function artifactRoot(agent) {
    const dir = settings.artifactsDir
    return isAbsolute(dir) ? dir : join(workingDir(agent), dir)
  }

  /**
  * Resolve the Team identity that owns one board. Every member resolves the
  * Lead's Session id, so a second top-level Session in the same workspace can
  * never read, gate, or replace another Team's run.
  * @param agent - exact live Agent.
  * @returns a filesystem-safe Team id.
  */
  function teamIdOf(agent) {
    const membership = ctx.agentTeams.tryMembership(agent)
    const owner = membership?.root ?? agent
    return String(owner.id ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  }

  /** @returns the absolute path of the run state file for this member's Team. */
  function statePath(agent) {
    return join(artifactRoot(agent), 'teams', teamIdOf(agent), 'state.json')
  }

  /** @returns the absolute directory of one Team's board. */
  function teamDir(agent) {
    return join(artifactRoot(agent), 'teams', teamIdOf(agent))
  }

  /**
   * Read the current run state.
   * @param agent - exact live Agent.
   * @returns parsed state, or `null` when no run was planned yet.
   */
  async function readState(agent) {
    const path = statePath(agent)
    const memorized = memoryStates.get(path)
    if (!settings.writeArtifacts && memorized !== undefined) return cloneJson(memorized)
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return memorized === undefined ? null : cloneJson(memorized)
      throw new RunStateError(`cannot read workflow state at ${path}: ${error.message}`, 'WORKFLOW_STATE_UNREADABLE')
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new RunStateError(`workflow state at ${path} is not valid JSON: ${error.message}`, 'WORKFLOW_STATE_CORRUPT')
    }
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.runId !== 'string') {
      throw new RunStateError(`workflow state at ${path} is not a workflow run record`, 'WORKFLOW_STATE_CORRUPT')
    }
    memoryStates.set(path, parsed)
    summaries.set(path, summarize(parsed))
    return parsed
  }

  /** @returns the cached synchronous summary for prompt context, or `undefined`. */
  function cachedSummary(agent) {
    try {
      return summaries.get(statePath(agent))
    } catch {
      return undefined
    }
  }

  /**
   * Rewrite one state file atomically (temporary file + rename).
   * @param agent - exact live Agent.
   * @param state - complete next state.
   */
  async function writeState(agent, state) {
    const path = statePath(agent)
    memoryStates.set(path, cloneJson(state))
    summaries.set(path, summarize(state))
    if (!settings.writeArtifacts) return
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }

  /**
   * Read-modify-write one run state under an exclusive lock.
   * @param agent - exact live Agent.
   * @param mutate - receives current state (or `null`); returns the next state
   *   or `undefined` to leave the file unchanged.
   * @returns the committed state.
   */
  async function mutateState(agent, mutate) {
    const path = statePath(agent)
    return withLock(path, async () => {
      const current = await readState(agent)
      const next = await mutate(current)
      const committed = next === undefined ? current : next
      if (committed === null || committed === undefined) {
        throw new RunStateError('workflow mutation produced no run state', 'WORKFLOW_NO_RUN')
      }
      await writeState(agent, committed)
      return committed
    })
  }

  /**
   * Write one artifact beside the state file.
   * @param agent - exact live Agent.
   * @param name - file name below the artifact root.
   * @param content - UTF-8 text.
   * @returns absolute artifact path, or `null` when artifacts are disabled.
   */
  async function writeArtifact(agent, name, content) {
    if (!settings.writeArtifacts) return null
    const directory = artifactRoot(agent)
    const target = join(directory, name)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, target)
    return target
  }

  /** @returns the artifact root path, for messages and reports. */
  function describeRoot(agent) {
    try {
      return artifactRoot(agent)
    } catch {
      return settings.artifactsDir
    }
  }

  /** Run one operation while holding this Team's board lock. */
  function lock(agent, task) {
    return withLock(statePath(agent), task)
  }

  return { readState, mutateState, writeState, writeArtifact, artifactRoot, statePath, teamDir, teamIdOf, workingDir, cachedSummary, describeRoot, lock }
}

/**
 * Compact, cache-stable summary used by the injected prompt context.
 * @param state - one run state.
 * @returns at most two short lines of text.
 */
export function summarize(state) {
  const pending = state.items.filter((item) => item.status !== 'approved').length
  return `Agent Team Workflow run ${state.runId} phase ${state.phase}; ${pending}/${state.items.length} work item(s) not yet approved. Call team_flow_status for the exact next action.`
}
