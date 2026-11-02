/**
 * Native-tool sandbox for Team members (docs/23 §2, docs/25).
 *
 * DSH exposes `tools.guard()`: a synchronous, monotonic denial that runs after
 * the `tools/pre-execute` waterfall. The plugin registers one global guard;
 * when the calling Agent is a teammate whose role names a tool policy, the
 * guard rejects calls to tools the role may not use. This is enforcement at the
 * tool-call boundary (not an OS sandbox): a blocked tool never runs.
 */

/** Native tools that can change the workspace or run arbitrary commands. */
export const NATIVE_MUTATING_TOOLS = Object.freeze(['write', 'edit', 'bash', 'terminal'])

/** Workflow tools enforce their own role policy in `tools.js`. */
const WORKFLOW_TOOL_PREFIX = 'team_flow_'

/**
 * Resolve one member's role name from the board: explicit assignment first,
 * then the unique role of the items it owns.
 * @param state - cached run state.
 * @param memberName - member name from the Team roster.
 * @returns role name or null.
 */
export function memberRoleOf(state, memberName) {
  if (state === null || state === undefined) return null
  const explicit = state.roleAssignments?.[memberName]
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const roles = new Set()
  for (const item of Array.isArray(state.items) ? state.items : []) {
    if (item.owner === memberName && typeof item.role === 'string' && item.role.length > 0) roles.add(item.role)
  }
  return roles.size === 1 ? [...roles][0] : null
}

/**
 * Decide whether one tool call from one teammate is allowed.
 * @param exec - DSH tool execution: `{ name, agent, arguments }`.
 * @param ctx - plugin context (Agent Teams service).
 * @param store - run store with the synchronous `cachedState`.
 * @param settings - resolved plugin settings (roles table).
 * @returns a denial reason, or undefined to allow.
 */
export function toolGuardReason(exec, ctx, store, settings) {
  try {
    const agent = exec?.agent
    const toolName = typeof exec?.name === 'string' ? exec.name : ''
    if (agent === undefined || toolName.length === 0) return undefined
    if (toolName.startsWith(WORKFLOW_TOOL_PREFIX)) return undefined
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined || membership.role !== 'teammate') return undefined
    const state = store.cachedState(membership.root)
    const role = memberRoleOf(state, membership.name)
    if (role === null) return undefined
    const policy = settings.roles?.[role]
    if (policy === undefined || policy === null) return undefined
    const describe = `role "${role}"`
    if (policy.readOnly === true && NATIVE_MUTATING_TOOLS.includes(toolName)) {
      return `tool "${toolName}" is blocked by the Agent Team tool sandbox: ${describe} is read-only (roles.${role}.readOnly)`
    }
    const deny = Array.isArray(policy.deny) ? policy.deny : []
    if (deny.includes(toolName)) {
      return `tool "${toolName}" is blocked by the Agent Team tool sandbox: ${describe} denies it (roles.${role}.deny)`
    }
    const allow = Array.isArray(policy.allow) ? policy.allow : []
    if (allow.length > 0 && !allow.includes(toolName)) {
      return `tool "${toolName}" is blocked by the Agent Team tool sandbox: ${describe} may only use ${allow.join(', ')} (roles.${role}.allow)`
    }
    return undefined
  } catch {
    // Never let a sandbox bug break normal tool execution.
    return undefined
  }
}
