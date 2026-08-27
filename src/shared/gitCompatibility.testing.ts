import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  HOST_GIT_EVENT_TYPES,
  HOST_GIT_REQUEST_TYPES,
  HOST_GIT_TIMEOUT_MS,
  type GitEventType,
  type GitRequestType,
  type GitTransport,
  type GitTransportError,
  type GitTransportStatus,
} from './gitCompatibility'

export interface GitTransportRequestRecord {
  type: GitRequestType
  payload: Record<string, unknown>
  timeoutMs: number
}

export interface GitTransportContractHarness {
  transport: GitTransport
  sent: readonly GitTransportRequestRecord[]
  emit(type: GitEventType, payload: unknown): void
  setResponse<TPayload>(
    type: GitRequestType,
    payload: TPayload,
    options?: { ok?: boolean; error?: GitTransportError | null },
  ): void
}

/** Shared behavior contract for Host and legacy recovery transport adapters. */
export function runGitTransportContract(createHarness: () => GitTransportContractHarness): void {
  describe('Git transport contract', () => {
    it('matches the Git-only surface and exposes the injected status', () => {
      const harness = createHarness()
      expectTypeOf<keyof GitTransport>().toEqualTypeOf<'status' | 'send' | 'on'>()
      expect(harness.transport.status.value).toBe('connected' satisfies GitTransportStatus)
      expect(HOST_GIT_REQUEST_TYPES.every((type) => type.startsWith('git.'))).toBe(true)
      expect(HOST_GIT_EVENT_TYPES).toEqual([
        'git.changed',
        'git.credential_request',
        'git.credential_cancelled',
      ])
    })

    it('preserves request payloads, timeouts, and response errors', async () => {
      const harness = createHarness()
      const status = { is_git_repo: true, branch: 'main' }
      harness.setResponse('git.status', status)
      await expect(harness.transport.send('git.status', {
        workspace_path: '/workspace',
        include_ignored: false,
      }, 20_000)).resolves.toMatchObject({ ok: true, payload: status, error: null })

      harness.setResponse('git.stage', { ok: true })
      await harness.transport.send('git.stage', {
        workspace_path: '/workspace', files: ['src/index.ts'],
      }, 20_000)

      harness.setResponse('git.diff_file', { ok: false, diff: '', error: 'cannot load diff' })
      await harness.transport.send('git.diff_file', {
        workspace_path: '/workspace', filepath: 'src/index.ts',
      })

      harness.setResponse('git.commit', null, {
        ok: false,
        error: { code: 'GIT_FAILED', message: 'nothing to commit' },
      })
      await expect(harness.transport.send('git.commit', { workspace_path: '/workspace' }))
        .resolves.toMatchObject({
          ok: false,
          payload: null,
          error: { code: 'GIT_FAILED', message: 'nothing to commit' },
        })

      expect(harness.sent).toEqual([
        { type: 'git.status', payload: { workspace_path: '/workspace', include_ignored: false }, timeoutMs: 20_000 },
        { type: 'git.stage', payload: { workspace_path: '/workspace', files: ['src/index.ts'] }, timeoutMs: 20_000 },
        { type: 'git.diff_file', payload: { workspace_path: '/workspace', filepath: 'src/index.ts' }, timeoutMs: HOST_GIT_TIMEOUT_MS },
        { type: 'git.commit', payload: { workspace_path: '/workspace' }, timeoutMs: HOST_GIT_TIMEOUT_MS },
      ])
    })

    it('delivers Git events, isolates listener failures, and disposes subscriptions', () => {
      const harness = createHarness()
      const failingListener = vi.fn(() => { throw new Error('listener failed') })
      const listener = vi.fn()
      const offFailingListener = harness.transport.on('git.changed', failingListener)
      const offListener = harness.transport.on('git.changed', listener)
      const payload = { workspace_path: '/workspace' }

      harness.emit('git.changed', payload)
      expect(failingListener).toHaveBeenCalledWith(payload)
      expect(listener).toHaveBeenCalledWith(payload)

      offFailingListener()
      offListener()
      harness.emit('git.changed', payload)
      expect(failingListener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })
}
