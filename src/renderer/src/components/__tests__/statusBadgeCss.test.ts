// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DisplayStatus } from '@navide/terminal'

// Every surface that paints a pane status does it with a `[data-status='x']` /
// `[data-state='x']` CSS rule, and a status with no rule silently falls back to
// the neutral default. That is not a hypothetical: the agent overview had no
// rule for idle, awaiting or stopped, so all three rendered the same grey dot —
// "finished" and "waiting on you" were indistinguishable. Component tests do
// not catch it because scoped <style> is stripped before mounting and the
// markup is identical either way, so the rules are checked as source here.
//
// Deliberately NOT asserting colours: this pins that a status is styled at all,
// not what it looks like.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

/** Statuses a surface must style, and the ones it legitimately need not. */
const ALL: readonly DisplayStatus[] = [
  'idle',
  'starting',
  'running',
  'exited',
  'error',
  'stopped',
  'awaiting',
]

interface Surface {
  name: string
  file: string
  /** How that file writes the selector for a status. */
  selector: (status: string) => string
  /** Statuses this surface is allowed to leave to the default, with a reason. */
  exempt?: Partial<Record<DisplayStatus, string>>
}

const SURFACES: Surface[] = [
  {
    name: 'TerminalPane status pill',
    file: 'src/renderer/src/components/TerminalPane.vue',
    selector: (s) => `.status[data-status='${s}']`,
  },
  {
    name: 'ControlPane sidebar dot',
    file: 'src/renderer/src/components/ControlPane.vue',
    selector: (s) => `.status-dot[data-state='${s}']`,
    exempt: {
      // The base .status-dot is already the idle/quiet look; running, idle and
      // stopped are painted by the shared rule rather than their own.
      idle: 'painted by the base .status-dot rule',
      running: 'painted by the base .status-dot rule',
      stopped: 'painted by the base .status-dot rule',
      starting: 'painted by the base .status-dot rule',
    },
  },
  {
    name: 'ControlPane expanded-row badge',
    file: 'src/renderer/src/components/ControlPane.vue',
    selector: (s) => `.state[data-state='${s}']`,
  },
  {
    name: 'App meeting badge',
    file: 'src/renderer/src/App.vue',
    selector: (s) => `.meeting-badge[data-status="${s}"]`,
  },
  {
    name: 'App spotlight thumbnail badge',
    file: 'src/renderer/src/App.vue',
    selector: (s) => `.spotlight-thumb-badge[data-status="${s}"]`,
  },
  {
    name: 'ResourceSummaryPanel row',
    file: 'src/renderer/src/components/ResourceSummaryPanel.vue',
    selector: (s) => `.rs-row[data-status='${s}']`,
  },
]

describe('every pane status is styled on every surface that paints one', () => {
  for (const surface of SURFACES) {
    const source = read(surface.file)
    for (const status of ALL) {
      const exemption = surface.exempt?.[status]
      const label = exemption
        ? `${surface.name}: ${status} is exempt (${exemption})`
        : `${surface.name}: ${status} has its own rule`
      it(label, () => {
        if (exemption) return
        expect(source).toContain(surface.selector(status))
      })
    }
  }

  it('gives "waiting on the user" a colour of its own, not idle\'s', () => {
    // The state that means "nothing moves until you act" must not look like the
    // one that means "done". Both kinds of wait share this hue on purpose —
    // they are one badge now — so there is a single rule to check.
    const pane = read('src/renderer/src/components/TerminalPane.vue')
    const awaiting = pane.slice(pane.indexOf(".status[data-status='awaiting']"))
    expect(awaiting.slice(0, 200)).toContain('--warning-fg')
    expect(awaiting.slice(0, 200)).not.toContain('--attention-fg')
  })

  it('leaves no rule selecting the retired question status', () => {
    // Merged into 'awaiting'. A leftover selector is dead weight that reads as
    // a live state to the next person, and --question-fg went with it.
    for (const surface of SURFACES) {
      const css = read(surface.file)
      expect(css, `${surface.name} still selects question`).not.toContain(
        surface.selector('question')
      )
    }
    expect(read('packages/plugin-ui/src/foundation/styles/tokens/semantic.css')).not.toContain('--question-fg')
  })
})
