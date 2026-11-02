/**
 * Native-tool sandbox adapter (docs/25).
 *
 * The reusable decision table and lifecycle live in `@local/dsh-tool-guard-kit`
 * (../../tool-guard-kit); this module only binds the kit to Agent Team
 * Workflow's state shape:
 *   - the caller's role comes from the run board (roleAssignments / item role);
 *   - the synchronous state snapshot comes from the run store's cache;
 *   - workflow's own `team_flow_*` tools keep their own role policy, so the
 *     native guard skips them and lets tools.js decide.
 */

import {
  createTeamSubjectResolver,
  createToolSandbox,
  DEFAULT_MUTATING_TOOLS,
  isMutatingTool,
  roleFromTeamState,
} from '../../tool-guard-kit/index.js'

/** Native tools that can change the workspace or run arbitrary commands. */
export const NATIVE_MUTATING_TOOLS = DEFAULT_MUTATING_TOOLS

/** Workflow tools enforce their own role policy in `tools.js`. */
const WORKFLOW_TOOL_PREFIX = 'team_flow_'

/**
 * @param toolName - model-facing tool name.
 * @returns whether the tool can modify the workspace or run commands.
 */
export function isNativeMutatingTool(toolName) {
  return isMutatingTool(toolName)
}

/**
 * Resolve one member's role name from the board.
 * @param state - cached run state.
 * @param memberName - member name from the Team roster.
 * @returns role name or null.
 */
export function memberRoleOf(state, memberName) {
  return roleFromTeamState(state, memberName)
}

/** @returns a synchronous state getter bound to the run store for one exec. */
export function teamStateGetter(ctx, store) {
  return (exec) => {
    try {
      const membership = ctx.agentTeams.tryMembership(exec.agent)
      return membership === undefined ? null : store.cachedState(membership.root)
    } catch {
      return null
    }
  }
}

/**
 * Build the reusable subject resolver for Agent Team Workflow.
 * @param ctx - plugin context.
 * @param store - run store with `cachedState`.
 * @returns synchronous subject resolver.
 */
export function teamSubjectResolver(ctx, store) {
  return createTeamSubjectResolver({ ctx, stateFor: teamStateGetter(ctx, store) })
}

/**
 * Decide whether one tool call from one teammate is allowed (test/helper path).
 *
 * Production registers a single sandbox via `installToolSandbox`; this wrapper
 * builds an equivalent instance per call and is what the unit tests pin.
 *
 * @param exec - DSH tool execution: `{ name, agent, arguments }`.
 * @param ctx - plugin context (Agent Teams service).
 * @param store - run store with the synchronous `cachedState`.
 * @param settings - resolved plugin settings (roles table).
 * @returns a denial reason, or undefined to allow.
 */
export function toolGuardReason(exec, ctx, store, settings) {
  try {
    const toolName = typeof exec?.name === 'string' ? exec.name : ''
    if (toolName.startsWith(WORKFLOW_TOOL_PREFIX)) return undefined
    const sandbox = createToolSandbox({
      policies: settings.roles,
      resolveSubject: teamSubjectResolver(ctx, store),
    })
    return sandbox.check(exec)
  } catch {
    // Never let a sandbox bug break normal tool execution.
    return undefined
  }
}
