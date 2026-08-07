/**
 * Re-export shim — the canonical specs moved to `../agents/` (one file per
 * vendor; stage 2 of the one-file-per-vendor refactor). Import sites migrate
 * to `../agents` over time; this shim is deleted in the frontend cleanup.
 */

export type { AgentSpec, PaneArgContext } from '../agents'
export { AGENT_SPECS, CLI_AGENT_SPECS } from '../agents'
