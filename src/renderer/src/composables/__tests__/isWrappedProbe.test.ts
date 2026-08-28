// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'

function write(t: Terminal, d: string): Promise<void> {
  return new Promise((r) => t.write(d, r))
}
function rows(t: Terminal): Array<{ text: string; wrapped: boolean }> {
  const b = t.buffer.active
  const out: Array<{ text: string; wrapped: boolean }> = []
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i)
    if (!l) continue
    const text = l.translateToString(true).trim()
    if (text) out.push({ text: text.length > 12 ? `${text.slice(0, 6)}…(${text.length})` : text, wrapped: l.isWrapped })
  }
  return out
}

describe('isWrapped tells a folded remainder from a genuinely short rule', () => {
  it('marks the fold, not the CLI-drawn short rule', async () => {
    const t = new Terminal({ cols: 110, rows: 20, allowProposedApi: true })
    t.open(document.createElement('div'))
    await write(t, '─'.repeat(110) + '\r\n')
    t.resize(87, 20)
    await write(t, '─'.repeat(87) + '\r\n')      // the CLI's own repaint
    console.log('[at 87]', JSON.stringify(rows(t)))
    const r = rows(t)
    const folded = r.filter((x) => x.wrapped)
    const drawn = r.filter((x) => !x.wrapped)
    expect(folded.length).toBe(1)                 // the 23-col remainder
    expect(folded[0].text).toContain('(23)')
    expect(drawn.some((x) => x.text.includes('(87)'))).toBe(true)  // untouched
    t.dispose()
  })
})
