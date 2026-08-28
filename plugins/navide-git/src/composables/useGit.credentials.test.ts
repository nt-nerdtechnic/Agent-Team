// @vitest-environment happy-dom
import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { GitTransport } from '#git-feature'
import { useGit } from './useGit'

describe('v2 Git askpass pairing', () => {
  it('pairs Host-routed username and password requests and submits both values', async () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    const send = vi.fn(async () => ({ ok: true, payload: { ok: true }, error: null }))
    const transport = {
      status: ref('connected'),
      send,
      on: (event: string, listener: (payload: unknown) => void) => {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
    } as unknown as GitTransport
    const scope = effectScope()
    const git = scope.run(() => useGit(() => '/workspace', transport))!

    listeners.get('git.credential_request')?.({
      request_id: 'username-request',
      host: 'github.com',
      prompt: "Username for 'https://github.com':",
    })
    listeners.get('git.credential_request')?.({
      request_id: 'password-request',
      host: 'github.com',
      prompt: "Password for 'https://github.com':",
    })
    expect(git.showCredentialPrompt.value).toBe(true)
    expect(git.credentialPrompt.value?.host).toBe('github.com')

    git.credentialPrompt.value!.username = 'octocat'
    git.credentialPrompt.value!.password = 'token'
    await git.submitCredential()

    expect(send).toHaveBeenCalledWith('git.credential_submit', {
      request_id: 'username-request',
      value: 'octocat',
    })
    expect(send).toHaveBeenCalledWith('git.credential_submit', {
      request_id: 'password-request',
      value: 'token',
    })
    expect(git.credentialPrompt.value).toBeNull()
    scope.stop()
  })
})
