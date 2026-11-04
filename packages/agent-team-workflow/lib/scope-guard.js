/**
 * Runtime write-scope guard (v1.16).
 *
 * `strictScopes` only checks reported files at gate time. This guard closes the
 * earlier hole: a teammate's direct `write` / `edit` / `str_replace_*` call is
 * denied synchronously when the target path falls outside the write scopes of
 * the item that member currently owns. Reviewers own no item, so they cannot
 * modify files at all while reviewing (review independence).
 *
 * Deliberately fail-open: no board, no membership, unparseable arguments or an
 * internal error leave normal tool execution untouched. `bash` can still write
 * through the shell; that limitation is documented instead of guessing at
 * command strings.
 */

import { isAbsolute, normalize, relative, resolve } from 'node:path'

/** Native tools whose arguments carry a single `file_path`. */
const SCOPED_TOOLS = new Set(['write', 'edit'])

/** A member may modify files while any owned item is still active. */
const ACTIVE_STATUSES = new Set(['pending', 'running', 'changes_requested', 'in_review', 'escalated'])

/** @returns whether a native tool writes one file path. */
export function isScopedWriteTool(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false
  return SCOPED_TOOLS.has(toolName) || toolName.startsWith('str_replace')
}

/** @returns the path argument of a scoped tool call, or ''. */
function targetPathOf(exec) {
  const args = exec !== null && typeof exec === 'object' ? exec.arguments : null
  if (args === null || typeof args !== 'object') return ''
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

/** @returns a normalized workspace-relative path, or null when it escapes the workspace. */
export function toWorkspacePath(cwd, raw) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const absolute = isAbsolute(raw) ? normalize(raw) : resolve(cwd, raw)
    const rel = relative(cwd, absolute)
    if (rel.startsWith('..')) return null
    return rel === '' ? '.' : rel.split('\\').join('/')
  } catch {
    return null
  }
}

/** @returns whether one workspace-relative path is covered by one declared scope. */
export function pathInScope(workspacePath, scope) {
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) return false
  if (typeof scope !== 'string' || scope.trim().length === 0) return false
  const declared = scope.trim().split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (declared.length === 0) return false
  if (declared === '.') return true
  return workspacePath === declared || workspacePath.startsWith(declared + '/')
}

/** @returns the unique active write scopes of the items one member owns. */
export function activeScopesOf(state, memberName) {
  const scopes = []
  const ids = []
  const seen = new Set()
  for (const item of Array.isArray(state?.items) ? state.items : []) {
    if (item?.owner !== memberName) continue
    if (!ACTIVE_STATUSES.has(String(item.status))) continue
    ids.push(item.id)
    for (const raw of Array.isArray(item.writeScopes) ? item.writeScopes : []) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      const scope = raw.trim()
      if (seen.has(scope)) continue
      seen.add(scope)
      scopes.push(scope)
    }
  }
  return { ids, scopes }
}

/**
 * Decide one native tool call against the caller's declared write scope.
 * @param exec - DSH tool execution (`{ name, agent, arguments }`).
 * @param ctx - plugin context (needs `agentTeams.tryMembership`).
 * @param store - run store (`cachedState`, `workingDir`).
 * @param settings - resolved plugin settings (`enforceWriteScopes`).
 * @returns a denial reason, or undefined to allow.
 */
export function scopeGuardReason(exec, ctx, store, settings) {
  if (settings?.enforceWriteScopes !== true) return undefined
  try {
    const toolName = typeof exec?.name === 'string' ? exec.name : ''
    if (!isScopedWriteTool(toolName)) return undefined
    const agent = exec?.agent
    if (agent === undefined || agent === null) return undefined
    const membership = ctx?.agentTeams?.tryMembership?.(agent)
    if (membership === undefined || membership === null || membership.role !== 'teammate') return undefined
    const state = store.cachedState(membership.root)
    if (state === null || state === undefined) return undefined
    const { ids, scopes } = activeScopesOf(state, membership.name)
    if (scopes.length === 0) {
      return (
        `tool "${toolName}" is blocked: member "${membership.name}" has no active work item with a declared write scope` +
        (ids.length === 0 ? ' (reviewers never write)' : '')
      )
    }
    const raw = targetPathOf(exec)
    if (raw === '') return undefined
    const cwd = store.workingDir(agent)
    const workspacePath = toWorkspacePath(cwd, raw)
    if (workspacePath === null) {
      return `tool "${toolName}" is blocked: "${raw}" escapes the Team working directory`
    }
    if (!scopes.some((scope) => pathInScope(workspacePath, scope))) {
      return `tool "${toolName}" is blocked: "${workspacePath}" is outside the declared write scope of ${ids.join(', ')} (${scopes.join(', ')})`
    }
    return undefined
  } catch {
    return undefined
  }
}
