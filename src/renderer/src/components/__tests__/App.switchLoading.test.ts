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
  it('arms the cover before the work that would blank the stage', () => {
    // The timer is set before the first await, not after: the work that leaves
    // the stage blank starts there.
    expect(fn.indexOf('const coverTimer = setTimeout')).toBeLessThan(
      fn.indexOf('await onWorkspaceBrowse(path, { keepPanes: true })')
    )
    expect(fn).toContain('switchingWorkspace.value = true')
  })

  it('does not flash on a switch that finishes quickly', () => {
    // A switch with nothing to restore is a peek round trip and a tick.
    // Showing a spinner for that and fading it out again reads as a glitch,
    // not as loading — so the cover waits to see whether it is needed.
    expect(appSource).toContain('const SWITCH_COVER_DELAY_MS = 180')
    expect(fn).toContain('}, SWITCH_COVER_DELAY_MS)')
    // Raised inside the timer, so a fast switch never raises it at all.
    const at = fn.indexOf('const coverTimer = setTimeout')
    const armed = fn.slice(at, fn.indexOf('SWITCH_COVER_DELAY_MS)', at))
    expect(armed).toContain('switchingWorkspace.value = true')
  })

  it('never lets a finished switch raise the cover later', () => {
    // The timer outlives a fast switch. Left pending, it would cover a stage
    // whose switch is already over — a spinner with nothing behind it.
    // Cleared unconditionally, unlike the flag, which only the newest owns.
    const at = fn.indexOf('} finally {')
    expect(fn.slice(at)).toContain('clearTimeout(coverTimer)')
    expect(fn.slice(at).indexOf('clearTimeout(coverTimer)')).toBeLessThan(
      fn.slice(at).indexOf('if (coverSeq === switchCoverSeq)')
    )
  })

  it('uncovers it on every way out, not just the happy one', () => {
    // A switch can decline (the workspace turned out to be open elsewhere) or
    // throw from restore. Either would leave a spinner sitting over panes that
    // are already there, with no way to clear it short of a reload.
    expect(fn).toContain('} finally {')
    // To the end of the function rather than a fixed window: everything after
    // the finally IS the finally, and a character count only measures how long
    // the comment above the line happens to be.
    const at = fn.indexOf('} finally {')
    expect(fn.slice(at)).toContain('switchingWorkspace.value = false')
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

  it('lets only the newest switch uncover the stage', () => {
    // The cover is over the stage, not the sidebar, so the list stays clickable
    // while a switch runs and a second workspace can be picked mid-switch. Both
    // runs then race to the same finally, and the first to get there would
    // uncover a stage the second is still rebuilding — putting back exactly the
    // blank this was added to fill.
    expect(fn).toContain('const coverSeq = ++switchCoverSeq')
    expect(fn).toMatch(/if \(coverSeq === switchCoverSeq\) \{\s*\n\s*switchingWorkspace\.value = false/)
    // Claimed before the first await, or the second run could claim first.
    expect(fn.indexOf('const coverSeq = ++switchCoverSeq')).toBeLessThan(
      fn.indexOf('await onWorkspaceBrowse(path, { keepPanes: true })')
    )
    // The pending timer checks ownership too: a slow first switch must not
    // raise a cover naming the workspace a second switch has moved on from.
    expect(fn).toContain('if (coverSeq === switchCoverSeq) switchingWorkspace.value = true')
  })

  it('is the only way a switch can happen', () => {
    // Every entry point — a sidebar heading, the picker, clicking a pane in
    // another workspace, detaching the one on screen — goes through
    // switchToWorkspace. Nothing enforced that, so a new path added later
    // would switch with no cover and the animation would silently not appear.
    //
    // A keepPanes browse IS a switch: keeping the panes of the workspace being
    // left is what distinguishes it from an ordinary browse, which kills them.
    // So exactly one of those may exist, and it must be inside this function.
    const all = appSource.split('keepPanes: true')
    expect(all).toHaveLength(2)
    expect(fn).toContain('await onWorkspaceBrowse(path, { keepPanes: true })')
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
