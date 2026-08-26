import {
  DEFAULT_GIT_TIMEOUT_MS,
  type GitEventType,
  type GitRequestType,
  type GitTransport,
  type GitTransportStatusSource,
} from '@navide/git-feature'
import type { PortResponse } from '@navide/shared'

export type PluginGitSdkResponse<TPayload = unknown> = PortResponse<TPayload>

/**
 * The SDK-facing Git seam is already bound to one authenticated plugin view.
 * Identity and routing metadata stay outside this interface; the adapter only
 * exposes the Git inventory owned by the feature contract.
 */
export interface PluginGitSdk {
  readonly status: GitTransportStatusSource
  request<TPayload = unknown>(
    type: GitRequestType,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<PluginGitSdkResponse<TPayload>>
  subscribe(type: GitEventType, callback: (payload: unknown) => void): () => void
}

/** Adapt a bound plugin SDK facade to the Git feature transport contract. */
export function createPluginGitTransport(sdk: PluginGitSdk): GitTransport {
  return {
    status: sdk.status,
    async send<TPayload = unknown>(
      type: GitRequestType,
      payload: Record<string, unknown> = {},
      timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    ) {
      try {
        const response = await sdk.request<TPayload>(type, payload, timeoutMs)
        return {
          ok: response.ok,
          payload: response.payload,
          error: response.error,
        }
      } catch (error) {
        return {
          ok: false,
          payload: null,
          error: { code: 'BACKEND_ERROR', message: error instanceof Error ? error.message : 'backend request failed' },
        }
      }
    },
    on(type, callback) {
      let disposed = false
      const unsubscribe = sdk.subscribe(type, (payload) => {
        if (disposed) return
        try {
          callback(payload)
        } catch (err) {
          // One Git listener must not prevent the next listener from running.
          console.error('[plugin-git] listener error', err)
        }
      })
      return () => {
        if (disposed) return
        disposed = true
        unsubscribe()
      }
    },
  }
}
