// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'

function write(t: Terminal, d: string): Promise<void> {
  return new Promise((r) => t.write(d, r))
}

describe('what the old snapshot preserved that a transcript does not', () => {
  it('SerializeAddon keeps a wrapped line as ONE logical line', async () => {
    const t = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
    const ser = new SerializeAddon()
    t.loadAddon(ser)
    t.open(document.createElement('div'))

    // 100 chars at 40 cols → xterm wraps it across 3 rows.
    await write(t, 'x'.repeat(100) + '\r\n')

    const out = ser.serialize({ scrollback: 100 })
    const firstBlock = out.split('\r\n')[0]
    console.log('[snapshot] rows used on screen: 3, but serialize emits the run as one line of length',
      firstBlock.length)
    // If it emitted the visual rows it would be 40; one logical line is 100.
    expect(firstBlock.length).toBe(100)
    t.dispose()
  })

  it('a transcript line is already hard-broken and cannot re-wrap', async () => {
    // What _clean_for_log writes: the CLI's own line breaks, baked in.
    const transcript = 'x'.repeat(40) + '\n' + 'x'.repeat(40) + '\n' + 'x'.repeat(20) + '\n'
    const t = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
    t.open(document.createElement('div'))
    await write(t, transcript.replace(/\n/g, '\r\n'))

    const before = countWrapped(t)
    t.resize(80, 10)          // widen — a logical line would rejoin here
    const after = countWrapped(t)

    console.log('[transcript] wrapped rows at 40 cols:', before, '→ at 80 cols:', after)
    // Nothing was ever wrapped by xterm, so widening rejoins nothing.
    expect(before).toBe(0)
    expect(after).toBe(0)
    t.dispose()
  })
})

function countWrapped(t: Terminal): number {
  const b = t.buffer.active
  let n = 0
  for (let i = 0; i < b.length; i++) if (b.getLine(i)?.isWrapped) n++
  return n
}
