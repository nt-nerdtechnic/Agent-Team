import { describe, expect, it } from 'vitest'
import { isAppWindowSender } from './ipcSender'

const top = (type = 'window') => ({ sender: { getType: () => type }, senderFrame: { parent: null } })

describe('isAppWindowSender', () => {
  it('admits the top frame of a BrowserWindow', () => {
    expect(isAppWindowSender(top())).toBe(true)
  })
  it('refuses a webview guest, whatever frame it is', () => {
    expect(isAppWindowSender(top('webview'))).toBe(false)
  })
  it('refuses a sub-frame of a window (an iframe a preview loaded)', () => {
    expect(isAppWindowSender({ sender: { getType: () => 'window' }, senderFrame: { parent: {} } })).toBe(false)
  })
  it('refuses when there is no frame information or the sender is gone', () => {
    expect(isAppWindowSender({ sender: { getType: () => 'window' }, senderFrame: null })).toBe(false)
    expect(isAppWindowSender({ sender: { getType: () => 'window', isDestroyed: () => true }, senderFrame: { parent: null } })).toBe(false)
    expect(isAppWindowSender({ sender: {} as { getType?: () => string } })).toBe(false)
  })
})
