// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { closeGitWindowMenuOnEscape } from '../lib/gitMenuEscape'

describe('GitWindowApp context-menu Escape handling', () => {
  it('closes an open menu and consumes Escape', () => {
    let open = true
    const listener = (event: KeyboardEvent): void => {
      closeGitWindowMenuOnEscape(event, open, () => { open = false })
    }
    document.addEventListener('keydown', listener)

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(event)

    document.removeEventListener('keydown', listener)
    expect(open).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a closed menu alone for unrelated keys', () => {
    let closeCalls = 0
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })

    closeGitWindowMenuOnEscape(event, false, () => { closeCalls++ })

    expect(closeCalls).toBe(0)
    expect(event.defaultPrevented).toBe(false)
  })
})
