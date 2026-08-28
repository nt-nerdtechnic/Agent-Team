// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ReconnectSessionModal, { type OrphanSession } from '../ReconnectSessionModal.vue'
import { i18n } from '@navide/plugin-ui/foundation'

beforeEach(() => {
  ;(i18n.global.locale as unknown as { value: string }).value = 'en-US'
})

const orphans: OrphanSession[] = [
  {
    session_id: 'sess-a',
    name: 'Backend',
    preview: ['fix the login bug', 'add a test'],
    size_bytes: 2048,
    mtime: 1_700_000_000,
    resumable: true,
  },
  {
    session_id: 'sess-b',
    name: '',
    preview: ['refactor the parser'],
    size_bytes: 512,
    mtime: 1_700_000_500,
    resumable: false,
  },
]

// The modal teleports to <body>; query the document rather than the wrapper.
function rows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('.reconnect-row'))
}

describe('ReconnectSessionModal', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
  })

  it('renders a row per orphan with name, preview, and resumable badge', () => {
    wrapper = mount(ReconnectSessionModal, {
      props: { show: true, orphans, loading: false },
      global: { plugins: [i18n] },
    })
    const rendered = rows()
    expect(rendered).toHaveLength(2)
    expect(rendered[0].textContent).toContain('Backend')
    expect(rendered[0].textContent).toContain('fix the login bug')
    // Unnamed orphan falls back to the placeholder label.
    expect(rendered[1].textContent).toContain('(unnamed)')
    // Badge reflects resumability per row.
    expect(document.body.querySelector('.reconnect-badge.ok')).not.toBeNull()
    expect(document.body.querySelector('.reconnect-badge.stale')).not.toBeNull()
  })

  it('emits select with the chosen session id after confirming', async () => {
    wrapper = mount(ReconnectSessionModal, {
      props: { show: true, orphans, loading: false },
      global: { plugins: [i18n] },
    })
    // Confirm is disabled until a row is selected.
    const confirmBtn = document.body.querySelector('.reconnect-btn.primary') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)

    rows()[0].click()
    await flushPromises()
    expect((document.body.querySelector('.reconnect-btn.primary') as HTMLButtonElement).disabled).toBe(false)

    ;(document.body.querySelector('.reconnect-btn.primary') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.emitted('select')).toEqual([['sess-a']])
  })

  it('does not select a non-resumable row — it is disabled, confirm stays off, no select emitted', async () => {
    wrapper = mount(ReconnectSessionModal, {
      props: { show: true, orphans, loading: false },
      global: { plugins: [i18n] },
    })
    // sess-b is resumable: false — its row must be disabled and unselectable.
    expect((rows()[1] as HTMLButtonElement).disabled).toBe(true)
    rows()[1].click()
    await flushPromises()
    const confirmBtn = document.body.querySelector('.reconnect-btn.primary') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
    confirmBtn.click()
    await flushPromises()
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('shows the empty state when there are no orphans', () => {
    wrapper = mount(ReconnectSessionModal, {
      props: { show: true, orphans: [], loading: false },
      global: { plugins: [i18n] },
    })
    expect(rows()).toHaveLength(0)
    expect(document.body.querySelector('.reconnect-empty')?.textContent).toContain('No orphan conversations')
  })
})
