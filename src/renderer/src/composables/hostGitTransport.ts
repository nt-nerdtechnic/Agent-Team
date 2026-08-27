import {
  type GitRequestType,
  type GitTransport,
} from '@navide/git-feature'
import { HOST_GIT_TIMEOUT_MS } from '../../../shared/gitCompatibility'
import type { useBackend } from './useBackend'

export type HostGitBackend = Pick<ReturnType<typeof useBackend>, 'status' | 'send' | 'on'>

/**
 * Adapts the Host's legacy WebSocket-backed backend to the Git feature's
 * transport contract. Backend transport failures are normalized to the same
 * response envelope as the capability-backed plugin adapter.
 */
export function createHostGitTransport(backend: HostGitBackend): GitTransport {
  return {
    status: backend.status,
    async send<TPayload = unknown>(
      type: GitRequestType,
      payload: Record<string, unknown> = {},
      timeoutMs = HOST_GIT_TIMEOUT_MS,
    ) {
      try {
        const response = await backend.send<TPayload>(type, payload, timeoutMs)
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
      return backend.on(type, callback)
    },
  }
}
