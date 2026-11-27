import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as W from '../lib/workflow.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB_DIR = join(HERE, '..', 'lib')

const EXPECTED_EXPORTS = [
  'BLOCKING_PROPOSAL_KINDS',
  'CHANNEL_KINDS',
  'CHANNEL_LIMIT',
  'DEFAULT_LEASE_MINUTES',
  'DEFAULT_PROPOSAL_TIMEOUT_MINUTES',
  'ESCALATION_KINDS',
  'FINDING_RESOLUTIONS',
  'ITEM_STATUS',
  'PLAN_STATUS',
  'PROPOSAL_KINDS',
  'PROPOSAL_LIMIT',
  'PROPOSAL_TIMEOUT_MAX',
  'PROPOSAL_TIMEOUT_MIN',
  'RUN_PHASE',
  'SEVERITIES',
  'STOP_STATUS',
  'VERDICTS',
  'WORKFLOW_VERSION',
  'WorkflowError',
  'affectedMembersFor',
  'allReviewersApproved',
  'appendEvent',
  'applyReport',
  'applyReviewRespond',
  'applyReviewSubmit',
  'buildBriefStatus',
  'buildStatus',
  'claimItem',
  'collaborationSummary',
  'collectOwners',
  'collectReviewers',
  'computeWaves',
  'createItem',
  'createRun',
  'currentReportSeq',
  'decidePlan',
  'ensureCollaboration',
  'escalateStopToInterrupt',
  'evaluateGates',
  'findItem',
  'findItemByTaskId',
  'findProposal',
  'findScopeConflicts',
  'isApproving',
  'lastReviewOf',
  'nextActions',
  'normalizePath',
  'normalizeScope',
  'offerHandoff',
  'openBlockingProposals',
  'openReview',
  'outstandingReviewers',
  'pathInScope',
  'pendingReview',
  'pendingReviewFor',
  'pendingReviewerNames',
  'pendingReviews',
  'pendingStopFor',
  'planPending',
  'postChannelMessage',
  'preflightPlan',
  'proposalQuorumFor',
  'proposeDecision',
  'raiseEscalation',
  'releaseItem',
  'requestReviewFromPeer',
  'requestStop',
  'requiresPlan',
  'resolveEscalation',
  'respondHandoff',
  'respondStop',
  'reworkRounds',
  'scopesOverlap',
  'settleExpiredProposals',
  'settleProposalByLead',
  'submitPlan',
  'submittedRounds',
  'takeReview',
  'tallyProposal',
  'trimReport',
  'trimReviews',
  'unresolvedFindings',
  'upgradeState',
  'validatePlan',
  'voteDecision',
  'withdrawProposal',
]

test('lib/workflow.js barrel preserves exact public exports', () => {
  assert.deepEqual(Object.keys(W).sort(), EXPECTED_EXPORTS)
})

test('lib/workflow/ submodules stay within line budgets and remain strictly acyclic', async () => {
  const facadeSrc = await readFile(join(LIB_DIR, 'workflow.js'), 'utf8')
  const facadeLines = facadeSrc.split('\n').length
  assert.ok(facadeLines < 80, `lib/workflow.js facade has ${facadeLines} lines (expected < 80)`)

  const workflowDir = join(LIB_DIR, 'workflow')
  const files = (await readdir(workflowDir)).filter((f) => f.endsWith('.js')).sort()
  assert.deepEqual(files, [
    'collaboration.js',
    'constants.js',
    'plan.js',
    'review.js',
    'status-and-gates.js',
  ])

  const graph = new Map()
  const importRe = /(?:import|export)\s+[\s\S]*?\s+from\s+['"]\.\/([^'"]+)['"]/g
  for (const file of files) {
    const src = await readFile(join(workflowDir, file), 'utf8')
    const lineCount = src.split('\n').length
    assert.ok(lineCount < 650, `lib/workflow/${file} has ${lineCount} lines (expected < 650)`)
    const deps = []
    for (const match of src.matchAll(importRe)) {
      if (files.includes(match[1])) deps.push(match[1])
    }
    graph.set(file, deps)
  }

  // DFS cycle detection across internal lib/workflow/*.js imports
  const state = new Map()
  const visit = (node, stack) => {
    const cur = state.get(node)
    if (cur === 'visiting') {
      assert.fail(`cycle detected in lib/workflow/: ${[...stack, node].join(' -> ')}`)
    }
    if (cur === 'visited') return
    state.set(node, 'visiting')
    for (const dep of graph.get(node) ?? []) {
      visit(dep, [...stack, node])
    }
    state.set(node, 'visited')
  }
  for (const file of files) visit(file, [])
})
