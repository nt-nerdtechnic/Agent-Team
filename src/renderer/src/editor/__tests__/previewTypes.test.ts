// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { buildPageUrl, buildRawUrl, previewKind, wsTokenFromUrl } from '../previewTypes'

describe('previewKind – wave 2 kinds', () => {
  it('classifies .ipynb as notebook and .docx/.xlsx as office (over the binary fallback)', () => {
    expect(previewKind('nb/analysis.ipynb')).toBe('notebook')
    expect(previewKind('docs/report.docx')).toBe('office')
    expect(previewKind('docs/data.xlsx')).toBe('office')
    // Other office-ish extensions still fall back to the binary card.
    expect(previewKind('docs/slides.pptx')).toBe('binary')
  })
})

describe('wsTokenFromUrl', () => {
  it('pulls the t= query off the socket URL the main process handed over', () => {
    expect(wsTokenFromUrl('ws://127.0.0.1:8123/ws?t=abc-DEF_123')).toBe('abc-DEF_123')
    expect(wsTokenFromUrl('ws://127.0.0.1:8123/ws?x=1&t=a%2Bb')).toBe('a+b')
  })
  it('is empty when there is no token — the routes then refuse, never fall open', () => {
    expect(wsTokenFromUrl('ws://127.0.0.1:8123/ws')).toBe('')
    expect(wsTokenFromUrl('')).toBe('')
  })
})

describe('buildRawUrl', () => {
  it('carries the ws token in the query, encoded', () => {
    expect(buildRawUrl('http://h/', '/ws', 'a b.png', 'tok+1')).toBe(
      'http://h/fs/raw?workspace=%2Fws&rel=a%20b.png&t=tok%2B1',
    )
  })
})

describe('buildPageUrl', () => {
  // The workspace segment now comes from the backend (fs.page_capability
  // returns ws_b64 with the cap it was computed over); the builder only
  // assembles. L3dz = unpadded URL-safe base64 of '/ws'.
  it('builds /fs/page/{cap}/{ws_b64}/{rel} with the capability ahead of the workspace', () => {
    expect(buildPageUrl('http://127.0.0.1:8123', 'CAP123', 'L3dz', 'site/index.html')).toBe(
      'http://127.0.0.1:8123/fs/page/CAP123/L3dz/site/index.html',
    )
  })

  it('percent-encodes rel path segments while keeping slashes, and trims the base', () => {
    expect(buildPageUrl('http://h/', 'CAP', 'L3dz', 'sub dir/頁面.html')).toBe(
      'http://h/fs/page/CAP/L3dz/sub%20dir/%E9%A0%81%E9%9D%A2.html',
    )
  })

  it('never puts the ws token itself in the path', () => {
    // Relative subresources of an untrusted previewed page inherit the path;
    // a token there would leave via Referer. The builder has no token input.
    const url = buildPageUrl('http://h', 'CAP', 'L3dz', 'index.html')
    expect(url).not.toContain('t=')
  })
})
