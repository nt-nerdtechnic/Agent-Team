import { describe, it, expect } from 'vitest'
import {
  SPAWN_MAX_CHILDREN_PER_PARENT,
  SPAWN_MAX_CLI_PANES,
  SPAWN_MAX_DEPTH,
  evaluateSpawnRequest,
  evaluateTurnSpawns,
  computeSpawnDepth,
  type SpawnGateContext,
} from '../agentSpawnGate'

function ctx(overrides: Partial<SpawnGateContext> = {}): SpawnGateContext {
  return {
    validAgentKeys: ['claude', 'codex'],
    isNameTaken: () => false,
    parentDepth: 0,
    parentChildCount: 0,
    cliPaneCount: 1,
    ...overrides,
  }
}

const goodReq = { agent: 'claude', name: 'worker-2', task: 'do the thing' }

describe('evaluateSpawnRequest', () => {
  it('passes a valid request and returns normalized fields', () => {
    const res = evaluateSpawnRequest({ ...goodReq, name: '  worker-2  ' }, ctx())
    expect(res).toEqual({ ok: true, agentKey: 'claude', name: 'worker-2', task: 'do the thing' })
  })

  it('rejects a missing or non-whitelisted agent (terminal is not whitelisted)', () => {
    for (const agent of ['', 'terminal', 'gpt']) {
      const res = evaluateSpawnRequest({ ...goodReq, agent }, ctx())
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toContain('agent')
    }
  })

  it('rejects a missing or invalid name', () => {
    for (const name of ['', '   ']) {
      const res = evaluateSpawnRequest({ ...goodReq, name }, ctx())
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toContain('name')
    }
  })

  it('rejects a name collision without renaming', () => {
    const res = evaluateSpawnRequest(goodReq, ctx({ isNameTaken: (n) => n === 'worker-2' }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('worker-2')
  })

  it('rejects an empty task', () => {
    const res = evaluateSpawnRequest({ ...goodReq, task: '' }, ctx())
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('task')
  })

  it('enforces the spawn-chain depth limit', () => {
    expect(evaluateSpawnRequest(goodReq, ctx({ parentDepth: SPAWN_MAX_DEPTH - 1 })).ok).toBe(true)
    const res = evaluateSpawnRequest(goodReq, ctx({ parentDepth: SPAWN_MAX_DEPTH }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('深度')
  })

  it('enforces the per-parent child quota', () => {
    expect(
      evaluateSpawnRequest(goodReq, ctx({ parentChildCount: SPAWN_MAX_CHILDREN_PER_PARENT - 1 })).ok,
    ).toBe(true)
    const res = evaluateSpawnRequest(
      goodReq,
      ctx({ parentChildCount: SPAWN_MAX_CHILDREN_PER_PARENT }),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('子 pane')
  })

  it('enforces the workspace-wide CLI pane quota', () => {
    expect(evaluateSpawnRequest(goodReq, ctx({ cliPaneCount: SPAWN_MAX_CLI_PANES - 1 })).ok).toBe(true)
    const res = evaluateSpawnRequest(goodReq, ctx({ cliPaneCount: SPAWN_MAX_CLI_PANES }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('總數')
  })
})

describe('evaluateTurnSpawns', () => {
  it('evaluates only the first block; extras fail with a one-per-turn reason', () => {
    const second = { agent: 'codex', name: 'other', task: 'more' }
    const results = evaluateTurnSpawns([goodReq, second, second], ctx())
    expect(results[0].ok).toBe(true)
    for (const res of results.slice(1)) {
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toContain('只處理第一個')
    }
  })

  it('still reports a failing first block', () => {
    const results = evaluateTurnSpawns([{ ...goodReq, agent: 'gpt' }], ctx())
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
  })

  it('returns empty for no requests', () => {
    expect(evaluateTurnSpawns([], ctx())).toEqual([])
  })
})

describe('computeSpawnDepth', () => {
  const chain: Record<string, string | undefined> = { c: 'b', b: 'a', a: undefined }
  const parentOf = (id: string): string | undefined => chain[id]

  it('counts walkable spawnedBy links (root = 0)', () => {
    expect(computeSpawnDepth('a', parentOf)).toBe(0)
    expect(computeSpawnDepth('b', parentOf)).toBe(1)
    expect(computeSpawnDepth('c', parentOf)).toBe(2)
  })

  it('stops at a missing ancestor (restart resets depth — accepted MVP)', () => {
    expect(computeSpawnDepth('x', () => undefined)).toBe(0)
  })

  it('guards against cycles', () => {
    const loop: Record<string, string> = { a: 'b', b: 'a' }
    expect(computeSpawnDepth('a', (id) => loop[id])).toBe(1)
  })
})
