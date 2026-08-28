// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { closeGitPaneMenusOnEscape, closeGitWindowMenuOnEscape } from '../gitMenuEscape'

describe('plugin-owned Git menu Escape behavior', () => {
  afterEach(() => document.body.replaceChildren())

  it('closes the active pane menu without closing a sibling', () => {
    const root = document.createElement('div')
    root.dataset.gitPaneOwner = 'pane-a'
    const sibling = document.createElement('div')
    sibling.dataset.gitPaneOwner = 'pane-b'
    document.body.append(root, sibling)
    let paneOpen = true
    let siblingOpen = true
    const listener = (event: KeyboardEvent): void => {
      closeGitPaneMenusOnEscape(event, {
        root,
        menuOwnerId: 'pane-a',
        activeMenuOwnerId: 'pane-a',
        isMenuOpen: paneOpen,
        close: () => { paneOpen = false },
      })
    }
    document.addEventListener('keydown', listener)
    sibling.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    document.removeEventListener('keydown', listener)

    expect(paneOpen).toBe(false)
    expect(siblingOpen).toBe(true)
  })

  it('closes the standalone Git window menu and consumes Escape', () => {
    let open = true
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    closeGitWindowMenuOnEscape(event, open, () => { open = false })
    expect(open).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })
})
