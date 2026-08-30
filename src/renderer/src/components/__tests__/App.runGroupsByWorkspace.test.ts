// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Run groups are persisted per workspace, but the window held only the viewed
// workspace's list. The sidebar lists every workspace the window holds, so it
// had nothing to split the others' panes by: they fell into the ungrouped
// catch-all, the row collapsed to a single unnamed section, and ControlPane
// renders such a row bare — a project's Run headings vanished the moment you
// switched away, though its records sat intact on disk.
//
// runGroupsByWorkspace is the window's copy of what each held workspace has
// persisted. What keeps it true is that it is written wherever the list is
// read from or written to disk, and dropped when the window lets a workspace
// go. These pin those write points.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** A top-level declaration's text, up to the next one. */
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

describe('runGroupsByWorkspace', () => {
  it('exists as a per-workspace store, not a second global list', () => {
    expect(appSource).toContain('const runGroupsByWorkspace = ref<Record<string, readonly RunGroup[]>>({})')
  })

  it('is keyed by the normalised path, so a trailing slash is the same workspace', () => {
    const cache = body('_cacheRunGroups')
    expect(cache).toContain('const key = normWs(path)')
    expect(cache).toContain('runGroupsByWorkspace.value = { ...runGroupsByWorkspace.value, [key]: [...groups] }')
  })

  it('mirrors every persisted change, because all group edits funnel through the save', () => {
    // createRunGroup / rename / reorder / the three deletes / ensureSavedGroup /
    // adoptOrphanRunGroups all end in _saveRunGroups. Mirroring there covers
    // them without a write point per mutation.
    const save = body('_saveRunGroups')
    expect(save).toContain('_cacheRunGroups(ws, runGroups.value)')
    // Still behind the owner guard: a save that must not reach disk must not
    // reach the sidebar's copy either.
    expect(save.indexOf('if (normWs(runGroupsOwner.value) !== normWs(ws)) return'))
      .toBeLessThan(save.indexOf('_cacheRunGroups(ws, runGroups.value)'))
  })

  it('seeds the store for the workspace being entered', () => {
    expect(body('_loadRunGroups')).toContain('_cacheRunGroups(path, runGroups.value)')
  })

  it('caches a remote change, which applyingRemote keeps out of _saveRunGroups', () => {
    const sync = appSource.slice(appSource.indexOf('runGroupsOwner.value = ws'))
    expect(sync.slice(0, 400)).toContain('_cacheRunGroups(ws, merged)')
  })

  it('loads held workspaces the session never viewed, serially and best-effort', () => {
    const pre = body('prefetchHeldRunGroups')
    expect(pre).toContain('if (isDetachedWindow) return')
    // Skips the viewed workspace (its own load covers it) and anything cached.
    expect(pre).toContain("if (!path || normWs(path) === normWs(currentWorkspace.value)) continue")
    expect(pre).toContain('if (normWs(path) in runGroupsByWorkspace.value) continue')
    // Serial: cold boot already contends for the backend's workers.
    expect(pre).toContain('await sendQuiet<ProjectPayload>')
    expect(pre).not.toContain('Promise.all')
  })

  it('runs the prefetch on both ways a window comes up holding workspaces', () => {
    // A reload keeps the roster in sessionStorage and loads no groups at all;
    // a relaunch restores it and peeks each one, which already carries them.
    expect(appSource).toContain('void prefetchHeldRunGroups()')
    expect(appSource).toContain('await prefetchHeldRunGroups()')
  })

  it('forgets a workspace the window lets go, so re-opening it reloads', () => {
    // Otherwise the stale entry survives and the prefetch skips it as cached.
    const forget = body('_forgetRunGroups')
    expect(forget).toContain('delete next[key]')
    expect(body('closeWorkspace')).toContain('_forgetRunGroups(path)')
    expect(body('detachWorkspace')).toContain('_forgetRunGroups(path)')
  })

  it('hands the store to the sidebar builder', () => {
    expect(appSource).toContain('runGroupsByWorkspace: runGroupsByWorkspace.value,')
  })
})
