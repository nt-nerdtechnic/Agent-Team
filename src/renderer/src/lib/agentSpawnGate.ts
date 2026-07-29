// Gate logic for agent-initiated pane spawns (SPAWN blocks). Pure functions —
// App.vue supplies the runtime context; unit tests inject fakes. Failure
// reasons are agent-facing text (delivered back to the requesting pane), so
// they follow the protocol language in data/stages.ts.

import { normalizeMessagingName, type ParsedSpawnRequest } from './agentMessaging'

/** Max live child panes one pane may have spawned. */
export const SPAWN_MAX_CHILDREN_PER_PARENT = 3
/** Max AI CLI panes (terminal excluded) across the whole workspace. */
export const SPAWN_MAX_CLI_PANES = 8
/** Max spawn-chain depth: user-opened pane = 0, its spawns = 1, theirs = 2. */
export const SPAWN_MAX_DEPTH = 2

export interface SpawnGateContext {
  /** Allowed agent keys (agentSpecs minus the plain-shell terminal). */
  validAgentKeys: readonly string[]
  /** True when the messaging name is already registered to a pane. */
  isNameTaken: (name: string) => boolean
  /** Spawn-chain depth of the requesting pane (user-opened = 0). */
  parentDepth: number
  /** Live child panes already spawned by the requesting pane. */
  parentChildCount: number
  /** Live AI CLI panes (terminal excluded) across the workspace. */
  cliPaneCount: number
}

export type SpawnGateResult =
  | { ok: true; agentKey: string; name: string; task: string }
  | { ok: false; reason: string }

/** Validate one spawn request against the whitelist, naming rules, quotas and
 *  the depth limit. Returns the normalized fields on success. */
export function evaluateSpawnRequest(
  req: ParsedSpawnRequest,
  ctx: SpawnGateContext,
): SpawnGateResult {
  if (!req.agent || !ctx.validAgentKeys.includes(req.agent)) {
    return { ok: false, reason: `agent 欄位缺少或不合法：「${req.agent}」不是可用的 agent key` }
  }
  const name = req.name ? normalizeMessagingName(req.name) : null
  if (!name) return { ok: false, reason: 'name 欄位缺少或不合法' }
  if (ctx.isNameTaken(name)) {
    return { ok: false, reason: `名稱「${name}」已被其他 pane 使用，請換一個名稱` }
  }
  if (!req.task) return { ok: false, reason: 'task 欄位不可為空' }
  if (ctx.parentDepth >= SPAWN_MAX_DEPTH) {
    return { ok: false, reason: `spawn 鏈深度已達上限（${SPAWN_MAX_DEPTH}），此 pane 不可再啟動子 pane` }
  }
  if (ctx.parentChildCount >= SPAWN_MAX_CHILDREN_PER_PARENT) {
    return { ok: false, reason: `此 pane 的子 pane 數已達上限（${SPAWN_MAX_CHILDREN_PER_PARENT}）` }
  }
  if (ctx.cliPaneCount >= SPAWN_MAX_CLI_PANES) {
    return { ok: false, reason: `工作區 CLI pane 總數已達上限（${SPAWN_MAX_CLI_PANES}）` }
  }
  return { ok: true, agentKey: req.agent, name, task: req.task }
}

/** One spawn per turn: only the first block is evaluated; every extra block
 *  fails with an explanation for the requesting agent. */
export function evaluateTurnSpawns(
  requests: ParsedSpawnRequest[],
  ctx: SpawnGateContext,
): SpawnGateResult[] {
  return requests.map((req, i) =>
    i === 0
      ? evaluateSpawnRequest(req, ctx)
      : { ok: false, reason: '每個 turn 只處理第一個 SPAWN 區塊，此區塊已被忽略' },
  )
}

/** Spawn-chain depth of a pane: number of `spawnedBy` links walkable from it.
 *  Cycle-guarded. A missing ancestor ends the walk — spawnedBy is runtime-only
 *  (not persisted), so after an app restart every pane counts as root again;
 *  accepted MVP behaviour. */
export function computeSpawnDepth(
  paneId: string,
  parentOf: (id: string) => string | null | undefined,
): number {
  let depth = 0
  const seen = new Set<string>([paneId])
  let cur = parentOf(paneId)
  while (cur && !seen.has(cur)) {
    depth++
    seen.add(cur)
    cur = parentOf(cur)
  }
  return depth
}
