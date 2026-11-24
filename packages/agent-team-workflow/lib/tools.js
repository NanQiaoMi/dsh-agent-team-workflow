/**
 * Model-facing tools of the Agent Team Workflow plugin.
 *
 * Thin entrypoint aggregating domain tool modules under `./tools/` while
 * keeping the public exports (`buildTools`, `REPEATED_FAILURE_THRESHOLD`) unchanged.
 */

import { buildDomainTools as buildCollabTools } from './tools/collab-tools.js'
import { buildDomainTools as buildDevkitTools } from './tools/devkit-tools.js'
import { buildDomainTools as buildExecutionAndReviewTools } from './tools/execution-and-review.js'
import { buildDomainTools as buildGitTools } from './tools/git-tools.js'
import { buildDomainTools as buildPlanAndGateTools } from './tools/plan-and-gate.js'
import { REPEATED_FAILURE_THRESHOLD, wrapToolDefinitions } from './tools/shared.js'

export { REPEATED_FAILURE_THRESHOLD }

/**
 * Build every tool definition for one plugin instance.
 * @param options - `{ ctx, settings, store, version, tokenUsage?, orchestrator?, thinkingRouter?, refreshMemberTools? }`.
 * @returns array of ToolDefinition-compatible objects.
 */
export function buildTools({
  ctx,
  settings,
  store,
  version,
  tokenUsage = () => null,
  orchestrator = null,
  thinkingRouter = null,
  refreshMemberTools = null,
}) {
  function triggerOrchestrator(agent) {
    if (orchestrator && typeof orchestrator.reconcile === 'function') {
      void orchestrator.reconcile(agent).catch(() => {})
    }
  }

  const definitions = [
    ...buildPlanAndGateTools({
      ctx,
      settings,
      store,
      version,
      tokenUsage,
      orchestrator,
      thinkingRouter,
      refreshMemberTools,
      triggerOrchestrator,
    }),
    ...buildExecutionAndReviewTools({ ctx, settings, store, orchestrator, triggerOrchestrator }),
    ...buildGitTools({ ctx, settings, store }),
    ...buildCollabTools({ ctx, settings, store, refreshMemberTools, triggerOrchestrator }),
    ...buildDevkitTools({ ctx, store, version }),
  ]

  return wrapToolDefinitions(definitions)
}
