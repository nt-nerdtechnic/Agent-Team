// Gate logic for agent-initiated pane spawns (SPAWN blocks). Pure functions —
// App.vue supplies the runtime context; unit tests inject fakes. Failure
// reasons and advisories are agent-facing text (delivered back to the
// requesting pane), so they follow the protocol language in data/stages.ts.
//
// This gate only rejects on correctness (unknown agent, bad/taken name, empty
// task) — it never rejects on volume. Child/workspace/depth counts above the
// advisory thresholds below still succeed; the caller just gets an
// `advisories` note back to relay or log.

import { normalizeMessagingName, type ParsedSpawnRequest } from './agentMessaging'

/** Advisory threshold for live child panes one pane has spawned — crossing it
 *  does not block the spawn, it just adds a note to the result. */
export const SPAWN_ADVISORY_CHILDREN_PER_PARENT = 3
/** Advisory threshold for AI CLI panes (terminal excluded) across the whole
 *  workspace — crossing it does not block the spawn, it just adds a note. */
export const SPAWN_ADVISORY_CLI_PANES = 8
/** Advisory threshold for spawn-chain depth: user-opened pane = 0, its spawns
 *  = 1, theirs = 2. Crossing it does not block the spawn, it just adds a note
 *  about how hard the chain will be to trace. */
export const SPAWN_ADVISORY_DEPTH = 2

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
  | { ok: true; agentKey: string; name: string; task: string; advisories?: string[] }
  | { ok: false; reason: string }

/** The advisory notes for one spawn's volume context (chain depth, children
 *  per parent, workspace CLI panes) — never a rejection, just what would be
 *  reported back on a successful spawn. Pulled out of evaluateSpawnRequest so
 *  a caller that bypasses the gate (e.g. ui.pane.create) can still surface
 *  the same notes. */
export function spawnAdvisoriesFor(
  ctx: Pick<SpawnGateContext, 'parentDepth' | 'parentChildCount' | 'cliPaneCount'>,
): string[] {
  const advisories: string[] = []
  if (ctx.parentDepth >= SPAWN_ADVISORY_DEPTH) {
    advisories.push(
      `spawn 鏈深度即將達到 ${ctx.parentDepth + 1}（建議值 ${SPAWN_ADVISORY_DEPTH}）：鏈太深時，` +
        `孫代 pane 的產出很難回溯到最初的請求者，追蹤與除錯會變困難`,
    )
  }
  if (ctx.parentChildCount >= SPAWN_ADVISORY_CHILDREN_PER_PARENT) {
    advisories.push(
      `此 pane 即將啟動第 ${ctx.parentChildCount + 1} 個子 pane（建議值 ${SPAWN_ADVISORY_CHILDREN_PER_PARENT}）`,
    )
  }
  if (ctx.cliPaneCount >= SPAWN_ADVISORY_CLI_PANES) {
    advisories.push(
      `此工作區已有 ${ctx.cliPaneCount} 個 CLI pane（建議值 ${SPAWN_ADVISORY_CLI_PANES}）；` +
        `每個約佔用 250–500MB 記憶體，數量偏多時請留意系統負載`,
    )
  }
  return advisories
}

/** Validate one spawn request against the whitelist, naming rules and
 *  correctness checks — the only things that reject. Volume (children per
 *  parent, workspace CLI panes, chain depth) never rejects; past its advisory
 *  threshold it's reported back in `advisories` on the success result. */
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

  const advisories = spawnAdvisoriesFor(ctx)

  return advisories.length > 0
    ? { ok: true, agentKey: req.agent, name, task: req.task, advisories }
    : { ok: true, agentKey: req.agent, name, task: req.task }
}

/** Evaluate every SPAWN block in a turn — no longer just the first. Each
 *  request is checked against the running counts: a successful request bumps
 *  `parentChildCount` and `cliPaneCount` for the next one in the same turn
 *  (depth is unchanged — every spawn in a turn is the same parent's direct
 *  child), so opening five panes in one turn sees its advisories cross
 *  threshold partway through, not stay pinned at the turn's starting counts.
 *  A rejected request does not bump anything — it never spawns.
 *
 *  Names claimed earlier in the same turn count as taken. `isNameTaken` only
 *  knows about panes that already exist, so without this two blocks asking for
 *  the same name would both pass and the second would be quietly renamed with
 *  a suffix downstream — a clear rejection is more useful than a silent
 *  rename. Only reachable since a turn stopped being limited to one spawn. */
export function evaluateTurnSpawns(
  requests: ParsedSpawnRequest[],
  ctx: SpawnGateContext,
): SpawnGateResult[] {
  let parentChildCount = ctx.parentChildCount
  let cliPaneCount = ctx.cliPaneCount
  const claimedThisTurn = new Set<string>()
  return requests.map((req) => {
    const result = evaluateSpawnRequest(req, {
      ...ctx,
      parentChildCount,
      cliPaneCount,
      isNameTaken: (name) => claimedThisTurn.has(name) || ctx.isNameTaken(name),
    })
    if (result.ok) {
      parentChildCount++
      cliPaneCount++
      claimedThisTurn.add(result.name)
    }
    return result
  })
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
