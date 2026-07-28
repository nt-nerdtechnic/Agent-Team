import { describe, expect, it, vi } from 'vitest'
import {
  isSecretSettingKey,
  nextRecordKey,
  RevisionedMcpSaveQueue,
  shouldReloadMcpAfterBundleImport,
  switchMcpTransportShape,
} from '../mcp-settings-editor'

describe('MCP settings editor helpers', () => {
  it.each([
    'Auth',
    'Authorization',
    'Set-Cookie',
    'clientCredential',
    'clientCredentials',
    'PRIVATE_KEY',
    'X-Key',
    'APIKey',
    'API_KEY',
    'GITHUB_TOKEN',
    'CLIENT_SECRET',
    'DB_PASSWORD',
    'SSH_PASSWD',
    'SSH_PASSPHRASE',
  ])(
    'recognizes secret-looking field %s',
    (key) => expect(isSecretSettingKey(key)).toBe(true)
  )

  it.each(['LOG_LEVEL', 'MONKEY'])('leaves ordinary field %s visible', (key) => {
    expect(isSecretSettingKey(key)).toBe(false)
  })

  it('switches to the selected transport shape and removes incompatible fields', () => {
    const server = {
      transport: 'stdio' as const,
      command: 'npx',
      args: ['server'],
      env: { TOKEN: 'secret' },
    }

    switchMcpTransportShape(server, 'http')

    expect(server).toEqual({ transport: 'http', url: '', headers: {} })
  })

  it('reloads MCP only when bundle import reports MCP as applied', () => {
    expect(shouldReloadMcpAfterBundleImport(['roles', 'mcp'])).toBe(true)
    expect(shouldReloadMcpAfterBundleImport([])).toBe(false)
    expect(shouldReloadMcpAfterBundleImport(undefined)).toBe(false)
  })

  it('allocates a record key without overwriting an existing entry', () => {
    expect(nextRecordKey({}, 'NEW_KEY')).toBe('NEW_KEY')
    expect(nextRecordKey({ NEW_KEY: '', NEW_KEY_2: '' }, 'NEW_KEY')).toBe('NEW_KEY_3')
  })

  it('preserves a queued B snapshot while A is pending and refreshes only after the queue drains', async () => {
    let resolveA!: (value: { ok: boolean; revision: string }) => void
    let resolveB!: (value: { ok: boolean; revision: string }) => void
    const pendingA = new Promise<{ ok: boolean; revision: string }>((resolve) => { resolveA = resolve })
    const pendingB = new Promise<{ ok: boolean; revision: string }>((resolve) => { resolveB = resolve })
    const saves: Array<{ value: string; revision: string | null }> = []
    const refreshed: string[] = []
    const queue = new RevisionedMcpSaveQueue<{ value: string }>(
      async (snapshot, revision) => {
        saves.push({ value: snapshot.value, revision })
        return saves.length === 1 ? pendingA : pendingB
      },
      async (snapshot) => { refreshed.push(snapshot.value) }
    )
    const draft = { value: 'A' }

    const saveA = queue.enqueue(draft, 'rev-0')
    draft.value = 'B'
    const saveB = queue.enqueue(draft, 'rev-0')
    await vi.waitFor(() => expect(saves).toEqual([{ value: 'A', revision: 'rev-0' }]))

    resolveA({ ok: true, revision: 'rev-1' })
    await saveA
    await vi.waitFor(() => expect(saves).toEqual([
      { value: 'A', revision: 'rev-0' },
      { value: 'B', revision: 'rev-1' },
    ]))
    expect(refreshed).toEqual([])

    resolveB({ ok: true, revision: 'rev-2' })
    await expect(saveB).resolves.toBe(true)
    expect(refreshed).toEqual(['B'])
  })
})
