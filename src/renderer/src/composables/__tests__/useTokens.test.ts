import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { useTokens, type TokensSnapshot } from '../useTokens'
import { createMockBackend, withScope, flush } from './mockBackend'

function snapshot(workspacePath: string): TokensSnapshot {
  const bucket = { input: 1, output: 2, calls: 1 }
  return {
    workspace_path: workspacePath,
    workspace: {
      current_run: null,
      runs: [],
      cumulative: { totals: bucket, by_vendor: {}, by_stage: {} },
      live_by_pane: {}
    },
    global: { all_time: bucket, by_vendor: {}, by_day: {} }
  }
}

describe('useTokens', () => {
  it('loads a snapshot on connect', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.snapshot', snapshot('/ws'))
    const wp = ref('/ws')

    const { result, scope } = withScope(() => useTokens(mock.backend, wp))
    await flush()

    expect(mock.sent.some((s) => s.type === 'tokens.snapshot')).toBe(true)
    expect(result.snapshot.value?.workspace_path).toBe('/ws')
    scope.stop()
  })

  it('does NOT fetch while disconnected', async () => {
    const mock = createMockBackend('starting')
    const { result, scope } = withScope(() => useTokens(mock.backend, ref('/ws')))
    await flush()

    expect(mock.sent).toHaveLength(0)
    expect(result.snapshot.value).toBeNull()
    scope.stop()
  })

  it('applies a tokens.changed broadcast for the current workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.snapshot', snapshot('/ws'))
    const { result, scope } = withScope(() => useTokens(mock.backend, ref('/ws')))
    await flush()

    const updated = snapshot('/ws')
    updated.workspace.cumulative.totals.calls = 99
    mock.emit('tokens.changed', updated)
    expect(result.snapshot.value?.workspace.cumulative.totals.calls).toBe(99)
    scope.stop()
  })

  it('drops a tokens.changed broadcast for a sibling workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.snapshot', snapshot('/ws'))
    const { result, scope } = withScope(() => useTokens(mock.backend, ref('/ws')))
    await flush()

    mock.emit('tokens.changed', snapshot('/other'))
    expect(result.snapshot.value?.workspace_path).toBe('/ws')
    scope.stop()
  })

  it('surfaces a backend error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.snapshot', null, { ok: false, error: { code: 'X', message: 'boom' } })
    const { result, scope } = withScope(() => useTokens(mock.backend, ref('/ws')))
    await flush()

    expect(result.lastError.value).toBe('boom')
    scope.stop()
  })
})
