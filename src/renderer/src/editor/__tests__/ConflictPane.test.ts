// @vitest-environment happy-dom
// ConflictPane — the hand-rolled three-way merge view shared by the mini-IDE
// and the Git window. These tests cover the merge-stage side channel added on
// top of the marker parsing: the common-ancestor ("Base") toggle and the
// binary-conflict bail-out. The transport and file access are plain stubs,
// which keeps the test at the pane's named-port seam.
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import ConflictPane from '../ConflictPane.vue'
import { i18n } from '../../i18n'

i18n.global.locale.value = 'en-US'

const MERGE_STYLE = [
  'top',
  '<<<<<<< HEAD',
  'ours line',
  '=======',
  'theirs line',
  '>>>>>>> feature',
  'bottom',
  '',
].join('\n')

const DIFF3_STYLE = [
  'top',
  '<<<<<<< HEAD',
  'ours line',
  '||||||| merged common ancestors',
  'base line',
  '=======',
  'theirs line',
  '>>>>>>> feature',
  '',
].join('\n')

interface StageStub {
  ok?: boolean
  base?: string
  has_base?: boolean
  binary?: boolean
}

function makeBackend(content: string, stages: StageStub | null) {
  const sent: { type: string; payload: Record<string, unknown> }[] = []
  const send = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    sent.push({ type, payload })
    if (type === 'git.conflict_stages') {
      return {
        ok: true,
        payload: stages === null
          ? null
          : {
              ok: stages.ok ?? true,
              base: stages.base ?? '',
              ours: '',
              theirs: '',
              has_base: stages.has_base ?? false,
              has_ours: true,
              has_theirs: true,
              binary: stages.binary ?? false,
            },
      }
    }
    return { ok: true, payload: { ok: true } }
  })
  const fileAccess = {
    readFile: vi.fn(async (workspacePath: string, relPath: string) => {
      sent.push({ type: 'fs.read_file', payload: { workspace_path: workspacePath, rel_path: relPath } })
      return { ok: true, content }
    }),
    writeFile: vi.fn(async (workspacePath: string, relPath: string, nextContent: string) => {
      sent.push({ type: 'fs.write_file', payload: { workspace_path: workspacePath, rel_path: relPath, content: nextContent } })
      return { ok: true }
    }),
    readImage: vi.fn(async () => ''),
  }
  return {
    gitTransport: { status: ref('connected'), send, on: vi.fn(() => () => {}) },
    fileAccess,
    sent,
  }
}

