// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Switching workspace left the stage blank rather than empty: the panes on
// screen belong to the workspace being left, and a switch filters them out
// instead of tearing them down, so nothing rendered and nothing said why.
// Restoring the entered workspace probes each CLI, so the blank could last
// seconds and read as a click that did nothing.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** A top-level function's text, up to the next declaration. */
function body(name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = appSource.indexOf(pat)
    if (at < 0) continue
    const rest = appSource.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return appSource.slice(at, at + pat.length + (next ? next.index : 4000))
  }
  throw new Error(`${name} not found`)
}

const fn = body('switchToWorkspace')

describe('the stage says a switch is happening', () => {
  it('covers the stage for the whole switch', () => {
    // Raised before the first await of the switch itself, not after: the work
    // that leaves the stage blank starts there.
    expect(fn.indexOf('switchingWorkspace.value = true')).toBeLessThan(
      fn.indexOf('await onWorkspaceBrowse(path, { keepPanes: true })')
    )
  })

  it('uncovers it on every way out, not just the happy one', () => {
    // A switch can decline (the workspace turned out to be open elsewhere) or
    // throw from restore. Either would leave a spinner sitting over panes that
    // are already there, with no way to clear it short of a reload.
    expect(fn).toContain('} finally {')
    const at = fn.indexOf('} finally {')
    expect(fn.slice(at, at + 400)).toContain('switchingWorkspace.value = false')
    // And the flag is cleared in exactly one place — the finally.
    expect(fn.split('switchingWorkspace.value = false')).toHaveLength(2)
  })

  it('names the workspace being entered', () => {
    // "Loading…" over a blank stage says no more than the blank did.
    expect(fn).toContain('switchingWorkspaceName.value =')
    expect(appSource).toContain("$t('switchWorkspace.loading', { name: switchingWorkspaceName })")
  })

  it('covers the panes rather than replacing them', () => {
    // The panes stay mounted through a switch — they belong to the workspace
    // being left and come back on the way back. Rendering the cover instead of
    // the grid would unmount them and dispose their terminals.
    expect(appSource).toContain('class="stage-switching"')
    const at = appSource.indexOf('.stage-switching {')
    expect(at).toBeGreaterThan(-1)
    const css = appSource.slice(at, at + 260)
    expect(css).toContain('position: absolute')
    expect(css).toContain('inset: 0')
    // Opaque: a wash over another project's terminals reads as a glitch.
    expect(css).toContain('background: var(--bg-base)')
  })

  it('does not delay the switch it is announcing', () => {
    // Fade out only. A fade-in would add its own wait to the thing already
    // making the user wait.
    expect(appSource).toContain('.ws-switch-leave-active')
    expect(appSource).not.toContain('.ws-switch-enter-active')
  })

  it('leaves the empty-stage branch alone', () => {
    // The cover is the stage's last child, not a sibling wedged between the
    // "no panes at all" card and the grid — inserting one there breaks the
    // v-if/v-else pair and the grid stops rendering entirely.
    expect(appSource.indexOf('<div v-if="panes.length === 0" class="empty">')).toBeLessThan(
      appSource.indexOf('<div v-else class="grid"')
    )
    expect(appSource.indexOf('<div v-else class="grid"')).toBeLessThan(
      appSource.indexOf('class="stage-switching"')
    )
  })
})
