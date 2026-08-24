// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so it is not
// practical to mount here (see App.logPreview.test.ts). The reclaim DECISION
// lives in lib/idleReclaim.ts and is unit-tested there; what this file guards
// is the wiring, where the damaging mistakes are: reclaiming that closes the
// pane for real, or that leaves it unable to come back.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const reclaimFn = () =>
  block('async function reclaimIdlePane(', 'let _idleReclaimTimer')

describe('idle reclaim wiring', () => {
  // markRemoved unspawns the backend record. A reclaim that did that would
  // survive as a real close on the next restart — the conversation would not
  // come back, which is the opposite of the deal this feature offers.
  it('keeps the backend pane record so the placeholder can resume from it', () => {
    expect(reclaimFn()).toContain('markRemoved: false')
  })

  // Without keepInList the pane is spliced out of the list and its seat, name
  // and group are gone.
  it('keeps the pane in the list, in its seat', () => {
    expect(reclaimFn()).toContain('keepInList: true')
  })

  // force kills with SIGKILL. The resume depends on the transcript the CLI is
  // still writing, so the reclaim asks it to stop rather than shooting it.
  it('ends the CLI gracefully rather than force-killing it', () => {
    expect(reclaimFn()).toContain('force: false')
  })

  // realized=false alone leaves a pane that renders as a placeholder but has no
  // metadata to realize — a dead seat the user cannot click back to life.
  it('turns the pane back into a placeholder WITH its restore metadata', () => {
    const fn = reclaimFn()
    expect(fn).toContain('realized = false')
    expect(fn).toContain('deferredRestore = {')
    expect(fn).toContain('saved,')
  })

  // Spawn history marks a removal unconditionally inside onKill, and a reclaim
  // is not a removal — the pane keeps its seat and its resume id.
  it('does not record the pane as removed in spawn history', () => {
    const fn = reclaimFn()
    expect(fn).toContain('const alreadyRemoved = !!histEntry?.removedAt')
    expect(fn).toContain('if (histEntry && !alreadyRemoved) histEntry.removedAt = undefined')
  })

  it('sweeps on a timer and clears it on unmount', () => {
    expect(appSource).toContain('window.setInterval(() => { void sweepIdlePanes() }, IDLE_RECLAIM_SWEEP_MS)')
    expect(appSource).toContain('if (_idleReclaimTimer !== null) clearInterval(_idleReclaimTimer)')
  })

  // The sweep awaits a kill between candidates, so the user can focus or type
  // into the next pane while it runs — its snapshot goes stale mid-loop.
  it('re-checks each pane immediately before reclaiming it', () => {
    const sweep = block('async function sweepIdlePanes(', 'onMounted(() => {')
    expect(sweep).toContain('if (!pane || !paneReclaimable(pane, Date.now())) continue')
  })

  it('does nothing at all while the setting is off', () => {
    const sweep = block('async function sweepIdlePanes(', 'onMounted(() => {')
    expect(sweep).toContain('if (!idleReclaimEnabled.value) return')
  })

  // A manual reclaim must not become a way around the guards — the only thing
  // pressing the button skips is the waiting.
  it('runs manual reclaim through the same guards, minus the age check', () => {
    const fn = block('async function reclaimPanesNow(', 'onMounted(() => {')
    expect(fn).toContain('reclaimBlockedBy(reclaimCandidate(pane), RECLAIM_NOW_THRESHOLD_MS, Date.now()) !== null) continue')
  })

  it('offers the same candidate list to every reclaim-now control', () => {
    expect(appSource).toContain('const reclaimableNowIds = computed<string[]>')
    expect(appSource).toContain(':reclaimable-now-count="reclaimableNowIds.length"')
  })

  // The measurement shells out to footprint, whose cost scales with the pane
  // count — on a timer it would be a tax paid forever for a panel nobody has
  // open.
  it('measures memory only when the panel is opened', () => {
    const fn = block('function toggleMemoryPanel(', 'async function onMemoryReclaim(')
    expect(fn).toContain("const opening = openPopover.value !== 'memory'")
    expect(fn).toContain('if (opening) void refreshMemoryUsage()')
    expect(appSource).not.toContain('setInterval(() => { void refreshMemoryUsage() }')
  })

  // A pane rebuilt around a new PTY gets a new pane id, and the backend still
  // reports the session it created the PTY under. The session id is the key
  // this window holds itself, so it cannot drift the same way.
  it('keys measurements by terminal session id, with pane id as the fallback', () => {
    const fn = block('const memoryRows = computed<MemoryPaneRow[]>', 'async function refreshMemoryUsage(')
    expect(fn).toContain('memoryBytesBySession.value.get(')
    expect(fn).toContain('?? memoryBytesByPane.value.get(p.id) ?? 0')
  })

  // Showing an unmeasured pane as 0 bytes reads as "this one is free", which is
  // the opposite of what a failed sweep means.
  it('marks memory unavailable rather than zero when the backend cannot answer', () => {
    const fn = block('async function refreshMemoryUsage(', 'function toggleMemoryPanel(')
    expect(fn).toContain('memoryAvailable.value = false')
  })

  // The timed sweep is housekeeping the user did not ask for, so it logs rather
  // than interrupting with a toast. A reclaim the user pressed for still says so.
  it('logs the timed sweep without a toast, and reports an explicit reclaim', () => {
    const sweep = block('async function sweepIdlePanes(', '/** Panes the user could reclaim')
    expect(sweep).toContain('pipelineLog(')
    expect(sweep).not.toContain('notifyRestore.toast(')
    const onRequest = block('async function reclaimPanesNow(', 'onMounted(() => {')
    expect(onRequest).toContain('pane.terminal.idle-reclaimed')
  })
})
