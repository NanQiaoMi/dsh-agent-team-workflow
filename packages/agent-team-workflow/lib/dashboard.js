/**
 * Pure aggregation for the live Agent Team dashboard snapshot.
 *
 * Thin barrel facade re-exporting the exact public dashboard API from domain
 * submodules under `./dashboard/` while preserving every existing contract.
 */

export {
  SNAPSHOT_VERSION,
  computeWaves,
  normalizeItemStatus,
  normalizeStatus,
  tailEvents,
} from './dashboard/shared.js'
export { buildSnapshot } from './dashboard/snapshot.js'
