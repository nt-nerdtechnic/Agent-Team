import type { App, InjectionKey } from 'vue'
import { inject } from 'vue'
import type { PluginContext } from '@navide/plugin-sdk'

export { default as SafeAiCliPanel } from './SafeAiCliPanel.vue'
export * from './tokens'

const pluginContextKey: InjectionKey<PluginContext> = Symbol('navide-plugin-context')

export function installPluginContext(app: App, context: PluginContext): void {
  app.provide(pluginContextKey, context)
}

export function usePluginContext(): PluginContext {
  const context = inject(pluginContextKey)
  if (!context) throw new Error('Navide PluginContext is not installed')
  return context
}

export interface AiCliSessionController {
  readonly sessionId: string | null
  start(profileId: string, cols: number, rows: number): Promise<string>
  send(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  interrupt(): Promise<void>
  stop(): Promise<void>
  dispose(): void
  onOutput(listener: (data: string) => void): () => void
}

export type AiCliPluginContext = Pick<PluginContext, 'capabilities' | 'events'>

export function createAiCliSessionController(context: AiCliPluginContext): AiCliSessionController {
  let sessionId: string | null = null
  const outputListeners = new Set<(data: string) => void>()
  const outputSubscription = context.events.subscribe('aiCli.output', (event) => {
    if (event.sessionId !== sessionId) return
    for (const listener of outputListeners) listener(event.data)
  })
  const exitSubscription = context.events.subscribe('aiCli.exited', (event) => {
    if (event.sessionId === sessionId) sessionId = null
  })

  const requireSession = (): string => {
    if (!sessionId) throw new Error('AI CLI session is not running')
    return sessionId
  }

  return {
    get sessionId() {
      return sessionId
    },
    async start(profileId, cols, rows) {
      if (sessionId) return sessionId
      const result = await context.capabilities.invoke('aiCli.startSession', {
        profileId,
        cols,
        rows,
      })
      const startedSessionId = result.sessionId
      sessionId = startedSessionId
      return startedSessionId
    },
    async send(data) {
      await context.capabilities.invoke('aiCli.sendInput', { sessionId: requireSession(), data })
    },
    async resize(cols, rows) {
      await context.capabilities.invoke('aiCli.resizeSession', {
        sessionId: requireSession(),
        cols,
        rows,
      })
    },
    async interrupt() {
      await context.capabilities.invoke('aiCli.interruptSession', { sessionId: requireSession() })
    },
    async stop() {
      const active = requireSession()
      await context.capabilities.invoke('aiCli.stopSession', { sessionId: active })
      if (sessionId === active) sessionId = null
    },
    dispose() {
      outputListeners.clear()
      outputSubscription.dispose()
      exitSubscription.dispose()
    },
    onOutput(listener) {
      outputListeners.add(listener)
      return () => outputListeners.delete(listener)
    },
  }
}
