// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { closeGitPaneMenusOnEscape } from '../../lib/gitMenuEscape'

describe('GitPane context-menu Escape handling', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('closes the menu owned by the focused pane', () => {
    const root = document.createElement('div')
    root.dataset.gitPaneOwner = 'pane-a'
    const menu = document.createElement('div')
    menu.dataset.gitPaneMenuOwner = 'pane-a'
    document.body.append(root, menu)
    let open = true
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    const listener = (current: KeyboardEvent): void => {
      closeGitPaneMenusOnEscape(current, {
        root,
        menuOwnerId: 'pane-a',
        activeMenuOwnerId: 'pane-a',
        isMenuOpen: open,
        close: () => { open = false },
      })
    }
    document.addEventListener('keydown', listener)
    menu.dispatchEvent(event)
    document.removeEventListener('keydown', listener)

    expect(open).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not close a sibling pane menu', () => {
    const root = document.createElement('div')
    root.dataset.gitPaneOwner = 'pane-a'
    const sibling = document.createElement('div')
    sibling.dataset.gitPaneOwner = 'pane-b'
    document.body.append(root, sibling)
    let siblingOpen = true
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    const listener = (current: KeyboardEvent): void => {
      closeGitPaneMenusOnEscape(current, {
        root,
        menuOwnerId: 'pane-a',
        activeMenuOwnerId: 'pane-a',
        isMenuOpen: true,
        close: () => { siblingOpen = false },
      })
    }
    document.addEventListener('keydown', listener)
    sibling.dispatchEvent(event)
    document.removeEventListener('keydown', listener)

    expect(siblingOpen).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })
})
