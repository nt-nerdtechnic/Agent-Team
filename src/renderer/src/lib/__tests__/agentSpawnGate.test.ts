import { describe, it, expect } from 'vitest'
import {
  SPAWN_ADVISORY_CHILDREN_PER_PARENT,
  SPAWN_ADVISORY_CLI_PANES,
  SPAWN_ADVISORY_DEPTH,
  evaluateSpawnRequest,
  evaluateTurnSpawns,
  computeSpawnDepth,
  spawnAdvisoriesFor,
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

  it('never rejects on volume: depth past the advisory threshold still spawns, with a note', () => {
    const below = evaluateSpawnRequest(goodReq, ctx({ parentDepth: SPAWN_ADVISORY_DEPTH - 1 }))
    expect(below.ok).toBe(true)
    if (below.ok) expect(below.advisories).toBeUndefined()

    const above = evaluateSpawnRequest(goodReq, ctx({ parentDepth: SPAWN_ADVISORY_DEPTH }))
    expect(above.ok).toBe(true)
    if (above.ok) {
      expect(above.advisories?.length).toBeGreaterThan(0)
      expect(above.advisories?.some((a) => a.includes('深度'))).toBe(true)
    }
  })

  it('never rejects on volume: child count past the advisory threshold still spawns, with a note', () => {
    const below = evaluateSpawnRequest(
      goodReq,
      ctx({ parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT - 1 }),
    )
    expect(below.ok).toBe(true)
    if (below.ok) expect(below.advisories).toBeUndefined()

    const above = evaluateSpawnRequest(
      goodReq,
      ctx({ parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT }),
    )
    expect(above.ok).toBe(true)
    if (above.ok) {
      expect(above.advisories?.length).toBeGreaterThan(0)
      expect(above.advisories?.some((a) => a.includes('子 pane'))).toBe(true)
    }
  })

  it('never rejects on volume: workspace CLI pane count past the advisory threshold still spawns, with a note', () => {
    const below = evaluateSpawnRequest(goodReq, ctx({ cliPaneCount: SPAWN_ADVISORY_CLI_PANES - 1 }))
    expect(below.ok).toBe(true)
    if (below.ok) expect(below.advisories).toBeUndefined()

    const above = evaluateSpawnRequest(goodReq, ctx({ cliPaneCount: SPAWN_ADVISORY_CLI_PANES }))
    expect(above.ok).toBe(true)
    if (above.ok) {
      expect(above.advisories?.length).toBeGreaterThan(0)
      expect(above.advisories?.some((a) => a.includes('CLI pane'))).toBe(true)
    }
  })

  it('combines advisories when multiple thresholds are crossed at once', () => {
    const res = evaluateSpawnRequest(
      goodReq,
      ctx({
        parentDepth: SPAWN_ADVISORY_DEPTH,
        parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT,
        cliPaneCount: SPAWN_ADVISORY_CLI_PANES,
      }),
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.advisories?.length).toBe(3)
  })
})

describe('spawnAdvisoriesFor', () => {
  it('returns the same notes evaluateSpawnRequest would attach, given the same counts', () => {
    const c = { parentDepth: SPAWN_ADVISORY_DEPTH, parentChildCount: 0, cliPaneCount: 0 }
    const direct = spawnAdvisoriesFor(c)
    const viaGate = evaluateSpawnRequest(goodReq, ctx(c))
    expect(viaGate.ok).toBe(true)
    if (viaGate.ok) expect(direct).toEqual(viaGate.advisories)
  })

  it('returns an empty array when nothing crosses a threshold', () => {
    expect(spawnAdvisoriesFor({ parentDepth: 0, parentChildCount: 0, cliPaneCount: 0 })).toEqual([])
  })
})

