/**
 * Pure workflow engine for one Agent Team run.
 *
 * Thin barrel facade re-exporting domain submodules under `./workflow/` while
 * preserving the exact public API for every existing caller and test suite.
 */

export * from './workflow/constants.js'
export * from './workflow/plan.js'
export * from './workflow/review.js'
export * from './workflow/collaboration.js'
export * from './workflow/status-and-gates.js'
