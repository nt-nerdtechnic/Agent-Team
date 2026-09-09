// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Closing a workspace from the sidebar is the one workspace action a reopen
// cannot undo: it marks every pane record removed, and restore only brings
// back 'spawned' ones. The menu row says "close workspace" and nothing about
// the panes, so it asks first — the same shape as closing an idle pane.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = read('src/renderer/src/App.vue')

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

const zh = JSON.parse(read('packages/plugin-ui/src/foundation/i18n/locales/zh-TW.json'))
const en = JSON.parse(read('packages/plugin-ui/src/foundation/i18n/locales/en-US.json'))

describe('closing a workspace asks before it takes the panes', () => {
  const fn = body(appSource, 'closeWorkspace')

  it('asks before anything is torn down', () => {
    // Ordering is the guarantee: a dialog raised after switchToWorkspace or
    // onKill would be asking about a teardown already under way.
    const asked = fn.indexOf('confirm-close.sidebar-ws-title')
    expect(asked).toBeGreaterThan(-1)
    expect(asked).toBeLessThan(fn.indexOf('await switchToWorkspace('))
    expect(asked).toBeLessThan(fn.indexOf('onKill('))
  })

  it('closes nothing when the dialog is declined', () => {
    const declined = fn.indexOf('if (!ok) return')
    expect(declined).toBeGreaterThan(-1)
    expect(declined).toBeLessThan(fn.indexOf('onKill('))
  })

  it('counts the panes it is about to take down', () => {
    // The body says how many panes go with the workspace; an empty workspace
    // gets the plain wording instead of "0 CLI panes".
    expect(fn).toContain('confirm-close.sidebar-ws-body')
    expect(fn).toContain('confirm-close.sidebar-ws-body-empty')
    expect(fn).toContain("panes.value.filter((p) => normWs(p.workspacePath) === normWs(path)).length")
  })

  it('records the opt-out only on a confirmed close', () => {
    // Cancelling means "not this workspace", which says nothing about the next.
    const optOut = fn.indexOf('confirmBeforeCloseWorkspace.value = false')
    expect(optOut).toBeGreaterThan(-1)
    expect(optOut).toBeGreaterThan(fn.indexOf('if (!ok) return'))
    expect(fn).toContain('notifyRestore.dialogCheckbox.value')
  })

  it('keeps its own setting, separate from the welcome-picker confirmation', () => {
    // confirmBeforeClose guards returning to the picker, which leaves every
    // pane record intact — a user who turned that off has not agreed to skip
    // the one that removes them.
    expect(appSource).toContain(
      "const confirmBeforeCloseWorkspace = makeStickyBool('agentTeam.confirmCloseWorkspace', true)"
    )
    expect(fn).not.toContain('confirmBeforeClose.value')
  })

  it('can be turned back on from Settings once the dialog is opted out of', () => {
    // A "don't show again" with no way back is a one-way door: the next close
    // would be as silent as the one that prompted this whole guard.
    const settings = read('src/renderer/src/components/SettingsModal.vue')
    expect(settings).toContain('confirmBeforeCloseWorkspace?: boolean')
    expect(settings).toContain("(e: 'update:confirmBeforeCloseWorkspace', v: boolean): void")
    expect(settings).toContain('data-settings-section="general-confirm-close-workspace"')
    expect(appSource).toContain(
      'v-model:confirm-before-close-workspace="confirmBeforeCloseWorkspace"'
    )
    for (const keys of [zh['settings']['general'], en['settings']['general']]) {
      expect(typeof keys['confirm-close-workspace']).toBe('string')
      expect(typeof keys['confirm-close-workspace-hint']).toBe('string')
    }
  })

  it('leaves detach unguarded — it hands the panes over rather than ending them', () => {
    expect(body(appSource, 'detachWorkspace')).not.toContain('confirm-close.sidebar-ws-title')
  })

  it('ships the wording in both locales', () => {
    for (const keys of [zh['confirm-close'], en['confirm-close']]) {
      for (const k of ['sidebar-ws-title', 'sidebar-ws-body', 'sidebar-ws-body-empty', 'sidebar-ws-confirm']) {
        expect(typeof keys[k]).toBe('string')
        expect(keys[k].length).toBeGreaterThan(0)
      }
    }
    expect(zh['confirm-close']['sidebar-ws-body']).toContain('{count}')
    expect(en['confirm-close']['sidebar-ws-body']).toContain('{count}')
    expect(zh['confirm-close']['sidebar-ws-title']).toContain('{name}')
    expect(en['confirm-close']['sidebar-ws-title']).toContain('{name}')
  })
})
