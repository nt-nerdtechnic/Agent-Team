// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The history modal answers for whichever workspace heading opened it, without
// switching to that project. Everything risky about that is on the WRITE side:
// spawnHistory feeds a persist watcher that files whatever it holds under the
// workspace on screen, and the three delete paths used to name that workspace
// too — so a delete run from another project's history would have hit the one
// on screen, and history has no undo.
//
// These pin the separation: a read-only buffer that never reaches the watcher,
// and every write naming historyViewWorkspace.
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

describe('the history modal has its own workspace', () => {
  it('keeps another workspace\'s entries out of spawnHistory', () => {
    // spawnHistory is watched, and the watcher persists into
    // spawnHistoryWorkspace's record. A foreign load into it would file one
    // project's entries under another.
    expect(appSource).toContain('const foreignHistory = ref<SpawnHistoryEntry[]>([])')
    const load = body('loadForeignHistory')
    expect(load).not.toContain('spawnHistory.value')
    expect(load).toContain('foreignHistory.value = hydrated')
    // Its own paging and canonical-path state, for the same reason.
    expect(load).toContain('foreignHistoryTotal.value')
    expect(load).toContain('foreignHistoryCanonical.value')
  })

  it('opens without switching workspace', () => {
    const open = body('onOpenWorkspaceHistory')
    expect(open).not.toContain('switchToWorkspace')
    expect(open).toContain('historyWorkspace.value = foreign')
    expect(open).toContain('await loadForeignHistory(foreign)')
  })

  it('names the shown workspace for every write, never currentWorkspace', () => {
    for (const fn of ['previewHistoryDelete', 'onDeleteHistoryEntry', 'onCleanupHistory']) {
      const src = body(fn)
      expect(src, fn).toContain('historyViewWorkspace.value')
      expect(src, fn).not.toContain('currentWorkspace.value')
    }
  })

  it('patches the buffer that is on screen when an entry is deleted', () => {
    const del = body('onDeleteHistoryEntry')
    expect(del).toContain('if (historyIsForeign.value) {')
    expect(del).toContain('foreignHistory.value = foreignHistory.value.filter')
    // The viewed workspace's counters describe a different store.
    expect(del.indexOf('foreignHistoryFetched.value')).toBeLessThan(del.indexOf('spawnHistory.value ='))
  })

  it('never re-hydrates the viewed workspace after cleaning another one', () => {
    // hydrateSpawnHistory moves spawnHistoryWorkspace and arms the persist
    // watcher; pointing it at another project is the whole hazard.
    const cleanup = body('onCleanupHistory')
    expect(cleanup).toContain('await loadForeignHistory(ws)')
    expect(cleanup.indexOf('await loadForeignHistory(ws)'))
      .toBeLessThan(cleanup.indexOf('await hydrateSpawnHistory(ws, [])'))
  })

  it('sends rename and star to the entry\'s own workspace, patching the shown buffer', () => {
    // The backend calls already keyed off entry.workspacePath; only the local
    // mirror pointed at spawnHistory, so a foreign rename showed nothing.
    for (const fn of ['onRenameHistoryEntry', 'onToggleStarHistoryEntry']) {
      const src = body(fn)
      expect(src, fn).toContain('entry.workspacePath || historyViewWorkspace.value')
      expect(src, fn).toContain('historyBuffer()')
    }
  })

  it('reads and pages the buffer that matches the shown workspace', () => {
    expect(appSource).toContain(':session-history="historyEntries"')
    expect(appSource).toContain(':history-has-more="historyHasMore"')
    expect(appSource).toContain(':load-more-history="loadMoreHistory"')
    expect(body('loadMoreHistory')).toContain('if (historyIsForeign.value) await loadMoreForeignHistory()')
  })

  it('drops the copy whenever the modal closes, not just on the close button', () => {
    // Esc and pane actions close it too; a kept snapshot would show stale on
    // the next open, before that open's own load lands.
    expect(appSource).toContain('watch(showHistory, (open) => {')
    expect(body('resetForeignHistory')).toContain("historyWorkspace.value = ''")
  })

  it('tells the modal whose history it is showing', () => {
    expect(appSource).toContain(':viewing-workspace="historyWorkspaceLabel"')
  })

  it('resolves an entry against its own workspace, falling back to the shown one', () => {
    // `|| currentWorkspace.value` was the last leak: an entry with no
    // workspacePath, viewed from another project's heading, searched the
    // workspace on screen for files that only exist in the shown one.
    for (const fn of [
      'resolveHistoryLogPath',
      'onResumeHistoryAgent',
      'onRenameHistoryEntry',
      'onToggleStarHistoryEntry',
    ]) {
      const src = body(fn)
      expect(src, fn).toContain('entry.workspacePath || historyViewWorkspace.value')
      expect(src, fn).not.toContain('entry.workspacePath || currentWorkspace.value')
    }
  })
})

describe('the transcript a restored pane records', () => {
  // A spawn that reattaches to a surviving PTY never reaches terminal.create,
  // so nothing opens a transcript under the pane's new id — but the path
  // derived from that id was recorded anyway, and Agent History then read a
  // file that never existed. The conversation is in the log the PTY opened
  // under its original id, which reattach now reports.
  it('prefers the path the live PTY is actually writing to', () => {
    const spawn = appSource.slice(appSource.indexOf('const effectiveLogFile'))
    expect(spawn.slice(0, 200)).toContain('ref.attachedOutputLogFile || outputLogFile')
  })

  it('records the adopted path on the pane and in the history entry', () => {
    // The pane's value is what every manual_pane.spawn call site reads, so
    // correcting it here is what reaches the project record.
    expect(appSource).toContain('if (effectiveLogFile !== outputLogFile) pane.outputLogFile = effectiveLogFile')
    expect(appSource).toContain('if (historyEntry) historyEntry.outputLogFile = effectiveLogFile')
  })
})