describe('evaluateTurnSpawns', () => {
  it('evaluates every block in the turn, not just the first', () => {
    const requests = [
      { agent: 'claude', name: 'worker-a', task: 'a' },
      { agent: 'codex', name: 'worker-b', task: 'b' },
      { agent: 'claude', name: 'worker-c', task: 'c' },
    ]
    const results = evaluateTurnSpawns(requests, ctx())
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('rejects each invalid block independently, without short-circuiting the rest', () => {
    const requests = [
      { agent: 'gpt', name: 'bad-agent', task: 'x' },
      { agent: 'claude', name: 'worker-a', task: 'a' },
      { agent: 'claude', name: '', task: 'x' },
    ]
    const results = evaluateTurnSpawns(requests, ctx())
    expect(results.map((r) => r.ok)).toEqual([false, true, false])
  })

  it('returns empty for no requests', () => {
    expect(evaluateTurnSpawns([], ctx())).toEqual([])
  })

  it('accumulates parentChildCount and cliPaneCount across the turn, so an advisory appears once the running count crosses the threshold', () => {
    // Starting one below both thresholds: the first two requests should stay
    // clean, and only the third (which pushes the running counts to the
    // threshold) should carry an advisory.
    const requests = [
      { agent: 'claude', name: 'worker-a', task: 'a' },
      { agent: 'claude', name: 'worker-b', task: 'b' },
      { agent: 'claude', name: 'worker-c', task: 'c' },
    ]
    const results = evaluateTurnSpawns(
      requests,
      ctx({
        parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT - 2,
        cliPaneCount: SPAWN_ADVISORY_CLI_PANES - 2,
      }),
    )
    expect(results.every((r) => r.ok)).toBe(true)
    const [first, second, third] = results
    if (first.ok) expect(first.advisories).toBeUndefined()
    if (second.ok) expect(second.advisories).toBeUndefined()
    if (third.ok) {
      expect(third.advisories?.length).toBeGreaterThan(0)
      expect(third.advisories?.some((a) => a.includes('子 pane'))).toBe(true)
      expect(third.advisories?.some((a) => a.includes('CLI pane'))).toBe(true)
    }
  })

  it('does not bump the running counts for a rejected request', () => {
    const requests = [
      { agent: 'gpt', name: 'bad-agent', task: 'x' }, // rejected: bad agent key
      { agent: 'claude', name: 'worker-a', task: 'a' },
    ]
    const results = evaluateTurnSpawns(
      requests,
      ctx({ parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT }),
    )
    expect(results[0].ok).toBe(false)
    // The second request still sees the un-bumped starting count (already at
    // threshold from ctx, not threshold+1) — proves the rejection above did
    // not advance the running counter.
    expect(results[1].ok).toBe(true)
    if (results[1].ok) {
      expect(
        results[1].advisories?.some((a) => a.includes(`第 ${SPAWN_ADVISORY_CHILDREN_PER_PARENT + 1} 個子 pane`)),
      ).toBe(true)
    }
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

describe('evaluateTurnSpawns — names claimed within the turn', () => {
  it('rejects a second block asking for a name the first already claimed', () => {
    // isNameTaken only knows about panes that already exist, so without the
    // turn-local claim set both would pass and the second would be silently
    // renamed downstream.
    const gateCtx = ctx()

    const results = evaluateTurnSpawns(
      [
        { agent: 'claude', name: 'worker', task: 'first' },
        { agent: 'claude', name: 'worker', task: 'second' },
      ],
      gateCtx,
    )

    expect(results[0].ok).toBe(true)
    expect(results[1].ok).toBe(false)
    expect(results[1].ok === false && results[1].reason).toContain('已被其他 pane 使用')
  })

  it('a rejected block does not claim its name', () => {
    const gateCtx = ctx()

    const results = evaluateTurnSpawns(
      [
        { agent: 'nope', name: 'worker', task: 'rejected for a bad agent key' },
        { agent: 'claude', name: 'worker', task: 'should still get the name' },
      ],
      gateCtx,
    )

    expect(results[0].ok).toBe(false)
    expect(results[1].ok).toBe(true)
  })
})
