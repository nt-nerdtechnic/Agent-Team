import type {
  GitEventType,
  GitRequestType,
  GitTransport,
  GitTransportError,
  GitTransportResponse,
} from '../gitTransport'
import { DEFAULT_GIT_TIMEOUT_MS, type GitTransportStatusSource } from '../gitTransport'
import type {
  GitTransportContractHarness,
  GitTransportRequestRecord,
} from './gitTransport.contract'

export type { GitTransportRequestRecord } from './gitTransport.contract'

export interface InMemoryGitTransport extends GitTransportContractHarness {}

/**
 * Test-only adapter. It records calls and returns controlled envelopes; it
 * does not reproduce any Git behavior from a production implementation.
 */
export function createInMemoryGitTransport(status: GitTransportStatusSource): InMemoryGitTransport {
  const listeners = new Map<GitEventType, Set<(payload: unknown) => void>>()
  const responses = new Map<GitRequestType, GitTransportResponse>()
  const rejections = new Map<GitRequestType, Error>()
  const sent: GitTransportRequestRecord[] = []

  function on(type: GitEventType, callback: (payload: unknown) => void): () => void {
    let callbacks = listeners.get(type)
    if (!callbacks) {
      callbacks = new Set()
      listeners.set(type, callbacks)
    }
    callbacks.add(callback)
    return () => callbacks?.delete(callback)
  }

  async function send<TPayload = unknown>(
    type: GitRequestType,
    payload: Record<string, unknown> = {},
    timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  ): Promise<GitTransportResponse<TPayload>> {
    sent.push({ type, payload, timeoutMs })
    const rejection = rejections.get(type)
    if (rejection) throw rejection
    const response = responses.get(type)
    if (response) return response as GitTransportResponse<TPayload>
    return { ok: true, payload: null, error: null }
  }

  function emit(type: GitEventType, payload: unknown): void {
    const callbacks = listeners.get(type)
    if (!callbacks) return
    for (const callback of callbacks) {
      try {
        callback(payload)
      } catch {
        // Match the real transport: one faulty listener must not block others.
      }
    }
  }

  function setResponse<TPayload>(
    type: GitRequestType,
    payload: TPayload,
    options: { ok?: boolean; error?: GitTransportError | null } = {},
  ): void {
    const ok = options.ok ?? true
    responses.set(type, {
      ok,
      payload: ok ? payload : null,
      error: options.error ?? null,
    })
  }

  function setRejection(type: GitRequestType, error: Error | string = 'transport unavailable'): void {
    rejections.set(type, typeof error === 'string' ? new Error(error) : error)
  }

  function clearRejection(type: GitRequestType): void {
    rejections.delete(type)
  }

  const transport: GitTransport = { status, send, on }
  return { transport, sent, emit, setResponse, setRejection, clearRejection }
}
