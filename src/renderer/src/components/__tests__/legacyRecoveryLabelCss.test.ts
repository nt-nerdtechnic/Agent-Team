// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The "Legacy recovery" badge sits in `.part-top` next to the panel it labels.
// `.part-top` is a column flex container with a blanket rule written for
// ExplorerPane — `.pane-split .part-top > * { flex: 1 }` — which outranks the
// badge's own `flex: none` on specificity. When that happened the 17px badge
// was stretched down the whole column, and since it is `border-radius: 999px`
// it rendered as a giant empty pill while the panel below it lost half its
// height (its native view was then drawn halfway down the sidebar).
//
// 3b359090 added `flex: none` to the badge trying to prevent exactly this and
// it never took effect, so this is pinned as source: scoped <style> is stripped
// before mounting, and the markup is identical either way.

const CONTROL_PANE = resolve(process.cwd(), 'src/renderer/src/components/ControlPane.vue')

describe('legacy recovery label layout', () => {
  const css = readFileSync(CONTROL_PANE, 'utf8')

  it('keeps the badge out of the .part-top stretch rule', () => {
    const rule = css.match(/\.pane-split \.part-top > \*([^{]*)\{[^}]*flex: 1/)
    expect(rule, 'the .part-top blanket stretch rule should still exist').not.toBeNull()
    expect(rule![1]).toContain(':not(.legacy-recovery-label)')
  })

  it('still declares flex: none on the badge itself', () => {
    const block = css.match(/\.legacy-recovery-label \{[^}]*\}/)
    expect(block, '.legacy-recovery-label should be styled').not.toBeNull()
    expect(block![0]).toContain('flex: none')
  })
})
