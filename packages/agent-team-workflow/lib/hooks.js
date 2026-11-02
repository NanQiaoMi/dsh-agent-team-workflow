/**
 * Team lifecycle hooks (workflow v1.4).
 *
 * The official Claude Code agent teams expose shell hooks that can block a
 * task from being created or completed. This module implements the same
 * contract for this plugin's own lifecycle: every handler is a shell command,
 * receives the event as JSON on stdin, and exits with code 2 to veto the
 * action. The module is total: a malformed handler or a crashing command is
 * reported as data, never as an exception.
 */

import { execFile } from 'node:child_process'

/** Default per-hook timeout; a slow hook must not hang the workflow. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Maximum timeout a configuration may request. */
const MAX_TIMEOUT_MS = 600_000

/** Event names the plugin knows how to fire. */
export const HOOK_EVENTS = Object.freeze(['taskCreated', 'taskCompleted', 'teammateIdle'])

/**
 * Run one handler's command with the event JSON on stdin.
 * @returns `{ command, exitCode, blocked, output }`.
 */
function runOne(handler, payload, context) {
  const command = typeof handler?.command === 'string' ? handler.command.trim() : ''
  const timeoutMs = Number.isInteger(handler?.timeoutMs) ? Math.min(Math.max(handler.timeoutMs, 1_000), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
  const cwd = typeof handler?.cwd === 'string' && handler.cwd.trim().length > 0 ? handler.cwd.trim() : context.cwd
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-lc', command], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: context.env }, (error, stdout, stderr) => {
      const exitCode = typeof error?.code === 'number' ? error.code : error === null ? 0 : 1
      const output = `${String(stdout ?? '')}${stderr === undefined || stderr === null ? '' : String(stderr)}`.trim()
      resolve({ command, exitCode, blocked: exitCode === 2, output: output.slice(-4000) })
    })
    try {
      child.stdin?.end(`${JSON.stringify(payload)}\n`)
    } catch {
      /* the command may exit before reading stdin; that is still a result */
    }
  })
}

/**
 * Fire every handler configured for one event.
 *
 * Handlers run in configuration order; a handler that exits 2 vetoes the
 * action, so later handlers do not run. A handler that fails for another
 * reason is reported but does not veto (it matches the shell-hook contract
 * where only exit code 2 blocks).
 * @param options - `{ handlers, event, payload, cwd, env }`.
 * @returns `{ blocked, results }`.
 */
export async function fireHooks(options) {
  const handlers = Array.isArray(options?.handlers) ? options.handlers : []
  const results = []
  for (const handler of handlers) {
    const result = await runOne(handler, { event: options.event, ...options.payload }, { cwd: options.cwd, env: options.env })
    results.push(result)
    if (result.blocked) return { blocked: true, results }
  }
  return { blocked: false, results }
}
