// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Dragging a workspace heading out of the window gives it its own window.
//
// The gesture already existed for a stage tab, but only for a run group — the
// sidebar had nothing draggable except an agent line, before this feature and
// after it. What makes this one easy to get wrong is that it looks like
// closeWorkspace and must not behave like it: closing a workspace kills its
// panes, and a detach that killed them would restart every CLI in the window
// it just opened.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = read('src/renderer/src/App.vue')
const paneSource = read('src/renderer/src/components/ControlPane.vue')
const mainSource = read('src/main/index.ts')

/** A top-level function's text, up to the next declaration. */
function body(source: string, name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = source.indexOf(pat)
    if (at < 0) continue
    const rest = source.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return source.slice(at, at + pat.length + (next ? next.index : 3000))
  }
  throw new Error(`${name} not found`)
}

/** The detach handler in main, which is short enough to read whole. */
const detachHandler = mainSource.slice(
  mainSource.indexOf("'window:detachWorkspace'"),
  mainSource.indexOf("'window:detachWorkspace'") + 900
)

describe('detaching a workspace into its own window', () => {
  it('hands the panes over instead of killing them', () => {
    // The whole point of the feature. closeWorkspace kills, because closing
    // says the user is finished; detach must not, because the new window is
    // about to restore exactly those panes from the backend.
    expect(body(appSource, 'detachWorkspace')).not.toContain('onKill(')
    expect(body(appSource, 'closeWorkspace')).toContain('onKill(')
  })

  it('steps off the workspace before handing it over', () => {
    // Detaching the one on screen would leave this window viewing a workspace
    // it no longer holds — the blank main area, reached a different way.
    const fn = body(appSource, 'detachWorkspace')
    expect(fn).toContain('await switchToWorkspace(fallback)')
    expect(fn.indexOf('await switchToWorkspace(fallback)')).toBeLessThan(
      fn.indexOf('workspaceOrder.value = workspaceOrder.value.filter')
    )
  })

  it('refuses when the window holds only one workspace', () => {
    // It would empty this window to fill a new one.
    expect(body(appSource, 'detachWorkspace')).toContain('workspaceOrder.value.length < 2')
  })

  it('reports the shortened list before asking for the window', () => {
    // main decides whether the workspace is already held; if this window still
    // claims it, the drag turns into a focus of the window it came from.
    const fn = body(appSource, 'detachWorkspace')
    expect(fn.indexOf('persistExtraWorkspaces()')).toBeLessThan(fn.indexOf('detachWorkspace?.({'))
  })

  it('does not rely on that report alone', () => {
    // The report travels on a send, the request on an invoke. main skips the
    // caller outright rather than trusting the two to arrive in order.
    expect(detachHandler).toContain('found !== source')
  })

  it('lets the new window restore the panes', () => {
    // `duplicate` is what window:openMain sets to SKIP restore, for a window
    // cloned from one still showing the same sessions. Setting it here would
    // open an empty window beside a workspace full of running agents.
    //
    // Anchored on createWindow first: without it the slice below could be
    // anywhere in the file and still not contain the word.
    expect(detachHandler).toContain('createWindow(')
    expect(detachHandler).not.toContain('duplicate')
  })

  it('is wired from the sidebar', () => {
    expect(appSource).toContain('@detach-workspace="detachWorkspace"')
  })
})

describe('the drag gesture itself', () => {
  it('fires only on a release outside this window', () => {
    // Same rule as a stage tab drag-out in StageTabBar: a drop anywhere inside
    // is an ordinary miss, not a request for a new window.
    const fn = body(paneSource, 'onWsDragEnd')
    expect(fn).toContain('e.clientX > window.innerWidth')
    expect(fn).toContain("if (outside) emit('detach-workspace'")
  })

  it('is offered only when there is somewhere to detach from', () => {
    // One guard, two gestures: released on another heading the drag reorders,
    // released outside the window it detaches. Both need a second workspace —
    // hence the shared name.
    expect(paneSource).toContain('!props.detachedWindow && localWorkspaceRows.value.length > 1')
    expect(paneSource).toContain(':draggable="canDragWorkspace"')
  })

  it('carries its own drag type', () => {
    // The sidebar's drop targets read application/x-pane-id; a workspace drag
    // reading as a pane drag would reorder panes on a miss.
    expect(body(paneSource, 'onWsDragStart')).toContain("'application/x-workspace-path'")
  })
})
