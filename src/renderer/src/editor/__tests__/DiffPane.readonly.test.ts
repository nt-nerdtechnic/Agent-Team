// @vitest-environment happy-dom
// DiffPane gained a `readonly` prop so the right-rail preview panel can reuse
// it without exposing stage / unstage / discard. Hiding those with CSS would
// not be enough — the guard has to hold at the apply() call too, since the
// panel is described to the user as read-only.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import DiffPane from '../DiffPane.vue'

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' const c = 4',
  '',
].join('\n')

function makeBackend() {
  const send = vi.fn(async (channel: string) => {
    if (channel === 'git.diff_file') return { ok: true, payload: { ok: true, diff: DIFF } }
    return { ok: true, payload: { ok: true } }
  })
  // DiffPane loads only once the backend reports connected.
  return { send, httpUrl: ref('http://127.0.0.1:1234'), status: ref('connected') }
}

function mountDiff(props: Record<string, unknown>) {
  const backend = makeBackend()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = mount(DiffPane as any, {
    props: {
      workspacePath: '/ws',
      filepath: 'a.ts',
      staged: false,
      name: 'a.ts',
      gitTransport: {
        status: backend.status,
        send: backend.send,
        on: () => () => {},
      },
      fileAccess: {
        readFile: async () => ({ ok: true, content: '' }),
        writeFile: async () => ({ ok: true }),
        readImage: async () => '',
      },
      ...props,
    },
    global: { mocks: { $t: (key: string) => key } },
  })
  return { w, backend }
}

async function settle(w: { vm: { $nextTick: () => Promise<void> } }) {
  await w.vm.$nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await w.vm.$nextTick()
}

describe('DiffPane readonly', () => {
  it('renders hunk actions for a normal working-tree diff', async () => {
    const { w } = mountDiff({})
    await settle(w)
    // Guard the guard: if this stops finding actions the readonly assertion
    // below would pass for the wrong reason.
    expect(w.find('.dp-actions').exists()).toBe(true)
    w.unmount()
  })

  it('hides every write action when readonly', async () => {
    const { w } = mountDiff({ readonly: true })
    await settle(w)
    expect(w.find('.dp-actions').exists()).toBe(false)
    expect(w.find('.dp-check').exists()).toBe(false)
    w.unmount()
  })

  it('still renders the diff body when readonly', async () => {
    // Read-only must mean "no writes", not "no content".
    const { w } = mountDiff({ readonly: true })
    await settle(w)
    expect(w.find('.dp-hunk').exists()).toBe(true)
    w.unmount()
  })

  it('never calls git.apply_patch while readonly', async () => {
    const { w, backend } = mountDiff({ readonly: true })
    await settle(w)
    // Reach past the UI: even if a caller found a way to invoke it, the guard
    // inside apply() must refuse.
    const vm = w.vm as unknown as { stageHunk?: (h: unknown) => void }
    vm.stageHunk?.({ header: '@@ -1,3 +1,3 @@', lines: [] })
    await settle(w)
    const applied = backend.send.mock.calls.filter((c) => c[0] === 'git.apply_patch')
    expect(applied).toHaveLength(0)
    w.unmount()
  })
})