async function mountPane(content: string, stages: StageStub | null): Promise<{
  wrapper: VueWrapper
  sent: { type: string; payload: Record<string, unknown> }[]
}> {
  const { gitTransport, fileAccess, sent } = makeBackend(content, stages)
  const wrapper = mount(ConflictPane, {
    props: {
      workspacePath: '/ws',
      filepath: 'src/a.ts',
      name: 'a.ts',
      gitTransport: gitTransport as never,
      fileAccess,
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return { wrapper, sent }
}

function baseToggle(wrapper: VueWrapper): ReturnType<VueWrapper['find']> {
  return wrapper.find('.cp-base-toggle')
}

describe('ConflictPane — merge stages', () => {
  it('asks the backend for the three merge stages of the file it opens', async () => {
    const { sent } = await mountPane(MERGE_STYLE, { has_base: true, base: 'base file\n' })
    const call = sent.find((s) => s.type === 'git.conflict_stages')
    expect(call).toBeDefined()
    expect(call!.payload).toEqual({ workspace_path: '/ws', filepath: 'src/a.ts' })
  })

  it('offers the Base toggle only when the index carries a stage-1 blob', async () => {
    const withBase = await mountPane(MERGE_STYLE, { has_base: true, base: 'base file\n' })
    expect(baseToggle(withBase.wrapper).exists()).toBe(true)

    // add/add: no common ancestor exists, so there is nothing to toggle.
    const addAdd = await mountPane(MERGE_STYLE, { has_base: false })
    expect(baseToggle(addAdd.wrapper).exists()).toBe(false)

    // The stage read failing costs the base view and nothing else.
    const failed = await mountPane(MERGE_STYLE, { ok: false, has_base: true })
    expect(baseToggle(failed.wrapper).exists()).toBe(false)

    const noResponse = await mountPane(MERGE_STYLE, null)
    expect(baseToggle(noResponse.wrapper).exists()).toBe(false)
  })

  it('reveals the common ancestor only after the toggle is pressed', async () => {
    const { wrapper } = await mountPane(MERGE_STYLE, { has_base: true, base: 'base file\n' })
    expect(wrapper.find('.cp-base-panel').exists()).toBe(false)

    await baseToggle(wrapper).trigger('click')
    const panel = wrapper.find('.cp-base-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('Common ancestor')
    expect(panel.find('.cp-base-text').text()).toContain('base file')

    await baseToggle(wrapper).trigger('click')
    expect(wrapper.find('.cp-base-panel').exists()).toBe(false)
  })

  it('adds the per-block base column and "Accept Base" for diff3 blocks', async () => {
    const { wrapper } = await mountPane(DIFF3_STYLE, { has_base: true, base: 'base line\n' })
    // Nothing changes until the toggle is on.
    expect(wrapper.find('.cp-side.base-side').exists()).toBe(false)
    expect(wrapper.findAll('.cp-btn').map((b) => b.text())).not.toContain('Accept Base')

    await baseToggle(wrapper).trigger('click')
    expect(wrapper.find('.cp-sbs').classes()).toContain('with-base')
    expect(wrapper.find('.cp-side.base-side').text()).toContain('base line')

    const acceptBase = wrapper.findAll('.cp-btn').find((b) => b.text() === 'Accept Base')
    expect(acceptBase).toBeDefined()
    await acceptBase!.trigger('click')
    expect(wrapper.find('.cp-preview-label').text()).toContain('Accepted Base')
  })

  it('keeps the base column off for merge-style blocks that carry no |||||||', async () => {
    const { wrapper } = await mountPane(MERGE_STYLE, { has_base: true, base: 'base file\n' })
    await baseToggle(wrapper).trigger('click')
    // The whole-file ancestor is shown, but there is no per-block base to align.
    expect(wrapper.find('.cp-base-panel').exists()).toBe(true)
    expect(wrapper.find('.cp-side.base-side').exists()).toBe(false)
    expect(wrapper.findAll('.cp-btn').map((b) => b.text())).not.toContain('Accept Base')
  })

  it('writes the base side when "Accept Base" is applied', async () => {
    const { gitTransport, fileAccess, sent } = makeBackend(DIFF3_STYLE, { has_base: true, base: 'base line\n' })
    const wrapper = mount(ConflictPane, {
      props: { workspacePath: '/ws', filepath: 'src/a.ts', name: 'a.ts', gitTransport: gitTransport as never, fileAccess },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    await wrapper.find('.cp-base-toggle').trigger('click')
    await wrapper.findAll('.cp-btn').find((b) => b.text() === 'Accept Base')!.trigger('click')
    await wrapper.find('.cp-apply').trigger('click')
    await flushPromises()

    const write = sent.find((s) => s.type === 'fs.write_file')
    expect(write).toBeDefined()
    expect(write!.payload.content).toBe('top\nbase line\n')
    expect(sent.find((s) => s.type === 'git.stage')!.payload.files).toEqual(['src/a.ts'])
  })

  it('bails out of the text merge on a binary conflict', async () => {
    // The backend returns empty stages plus the flag for these.
    const { wrapper } = await mountPane(MERGE_STYLE, { binary: true, has_base: true })
    expect(wrapper.text()).toContain('Binary conflict')
    expect(wrapper.find('.cp-conflict').exists()).toBe(false)
    expect(wrapper.find('.cp-base-toggle').exists()).toBe(false)
    expect((wrapper.find('.cp-apply').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables the panel when the parent reports the merge is gone', async () => {
    const { gitTransport, fileAccess } = makeBackend(MERGE_STYLE, { has_base: true, base: 'base\n' })
    const wrapper = mount(ConflictPane, {
      props: {
        workspacePath: '/ws',
        filepath: 'src/a.ts',
        name: 'a.ts',
        gitTransport: gitTransport as never,
        fileAccess,
        mergeAborted: true,
      },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Merge aborted')
    expect(wrapper.find('.cp-conflict').exists()).toBe(false)
    expect((wrapper.find('.cp-apply').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('leaves the two-column merge untouched when there are no stages to show', async () => {
    const { wrapper } = await mountPane(MERGE_STYLE, { has_base: false })
    expect(wrapper.find('.cp-sbs').classes()).not.toContain('with-base')
    expect(wrapper.findAll('.cp-side').length).toBe(2)
    expect(wrapper.findAll('.cp-btn').map((b) => b.text()))
      .toEqual(['Accept Ours', 'Accept Theirs', 'Accept Both', 'Edit'])
  })
})
