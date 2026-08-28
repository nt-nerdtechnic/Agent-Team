import { describe, it, expect, vi } from 'vitest'
import { loadImageDataUrl } from '../imageData'

function mockBackend(resp: unknown, throws = false) {
  const readImage = vi.fn(async (_workspacePath: string, _relPath: string) => {
    if (throws) throw new Error('ws closed')
    const response = resp as { ok?: boolean; payload?: { ok?: boolean; data_url?: string } } | null
    return response?.ok && response.payload?.ok ? (response.payload.data_url ?? '') : ''
  })
  return {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readImage,
  } as unknown as Parameters<typeof loadImageDataUrl>[0]
}

describe('loadImageDataUrl', () => {
  it('returns the data URL on success', async () => {
    const fileAccess = mockBackend({ ok: true, payload: { ok: true, data_url: 'data:image/png;base64,AAAA' } })
    expect(await loadImageDataUrl(fileAccess, '/ws', 'pic.png')).toBe('data:image/png;base64,AAAA')
  })

  it('returns empty string when backend reports failure', async () => {
    const fileAccess = mockBackend({ ok: true, payload: { ok: false } })
    expect(await loadImageDataUrl(fileAccess, '/ws', 'pic.png')).toBe('')
  })

  it('returns empty string on transport error', async () => {
    const fileAccess = mockBackend(null, true)
    expect(await loadImageDataUrl(fileAccess, '/ws', 'pic.png')).toBe('')
  })

  it('sends fs.read_image with workspace_path and rel_path', async () => {
    const fileAccess = mockBackend({ ok: true, payload: { ok: true, data_url: 'data:,' } })
    await loadImageDataUrl(fileAccess, '/ws', 'a/b.png')
    expect(fileAccess.readImage).toHaveBeenCalledWith('/ws', 'a/b.png')
  })
})
