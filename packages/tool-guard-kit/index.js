/**
 * @local/dsh-tool-guard-kit — a reusable per-agent native-tool sandbox for
 * DeepSeek Harness Cordis plugins.
 *
 * DSH exposes `ctx.tools.guard(fn)`: a synchronous, monotonic denial hook that
 * runs after the `tools/pre-execute` waterfall and before the tool body. A
 * plugin registers one guard, inspects `exec.agent` / `exec.name`, and returns
 * a string to deny the call. This module packages the three recurring pieces:
 *
 *   1. tool classification (read-only safety: write/edit/bash/terminal, ...);
 *   2. a synchronous policy table (`readOnly` / `allow` / `deny`) keyed by a
 *      caller-resolved subject (role, team member, tier, ...);
 *   3. registration and lifecycle management around `ctx.tools.guard`.
 *
 * Design rules: zero dependencies, total functions (never throw), fail-open by
 * default (a sandbox bug must not brick normal execution), optional audit ring.
 */

/** Tools that can modify the workspace or execute arbitrary commands. */
export const DEFAULT_MUTATING_TOOLS = Object.freeze(['write', 'edit', 'bash', 'terminal'])

/** Prefixes whose family is mutating even when the suffix varies. */
export const DEFAULT_MUTATING_PREFIXES = Object.freeze(['terminal', 'str_replace'])

/**
 * @param toolName - model-facing tool name.
 * @param options - `{ tools?, prefixes? }` classification overrides.
 * @returns whether calling that tool can mutate the environment.
 */
export function isMutatingTool(toolName, options = {}) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false
  const tools = Array.isArray(options.tools) ? options.tools : DEFAULT_MUTATING_TOOLS
  const prefixes = Array.isArray(options.prefixes) ? options.prefixes : DEFAULT_MUTATING_PREFIXES
  if (tools.includes(toolName)) return true
  return prefixes.some((prefix) => toolName === prefix || toolName.startsWith(`${prefix}_`))
}

/** @returns a normalized string list (trimmed, de-duplicated, bounded). */
function stringList(value, limit = 256) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    if (text.length === 0) continue
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Normalize a raw policy table into `Map<role, {readOnly, allow, deny}>` with
 * Sets. Unknown fields are ignored, so a plugin's own settings object can be
 * passed directly.
 * @param raw - object map or Map of role → `{ readOnly?, allow?, deny? }`.
 * @returns normalized Map (never null).
 */
export function normalizePolicies(raw) {
  const table = new Map()
  if (raw === null || raw === undefined) return table
  const entries = raw instanceof Map ? raw.entries() : Object.entries(raw)
  for (const [rawKey, rawPolicy] of entries) {
    const key = String(rawKey).trim()
    if (key.length === 0) continue
    if (rawPolicy === null || typeof rawPolicy !== 'object') continue
    const policy = {
      readOnly: rawPolicy.readOnly === true,
      allow: stringList(rawPolicy.allow),
      deny: stringList(rawPolicy.deny),
    }
    table.set(key, policy)
  }
  return table
}

/** @returns a cloned audit entry so callers cannot mutate the ring. */
function auditEntry(at, toolName, subject, reason) {
  return Object.freeze({
    at,
    tool: toolName,
    subject: subject === null || subject === undefined ? null : auditSubject(subject),
    reason,
  })
}

/** @returns a plain, lossless subject summary for the audit ring. */
function auditSubject(subject) {
  try {
    return { key: subject.key ?? null, role: subject.role ?? null }
  } catch {
    return null
  }
}

/**
 * Resolve a policy for one subject.
 * @param subject - `{ key, role }` from the subject resolver, or null.
 * @param policies - normalized policy table.
 * @returns policy object or null.
 */
function policyOf(subject, policies) {
  if (subject === null || subject === undefined) return null
  const role = subject.role
  if (role === null || role === undefined) return null
  return policies.get(String(role)) ?? null
}

/**
 * Create one sandbox instance (pure; no DSH dependency).
 * @param options - `{ policies?, resolveSubject?, resolvePolicy?, failOpen?, tools?, prefixes?, onDeny?, auditLimit?, now? }`.
 * @returns `{ check, setPolicies, audit, stats, policies }`.
 */
