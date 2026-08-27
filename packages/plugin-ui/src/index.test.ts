import { describe, expect, it, vi } from 'vitest'
import type { PluginContext } from '@navide/plugin-sdk'
import { createAiCliSessionController } from './index'

describe('public Vue plugin UI controllers', () => {
  it('routes AI CLI output only for its PluginContext-owned session', async () => {
    const eventListeners = new Map<string, (payload: never) => void>()
    const invoke = vi.fn().mockResolvedValueOnce({ sessionId: 'session-1' }).mockResolvedValue({})
    const context = {
      capabilities: { invoke },
      events: {
        subscribe: (event: string, listener: (payload: never) => void) => {
          eventListeners.set(event, listener)
          return { dispose: vi.fn() }
        },
      },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)
    const output = vi.fn()
    controller.onOutput(output)

    await expect(controller.start('codex', 100, 30)).resolves.toBe('session-1')
    eventListeners.get('aiCli.output')?.({ sessionId: 'foreign', data: 'secret' } as never)
    eventListeners.get('aiCli.output')?.({ sessionId: 'session-1', data: 'owned' } as never)

    expect(output).toHaveBeenCalledOnce()
    expect(output).toHaveBeenCalledWith('owned')
  })

  it('can start again after stop and disposes subscriptions only at teardown', async () => {
    const disposeOutput = vi.fn()
    const disposeExit = vi.fn()
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 'session-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ sessionId: 'session-2' })
    const context = {
      capabilities: { invoke },
      events: {
        subscribe: (event: string) => ({
          dispose: event === 'aiCli.output' ? disposeOutput : disposeExit,
        }),
      },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)

    await controller.start('codex', 100, 30)
    await controller.stop()
    expect(disposeOutput).not.toHaveBeenCalled()
    expect(disposeExit).not.toHaveBeenCalled()

    await expect(controller.start('codex', 100, 30)).resolves.toBe('session-2')
    controller.dispose()
    expect(disposeOutput).toHaveBeenCalledOnce()
    expect(disposeExit).toHaveBeenCalledOnce()
  })
})
