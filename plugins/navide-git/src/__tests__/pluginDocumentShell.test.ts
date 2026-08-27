import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shellCss = readFileSync(new URL('../pluginDocument.css', import.meta.url), 'utf8')

describe('navide.git document shell', () => {
  it('owns the full isolated document viewport without exposing the browser canvas', () => {
    expect(shellCss).toMatch(/html\s*,\s*body\s*,\s*#app\s*{[^}]*margin:\s*0[^}]*}/s)
    expect(shellCss).toMatch(/html\s*,\s*body\s*,\s*#app\s*{[^}]*height:\s*100%[^}]*}/s)
    expect(shellCss).toMatch(/html\s*,\s*body\s*,\s*#app\s*{[^}]*overflow:\s*hidden[^}]*}/s)
    expect(shellCss).toMatch(/body\s*{[^}]*background:\s*var\(--bg-base\)[^}]*}/s)
  })
})