export function createToolSandbox(options = {}) {
  let policies = normalizePolicies(options.policies)
  const resolveSubject = typeof options.resolveSubject === 'function' ? options.resolveSubject : () => null
  const resolvePolicy = typeof options.resolvePolicy === 'function' ? options.resolvePolicy : null
  const failOpen = options.failOpen !== false
  const classification = { tools: options.tools, prefixes: options.prefixes }
  const onDeny = typeof options.onDeny === 'function' ? options.onDeny : null
  const auditLimit = Number.isInteger(options.auditLimit) && options.auditLimit > 0 ? Math.min(options.auditLimit, 512) : 64
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  const ring = []
  const stats = { checked: 0, denied: 0, failed: 0 }

  const record = (toolName, subject, reason) => {
    stats.denied += 1
    const entry = auditEntry(now(), toolName, subject, reason)
    ring.push(entry)
    if (ring.length > auditLimit) ring.shift()
    if (onDeny !== null) {
      try {
        onDeny({ tool: toolName, subject: entry.subject, reason })
      } catch {
        /* an observer must not change the decision */
      }
    }
    return reason
  }

  const deny = (toolName, subject, policy) => {
    if (policy.readOnly === true && isMutatingTool(toolName, classification)) {
      return record(toolName, subject, `tool "${toolName}" is blocked: role "${policy.role ?? subject?.role}" is read-only`)
    }
    if (policy.deny.includes(toolName)) {
      return record(toolName, subject, `tool "${toolName}" is blocked: role "${policy.role ?? subject?.role}" denies it`)
    }
    if (policy.allow.length > 0 && !policy.allow.includes(toolName)) {
      return record(toolName, subject, `tool "${toolName}" is blocked: role "${policy.role ?? subject?.role}" may only use ${policy.allow.join(', ')}`)
    }
    return undefined
  }

  /**
   * Decide one call. Synchronous and total: returns a denial reason or
   * undefined. Never throws.
   * @param exec - DSH tool execution (`{ name, agent, arguments, ... }`).
   * @returns denial string or undefined.
   */
  const check = (exec) => {
    try {
      stats.checked += 1
      const toolName = typeof exec?.name === 'string' ? exec.name : ''
      if (toolName.length === 0) return undefined
      let subject
      try {
        subject = resolveSubject(exec)
      } catch {
        stats.failed += 1
        return failOpen ? undefined : record(toolName, null, `tool "${toolName}" is blocked: the sandbox could not resolve a subject for this caller`)
      }
      if (subject === null || subject === undefined) return undefined
      if (typeof subject !== 'object') subject = null
      if (subject === null) return undefined
      let policy
      try {
        policy = resolvePolicy !== null ? resolvePolicy(subject, exec) : policyOf(subject, policies)
      } catch {
        stats.failed += 1
        return failOpen ? undefined : record(toolName, subject, `tool "${toolName}" is blocked: the sandbox could not resolve a policy for this caller`)
      }
      if (policy === null || policy === undefined) return undefined
      const normalized = {
        role: subject.role ?? null,
        readOnly: policy.readOnly === true,
        allow: stringList(policy.allow),
        deny: stringList(policy.deny),
      }
      return deny(toolName, subject, normalized)
    } catch {
      stats.failed += 1
      return undefined
    }
  }

  return {
    check,
    /** Replace the policy table in place (sync). */
    setPolicies(next) {
      policies = normalizePolicies(next)
      return policies
    },
    /** @returns the normalized policy table (read-only view). */
    get policies() {
      return policies
    },
    /** @returns the most recent denial entries (oldest first). */
    audit(limit) {
      const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, ring.length) : ring.length
      return ring.slice(ring.length - count).map((entry) => ({ ...entry }))
    },
    /** @returns live counters `{ checked, denied, failed }`. */
    get stats() {
      return { ...stats }
    },
  }
}

/**
 * Install one sandbox as the plugin's global tool guard.
 *
 * Call inside `apply`: `installToolSandbox(ctx, { policies, resolveSubject,
 * failOpen: true })`. Registration is wrapped in `ctx.effect`, so the guard is
 * removed on plugin dispose/HMR. Non-Team plugins can use a generic subject
 * resolver: `(exec) => ({ key: exec.agent?.id, role: 'tier-a' })`.
 *
 * @param ctx - Cordis plugin context exposing `tools.guard` and `effect`.
 * @param options - createToolSandbox options plus `{ label?, failOpen? }`.
 * @returns the sandbox instance (with `dispose()` added).
 */
export function installToolSandbox(ctx, options = {}) {
  const sandbox = createToolSandbox(options)
  const label = typeof options.label === 'string' && options.label.length > 0 ? options.label : 'tool-guard-kit.sandbox()'
  let disposeGuard = null
  const uninstall = () => {
    if (disposeGuard === null) return
    const current = disposeGuard
    disposeGuard = null
    try {
      current()
    } catch {
      /* already disposed by the owner */
    }
  }
  ctx.effect(() => {
    disposeGuard = ctx.tools.guard((exec) => sandbox.check(exec))
    return uninstall
  }, label)
  return { ...sandbox, dispose: uninstall }
}

/**
 * Resolve a caller's role from a plugin-owned state object.
 *
 * The reference shape is Agent Team Workflow's board: an explicit
 * `roleAssignments[name]`, or the unique role of the items that member owns.
 * Other plugins can pass their own resolver instead.
 *
 * @param state - plugin state (any shape; unknown shapes yield null).
 * @param memberName - the member key to look up.
 * @returns role name or null.
 */
export function roleFromTeamState(state, memberName) {
  try {
    if (state === null || state === undefined || typeof state !== 'object') return null
    const explicit = state.roleAssignments?.[memberName]
    if (typeof explicit === 'string' && explicit.length > 0) return explicit
    const owned = new Set()
    for (const item of Array.isArray(state.items) ? state.items : []) {
      if (item?.owner === memberName && typeof item.role === 'string' && item.role.length > 0) owned.add(item.role)
    }
    return owned.size === 1 ? [...owned][0] : null
  } catch {
    return null
  }
}

/**
 * Build a subject resolver for Agent Teams based plugins.
 *
 * The returned function maps a tool execution to the calling teammate:
 * Lead and non-Team Agents resolve to null (never blocked). `stateFor(exec)` is
 * a synchronous state getter (e.g. a store's in-process cache) and
 * `roleFromState(state, name)` extracts the role synchronously, so the kit
 * stays agnostic about the plugin's state shape.
 *
 * @param input - `{ ctx, stateFor, roleFromState? }`.
 * @returns synchronous subject resolver.
 */
export function createTeamSubjectResolver(input = {}) {
  const ctx = input.ctx
  const stateFor = typeof input.stateFor === 'function' ? input.stateFor : () => null
  const roleFromState = typeof input.roleFromState === 'function' ? input.roleFromState : roleFromTeamState
  return (exec) => {
    try {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return null
      const teams = ctx?.agentTeams
      if (teams === undefined || typeof teams.tryMembership !== 'function') return null
      const membership = teams.tryMembership(agent)
      if (membership === null || membership === undefined || membership.role !== 'teammate') return null
      const state = stateFor(exec)
      const role = roleFromState(state, membership.name)
      return { key: membership.name, role: role ?? null }
    } catch {
      return null
    }
  }
}
