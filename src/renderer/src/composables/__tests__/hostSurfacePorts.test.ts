import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { useBackend } from '../useBackend'
import { createHostTerminalDockPort } from '../hostSurfacePorts'
import {
  runTerminalDockContract,
  type TerminalDockContractHarness,
  type TerminalDockRequestRecord,
} from '../../ports/__tests__/terminalDock.contract'

type HostBackend = ReturnType<typeof useBackend>

function createHarness(): TerminalDockContractHarness {
  const status = ref<'connected'>('connected')
  const shell = ref('bash')
  const autoRestart = ref(null)
  const sent: TerminalDockRequestRecord[] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  async function send<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<{ ok: true; payload: T | null; error: null }> {
    sent.push({ type, payload, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
    return { ok: true, payload: null, error: null }
  }

  function on(type: string, callback: (payload: unknown) => void): () => void {
    const callbacks = listeners.get(type) ?? new Set()
    listeners.set(type, callbacks)
    callbacks.add(callback)
    return () => callbacks.delete(callback)
  }

  const backend = { status, shell, autoRestart, send, on } as unknown as HostBackend
  return {
    port: createHostTerminalDockPort(backend),
    sent,
    emitOutput: (payload) => { listeners.get('terminal.output')?.forEach((callback) => callback(payload)) },
    emitExit: (payload) => { listeners.get('terminal.exit')?.forEach((callback) => callback(payload)) },
  }
}

runTerminalDockContract(createHarness)

describe('Host terminal dock adapter', () => {
  it('does not bind raw route details into the port consumer type', () => {
    expect(createHarness().port).toHaveProperty('create')
    expect(createHarness().port).not.toHaveProperty('send')
  })
})
