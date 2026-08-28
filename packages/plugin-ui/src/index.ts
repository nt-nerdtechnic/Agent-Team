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
  readonly profileId: string | null
  listProfiles(): Promise<AiCliProfile[]>
  resume(cols: number, rows: number): Promise<AiCliResumeResult | null>
  start(profileId: string, cols: number, rows: number, options?: { yolo?: boolean }): Promise<string>
  send(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  interrupt(): Promise<void>
  stop(): Promise<void>
  dispose(): void
  onOutput(listener: (data: string) => void): () => void
  onExit(listener: () => void): () => void
}

export interface AiCliProfile {
  id: string
  label: string
}

export interface AiCliResumeResult {
  sessionId: string
  profileId: string
}

export interface SafeAiCliPanelHandle {
  start(): Promise<void>
  focus(): void
  submitPrompt(prompt: string): Promise<boolean>
  stop(): Promise<void>
}

export type AiCliPluginContext = Pick<PluginContext, 'capabilities' | 'events'>

export function createAiCliSessionController(context: AiCliPluginContext): AiCliSessionController {
  let sessionId: string | null = null
  let profileId: string | null = null
  let pendingStart: Promise<string> | null = null
  let pendingResume: Promise<AiCliResumeResult | null> | null = null
  const outputListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<() => void>()
  const outputSubscription = context.events.subscribe('aiCli.output', (event) => {
    if (event.sessionId !== sessionId) return
    for (const listener of outputListeners) listener(event.data)
  })
  const exitSubscription = context.events.subscribe('aiCli.exited', (event) => {
    if (event.sessionId !== sessionId) return
    sessionId = null
    profileId = null
    for (const listener of exitListeners) listener()
  })

  const requireSession = (): string => {
    if (!sessionId) throw new Error('AI CLI session is not running')
    return sessionId
  }

  return {
    get sessionId() {
      return sessionId
    },
    get profileId() {
      return profileId
    },
    async listProfiles() {
      const result = await context.capabilities.invoke('aiCli.listProfiles', {})
      return result.profiles
    },
    async resume(cols, rows) {
      if (sessionId && profileId) return { sessionId, profileId }
      if (pendingResume) return pendingResume
      pendingResume = context.capabilities.invoke('aiCli.resumeSession', { cols, rows })
        .then((result) => {
          if (result) {
            sessionId = result.sessionId
            profileId = result.profileId
          }
          return result
        })
        .finally(() => { pendingResume = null })
      return pendingResume
    },
    async start(nextProfileId, cols, rows, options = {}) {
      if (sessionId) return sessionId
      if (pendingStart) return pendingStart
      pendingStart = context.capabilities.invoke('aiCli.startSession', {
        profileId: nextProfileId,
        cols,
        rows,
        ...(options.yolo === undefined ? {} : { yolo: options.yolo }),
      }).then((result) => {
        sessionId = result.sessionId
        profileId = nextProfileId
        return result.sessionId
      }).finally(() => { pendingStart = null })
      return pendingStart
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
      if (sessionId === active) {
        sessionId = null
        profileId = null
      }
    },
    dispose() {
      outputListeners.clear()
      exitListeners.clear()
      outputSubscription.dispose()
      exitSubscription.dispose()
    },
    onOutput(listener) {
      outputListeners.add(listener)
      return () => outputListeners.delete(listener)
    },
    onExit(listener) {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
  }
}
