// The main window's minimum size, as a floor under the shell layout.
//
// The renderer's grid lets the side panels shrink rather than overflow, but a
// window narrow enough to squeeze the stage down to its floor is not a window
// anyone wants; this stops it happening at all. Source-scanned because
// constructing a BrowserWindow needs a live Electron app.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

describe('main window minimum size', () => {
  it('floors the main window above the two side panels put together', () => {
    const at = mainSource.indexOf("title: 'Navide',")
    expect(at).toBeGreaterThan(-1)
    const opts = mainSource.slice(mainSource.lastIndexOf('new BrowserWindow({', at), at)
    const min = /minWidth:\s*(\d+)/.exec(opts)
    expect(min, 'main window declares no minWidth').not.toBeNull()
    // 560 (left max) + 36 (collapsed rail) + the stage's 220px floor is 816,
    // so this does not fit both panels at full width — it is the point below
    // which the panels start yielding, not a guarantee they never do.
    expect(Number(min![1])).toBeGreaterThanOrEqual(640)
    expect(/minHeight:\s*(\d+)/.test(opts)).toBe(true)
  })
})
