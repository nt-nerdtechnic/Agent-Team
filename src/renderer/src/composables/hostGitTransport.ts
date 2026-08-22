import {
  DEFAULT_GIT_TIMEOUT_MS,
  type GitRequestType,
  type GitTransport,
} from '../../../../packages/features/git/src'
import type { useBackend } from './useBackend'

export type HostGitBackend = Pick<ReturnType<typeof useBackend>, 'status' | 'send' | 'on'>

/**
 * Adapts the Host's legacy WebSocket-backed backend to the Git feature's
 * transport contract. The adapter deliberately preserves backend rejections
 * while normalizing resolved response envelopes to the feature shape.
 */
export function createHostGitTransport(backend: HostGitBackend): GitTransport {
  return {
    status: backend.status,
    async send<TPayload = unknown>(
      type: GitRequestType,
      payload: Record<string, unknown> = {},
      timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    ) {
      const response = await backend.send<TPayload>(type, payload, timeoutMs)
      return {
        ok: response.ok,
        payload: response.payload,
        error: response.error,
      }
    },
    on(type, callback) {
      return backend.on(type, callback)
    },
  }
}
