// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text.
//
// They lock in the fix for a duplication loop: closing a detached window added
// a second copy of every pane in that group, and each cycle added another.
//
// The cause was a restore that could run twice over the same records. A main
// window launched while a group was already detached restored that group from
// the project document (it had no reason not to), and closing the child then
// restored it again. Three guards, in the order they take effect.

const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

describe('detach / reattach must not duplicate panes', () => {
  it('reattach clears the group from this window before restoring it', () => {
    const start = appSource.indexOf('async function handleGroupReattached')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    const clearAt = body.indexOf("panes.value.filter((p) => (p.runGroupId ?? '') !== groupId)")
    const restoreAt = body.indexOf('restoreWorkspacePanes')
    expect(clearAt).toBeGreaterThan(-1)
    expect(restoreAt).toBeGreaterThan(-1)
    // Order is the whole point: clearing after the restore would delete the
    // panes it just brought back.
    expect(clearAt).toBeLessThan(restoreAt)
  })

  it('an ordinary main-window restore skips detached groups', () => {
    expect(appSource).toContain(
      "toRestore = toRestore.filter((p) => !detachedGroupIds.value.has(p.run_group_id ?? ''))"
    )
  })

  it('that skip is gated on knowing which groups are detached', () => {
    // The list arrives asynchronously from main; without the await the filter
    // above reads an empty set and lets everything through.
    expect(appSource).toContain('await detachedGroupsKnown')
  })

  it('the detached-groups lookup cannot stall restore for ever', () => {
    const start = appSource.indexOf('detachedGroupsKnown = (window.agentTeam')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, start + 400)
    expect(body).toContain('.catch(')
  })

  it('reattach keeps the panes alive rather than killing them', () => {
    const start = appSource.indexOf('async function handleGroupReattached')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('keepPersisted: true')
    expect(body).not.toContain('onKill(')
  })
})
