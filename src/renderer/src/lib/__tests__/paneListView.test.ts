import { describe, expect, it } from 'vitest'
import { ancestorTrail } from '../paneListView'

// The source line the pane lists show instead of indentation.

describe('ancestorTrail', () => {
  const names: Record<string, string> = { r1: '官方網站', c1: 'SEO 稽核', c1x: '產出報表' }
  const nameOf = (id: string) => names[id] ?? ''

  it('is empty for a root', () => {
    expect(ancestorTrail([], nameOf)).toBe('')
  })

  it('names the parent of a second-level pane', () => {
    expect(ancestorTrail(['r1'], nameOf)).toBe('官方網站')
  })

  it('spells out the whole chain when it is short enough', () => {
    expect(ancestorTrail(['r1', 'c1'], nameOf)).toBe('官方網站 › SEO 稽核')
  })

  it('truncates from the left, keeping the nearest parent', () => {
    // The nearest parent is the useful half: it says who opened this pane.
    // The root is the half that is already obvious from context.
    const deep = ['r1', 'c1', 'c1x']
    expect(ancestorTrail(deep, nameOf)).toBe('… › SEO 稽核 › 產出報表')
  })

  it('skips an ancestor whose name has not arrived yet', () => {
    // Rows and pane views are separate reactive writes; a frame can see one
    // before the other. A gap in the trail beats rendering "undefined".
    expect(ancestorTrail(['ghost', 'r1'], nameOf)).toBe('官方網站')
  })

  it('is empty when no ancestor has a name yet', () => {
    expect(ancestorTrail(['ghost'], nameOf)).toBe('')
  })
})
