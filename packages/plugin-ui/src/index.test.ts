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

  it('reports an owned session exit without exposing foreign sessions', async () => {
    const eventListeners = new Map<string, (payload: never) => void>()
    const context = {
      capabilities: { invoke: vi.fn().mockResolvedValue({ sessionId: 'session-1' }) },
      events: {
        subscribe: (event: string, listener: (payload: never) => void) => {
          eventListeners.set(event, listener)
          return { dispose: vi.fn() }
        },
      },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)
    const exited = vi.fn()
    controller.onExit(exited)
    await controller.start('codex', 80, 24)

    eventListeners.get('aiCli.exited')?.({ sessionId: 'foreign' } as never)
    eventListeners.get('aiCli.exited')?.({ sessionId: 'session-1', exitCode: 0 } as never)

    expect(exited).toHaveBeenCalledOnce()
    expect(controller.sessionId).toBeNull()
  })

  it('lists Host profiles and resumes only the tuple-owned detached session', async () => {
    const invoke = vi.fn(async (address: string) => {
      if (address === 'aiCli.listProfiles') {
        return { profiles: [{ id: 'claude', label: 'Claude Code' }] }
      }
      if (address === 'aiCli.resumeSession') {
        return { sessionId: 'session-resumed', profileId: 'claude' }
      }
      return null
    })
    const context = {
      capabilities: { invoke },
      events: { subscribe: () => ({ dispose: vi.fn() }) },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)

    await expect(controller.listProfiles()).resolves.toEqual([
      { id: 'claude', label: 'Claude Code' },
    ])
    await expect(controller.resume(100, 30)).resolves.toEqual({
      sessionId: 'session-resumed',
      profileId: 'claude',
    })
    expect(controller.sessionId).toBe('session-resumed')
    expect(invoke).toHaveBeenCalledWith('aiCli.resumeSession', { cols: 100, rows: 30 })
  })

  it('coalesces concurrent starts and forwards unattended mode once', async () => {
    let resolveStart!: (value: { sessionId: string }) => void
    const started = new Promise<{ sessionId: string }>((resolve) => { resolveStart = resolve })
    const invoke = vi.fn(() => started)
    const context = {
      capabilities: { invoke },
      events: { subscribe: () => ({ dispose: vi.fn() }) },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)

    const first = controller.start('claude', 100, 30, { yolo: true })
    const second = controller.start('claude', 100, 30, { yolo: true })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('aiCli.startSession', {
      profileId: 'claude',
      cols: 100,
      rows: 30,
      yolo: true,
    })

    resolveStart({ sessionId: 'session-1' })
    await expect(Promise.all([first, second])).resolves.toEqual(['session-1', 'session-1'])
  })
})
