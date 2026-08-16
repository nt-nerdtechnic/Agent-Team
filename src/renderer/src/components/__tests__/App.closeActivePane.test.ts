// @vitest-environment happy-dom
// ⌘W in the main window closes the focused CLI pane.
//
// The key was dead here until now: closeActiveEditor guards on `editorOpen`,
// which this window never sets, so the main window had ⌘⇧W (close the window)
// and nothing for the tier below it. Closing a pane was not even a command —
// only the ✕ button and the context menu reached onKill.
//
// Mounting App starts backend, terminal, settings and onboarding lifecycles, so
// these stay narrow source-text assertions like the other App tests. The rule
// routing is covered behaviourally in keybindings/__tests__/keyResolver.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

const closeFn = appSource.slice(
  appSource.indexOf('async function closeFocusedPane'),
  appSource.indexOf('async function onKill')
)

describe('App ⌘W closes the focused pane', () => {
  it('registers the command and routes it through closeFocusedPane', () => {
    expect(appSource).toContain("registerCommand('workbench.action.closeActivePane'")
    expect(appSource).toContain('return closeFocusedPane(paneId)')
  })

  it('declines when no pane has focus, leaving the keystroke alone', () => {
    // `false` is the dispatcher's not-handled signal: it skips preventDefault so
    // nothing downstream loses the key.
    const handler = appSource.slice(
      appSource.indexOf("registerCommand('workbench.action.closeActivePane'"),
      appSource.indexOf("registerCommand('workbench.action.openSettings'")
    )
    expect(handler).toContain('const paneId = focusPaneId.value')
    expect(handler).toContain('if (!paneId) return false')
  })

  it('asks before killing a running turn, reusing the rebuild busy check', () => {
    expect(closeFn).toContain('paneBusyForRebuild(')
    expect(closeFn).toContain("if (busy === 'running')")
    expect(closeFn).toContain('close-running-confirm-body')
    expect(closeFn).toContain('if (!ok) return')
  })

  it('closes an idle pane without a prompt, like the ✕ button', () => {
    // The confirm sits inside the `running` branch only — an idle pane falls
    // straight through to onKill. If this ever wraps the whole function,
    // closing a finished pane becomes a two-step affair.
    const beforeKill = closeFn.slice(0, closeFn.lastIndexOf('await onKill(paneId)'))
    expect(beforeKill.match(/notifyRestore\.confirm/g) ?? []).toHaveLength(1)
    expect(closeFn).toContain('await onKill(paneId)')
  })

  it('has the confirm strings in every shipped locale', () => {
    for (const locale of ['en-US', 'zh-TW']) {
      const dict = JSON.parse(
        readFileSync(resolve(process.cwd(), `src/renderer/src/i18n/locales/${locale}.json`), 'utf8')
      )
      const terminal = dict.pane.terminal
      for (const key of [
        'close-running-confirm-title',
        'close-running-confirm-body',
        'close-running-confirm-confirm',
      ]) {
        expect(terminal[key], `${locale} is missing ${key}`).toBeTruthy()
      }
    }
  })
})
