// The preview store is a module singleton shared by the rail, the Explorer
// context menu and the ui.preview.show command. What these tests pin is that
// every push reaches the user (focusRequest is a counter, not a flag) and that
// a project switch cannot leave a foreign path on screen.
import { describe, it, expect, beforeEach } from 'vitest'
import { usePreview } from '../usePreview'
import type { PreviewTarget } from '../previewTarget'

const file = (rel: string, ws = '/ws'): PreviewTarget => ({
  kind: 'file',
  workspacePath: ws,
  relPath: rel,
})

describe('usePreview', () => {
  beforeEach(() => {
    usePreview().reset()
  })

  it('starts empty', () => {
    const p = usePreview()
    expect(p.current.value).toBeNull()
  })

  it('show() sets the target and requests focus', () => {
    const p = usePreview()
    const before = p.focusRequest.value
    p.show(file('a.ts'))
    expect(p.current.value).toMatchObject({ relPath: 'a.ts' })
    expect(p.focusRequest.value).toBe(before + 1)
  })

  it('focus() requests focus without changing the target', () => {
    const p = usePreview()
    p.show(file('a.ts'))
    const before = p.focusRequest.value
    p.focus()
    expect(p.focusRequest.value).toBe(before + 1)
    expect(p.current.value).toMatchObject({ relPath: 'a.ts' })
  })

  it('re-showing the same target still surfaces the panel', () => {
    // Two identical pushes must both reach the user; a boolean flag would
    // swallow the second.
    const p = usePreview()
    p.show(file('a.ts'))
    const after = p.focusRequest.value
    p.show(file('a.ts'))
    expect(p.focusRequest.value).toBe(after + 1)
  })

  it('clear() drops the current target', () => {
    const p = usePreview()
    p.show(file('a.ts'))
    p.clear()
    expect(p.current.value).toBeNull()
  })

  it('clearWorkspace() drops a target belonging to that workspace', () => {
    // Switching project must not leave a path from the old workspace pointing
    // into the new one.
    const p = usePreview()
    p.show(file('drop.ts', '/ws'))
    p.clearWorkspace('/ws')
    expect(p.current.value).toBeNull()
  })

  it('clearWorkspace() leaves another workspace alone', () => {
    const p = usePreview()
    p.show(file('keep.ts', '/other'))
    p.clearWorkspace('/ws')
    expect(p.current.value).toMatchObject({ workspacePath: '/other' })
  })

  it('clearWorkspace() leaves inline targets alone', () => {
    // A snippet has no workspace; it must survive a project switch rather than
    // vanishing for a reason the user cannot see.
    const p = usePreview()
    p.show({ kind: 'snippet', content: 'x' })
    p.clearWorkspace('/ws')
    expect(p.current.value).toMatchObject({ kind: 'snippet' })
  })
})
