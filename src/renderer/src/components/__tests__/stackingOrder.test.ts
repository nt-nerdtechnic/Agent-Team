// Nothing in this app may hardcode itself above the notification band.
//
// Written after a pairing request — a security question that expires in five
// minutes — was drawn behind the account window and blurred by its backdrop.
// The prompt used `var(--z-toast)` (3000) exactly as intended; the account
// window used `z-index: 8000`, a number chosen at some point to beat whatever
// was on screen then, and 8000 wins.
//
// The test that was supposed to hold this compared `--z-toast` against
// `--z-modal` and found the tokens correctly ordered. Both facts were true and
// neither was in the fight: the window that covered the prompt never mentioned
// either token. So this one reads the numbers that are actually written down,
// which is the only place the browser looks.
//
// It is deliberately a scan and not a mount. What breaks this rule is a new
// component nobody thought to test, added months from now — the failure mode is
// "not covered", so the assertion has to be about the whole tree rather than
// about the components somebody remembered.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const RENDERER = resolve(here, '../..')
const TOKENS = readFileSync(
  resolve(here, '../../../../../packages/plugin-ui/src/foundation/styles/tokens/semantic.css'),
  'utf8',
)

const level = (name: string) => Number(TOKENS.match(new RegExp(`--z-${name}: (\\d+)`))![1])

/**
 * Literal `z-index: <number>` written anywhere under the renderer.
 *
 * A literal is not wrong in itself — a sticky header at 10 inside its own
 * stacking context is fine and there are dozens of those. What is wrong is a
 * literal large enough to leave the band it belongs to, because such a number
 * is invisible to every rule expressed in tokens.
 */
function literals(): { file: string; line: number; value: number }[] {
  const found: { file: string; line: number; value: number }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && entry !== '__tests__') walk(full)
        continue
      }
      if (!entry.endsWith('.vue') && !entry.endsWith('.css')) continue
      readFileSync(full, 'utf8').split('\n').forEach((text, i) => {
        const m = text.match(/z-index:\s*(\d+)/)
        if (m) found.push({ file: full.slice(RENDERER.length + 1), line: i + 1, value: Number(m[1]) })
      })
    }
  }
  walk(RENDERER)
  return found
}

describe('stacking order', () => {
  it('finds the stylesheets it is supposed to be reading', () => {
    // The whole test is a search, and a search that matches nothing passes.
    expect(literals().length).toBeGreaterThan(40)
    expect(level('toast')).toBeGreaterThan(level('modal'))
  })

  it('has nothing hardcoded above the notification band', () => {
    // Where a modal genuinely has to sit above another modal, say so against
    // the token — `calc(var(--z-modal) + 10)` stays inside the band and stays
    // under anything that has to reach a person. A number here instead is the
    // exact shape of the bug: it wins against layers it never names.
    const over = literals().filter((l) => l.value > level('toast'))

    expect(over.map((l) => `${l.file}:${l.line} → ${l.value}`)).toEqual([])
  })

  it('keeps the pairing prompt above every overlay in the app', () => {
    // The one that was reported, asserted on the two files by name so the
    // reason this test exists survives a rewrite of everything around it.
    const prompt = readFileSync(join(RENDERER, 'components/PairingPrompt.vue'), 'utf8')
    const account = readFileSync(join(RENDERER, 'components/AccountModal.vue'), 'utf8')
    const settings = readFileSync(join(RENDERER, 'components/SettingsModal.vue'), 'utf8')

    expect(prompt).toContain('z-index: var(--z-toast)')
    for (const [name, source] of [['account', account], ['settings', settings]] as const) {
      const rule = source.match(/\.s-overlay \{[\s\S]*?\}/)![0]
      expect(rule, `${name} overlay`).toMatch(/z-index:[^;]*var\(--z-modal\)/)
    }
  })
})
