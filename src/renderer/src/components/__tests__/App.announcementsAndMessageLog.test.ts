// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. The behaviour they
// guard lives in App.vue's own wiring; the logic behind it is unit-tested in
// composables/__tests__/useMessageLogPersistence.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('dismissWhatsNew marks the shown entry read (FINDING 3)', () => {
  const body = functionBody('dismissWhatsNew')

  it('marks the entry the modal displayed, not the running app version', () => {
    // pickWhatsNew() returns the newest AUTHORED entry <= the app version, so
    // release:<app version> is frequently an id nothing in the feed carries.
    expect(body).toContain('whatsNewEntry.value?.version')
    expect(body).not.toContain('releaseAnnouncementId(current)')
  })

  it('captures the entry version before the modal is cleared', () => {
    const captured = body.indexOf('whatsNewEntry.value?.version')
    const cleared = body.indexOf('whatsNewEntry.value = null')
    expect(captured).toBeGreaterThan(-1)
    expect(cleared).toBeGreaterThan(captured)
  })

  it('still advances the What’s New watermark to the running version', () => {
    expect(body).toContain("settingsSet('agentTeam.whatsNew.lastSeenVersion', current)")
  })
})

describe('message-log persistence wiring (FINDINGS 4/5/6/8)', () => {
  it('every log write goes through the serialized mirror, none direct', () => {
    // A bare sendQuiet('agent_msg.log_clear') bypasses the flush sequencing and
    // can overtake an append batch still awaiting its response.
    expect(appSource).not.toContain("sendQuiet('agent_msg.log_")
    expect(appSource).toContain('createMessageLogPersistence(')
  })

  it('retries the hydrate on the backend connected transition', () => {
    const start = appSource.indexOf('const msgLog = createMessageLogPersistence(')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, start + 900)
    expect(block).toContain('backend.status.value')
    expect(block).toContain('msgLog.onConnected()')
  })

  it('flushes on exit through the non-awaiting path', () => {
    expect(appSource).toContain("window.addEventListener('beforeunload', msgLog.flushOnExit)")
    expect(appSource).toContain("window.removeEventListener('beforeunload', msgLog.flushOnExit)")
  })
})

describe('resource summary rows and popover lifetime', () => {
  it('blanks the vendor when it would only repeat the pane name', () => {
    // agentLabel is assigned spec.label at pane creation, so an unnamed pane's
    // name IS the vendor label — emitting both printed it twice on the default
    // path (a freshly spawned, unrenamed pane).
    const start = appSource.indexOf('const resourceRows = computed')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, appSource.indexOf('\n})', start))
    expect(block).toContain("vendor: vendor === name ? '' : vendor")
  })

  // It reports on this machine, which is what the rest of the left side is
  // about (branch, backend, update state) — and the card that opens from it is
  // anchored to the same edge.
  it('keeps the pill on the left side of the status bar', () => {
    const left = appSource.slice(
      appSource.indexOf('<div class="statusbar-left">'),
      appSource.indexOf('<div class="statusbar-right">')
    )
    expect(left).toContain('class="sb-item sb-resource sb-clickable"')
  })

  it('closes the overview when the last pane leaves', () => {
    // The trigger is v-if="panes.length > 0"; without this the popover and its
    // full-viewport backdrop outlive it and swallow every status-bar click.
    const start = appSource.indexOf('watch(\n  () => panes.value.length,')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, appSource.indexOf('\n)', start))
    expect(block).toContain("openPopover.value === 'resource'")
    expect(block).toContain('closePopover()')
  })
})
