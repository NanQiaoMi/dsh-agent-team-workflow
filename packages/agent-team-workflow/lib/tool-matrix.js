/**
 * Role-to-tool matrix for Agent Teams.
 *
 * Scoping tools by role drops 60-75% of tool schema overhead from worker and
 * reviewer prompt turns, while ensuring each role has exactly what it needs.
 */

export const ROLE_TOOL_MATRIX = Object.freeze({
  lead: [
    'team_flow_plan',
    'team_flow_plan_approval',
    'team_flow_gate',
    'team_flow_staff',
    'team_flow_repair',
    'team_flow_stop',
    'team_flow_status',
    'team_flow_read',
    'team_flow_talk',
    'team_flow_decide',
    'team_flow_item',
    'team_flow_work',
    'team_flow_report',
    'team_flow_review_submit',
    'team_flow_review_respond',
    'team_flow_escalate',
    'team_flow_git',
  ],
  implementer: [
    'team_flow_report',
    'team_flow_review_respond',
    'team_flow_git',
    'team_flow_work',
    'team_flow_item',
    'team_flow_talk',
    'team_flow_read',
    'team_flow_decide',
    'team_flow_escalate',
    'team_flow_status',
  ],
  reviewer: [
    'team_flow_review_submit',
    'team_flow_git',
    'team_flow_talk',
    'team_flow_read',
    'team_flow_decide',
    'team_flow_status',
  ],
  verifier: [
    'team_flow_git',
    'team_flow_read',
    'team_flow_talk',
    'team_flow_status',
  ],
})

/**
 * Resolve the tool names permitted for an agent based on its role and current duties.
 *
 * @param {object} options
 * @param {string} [options.role] - membership.role or role name.
 * @param {string[]} [options.duties] - additional duties, e.g. ['reviewer'].
 * @param {object} [options.settings] - workflow settings.
 * @returns {Set<string>|null} Set of allowed tool names, or null if all tools allowed.
 */
export function resolveAllowedToolNames({ role = 'implementer', duties = [], settings = {} } = {}) {
  if (settings.legacyAllTools === true || settings.roleToolScoping === false) return null
  const normalized = String(role || '').toLowerCase().trim()
  if (normalized === 'lead') return null

  const allowed = new Set()
  const baseRole = (normalized === 'worker' || normalized === 'teammate') ? 'implementer' : normalized
  const baseTools = ROLE_TOOL_MATRIX[baseRole] ?? ROLE_TOOL_MATRIX.implementer
  for (const name of baseTools) allowed.add(name)

  // Merge in duties if any (e.g. an implementer that also reviews an item)
  if (Array.isArray(duties)) {
    for (const duty of duties) {
      const dutyRole = String(duty || '').toLowerCase().trim()
      const extraTools = ROLE_TOOL_MATRIX[dutyRole]
      if (Array.isArray(extraTools)) {
        for (const name of extraTools) allowed.add(name)
      }
    }
  }

  return allowed
}

/**
 * Filter an array of tool definitions by allowed names.
 *
 * @param {Array<{ name: string }>} tools - all registered tool definitions.
 * @param {Set<string>|null} allowedNames - set of allowed names, or null for all.
 * @returns {Array<{ name: string }>}
 */
export function filterToolsByRole(tools, allowedNames) {
  if (!allowedNames) return tools
  return tools.filter((tool) => allowedNames.has(tool.name))
}
