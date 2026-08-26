// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import ArchivePreview from '../ArchivePreview.vue'
import { i18n } from '@navide/ui-foundation'

i18n.global.locale.value = 'en-US'

async function mountArchive(payload: unknown, relPath = 'bundle/archive.zip') {
  const send = vi.fn(async () => ({ payload }))
  const wrapper = mount(ArchivePreview, {
    props: {
      workspacePath: '/ws',
      relPath,
      name: relPath.split('/').pop()!,
      backend: { httpUrl: ref('http://127.0.0.1:8123'), send } as never,
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return { wrapper, send }
}

describe('ArchivePreview', () => {
  it('calls fs.list_archive and renders the entry table', async () => {
    const { wrapper, send } = await mountArchive({
      ok: true,
      entries: [
        { name: 'src/', size: 0, is_dir: true },
        { name: 'src/main.ts', size: 2048, is_dir: false },
      ],
      total_entries: 2,
      truncated: false,
    })
    expect(send).toHaveBeenCalledWith('fs.list_archive', {
      workspace_path: '/ws',
      rel_path: 'bundle/archive.zip',
    })
    const rows = wrapper.findAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('📁')
    expect(rows[0].text()).toContain('src/')
    expect(rows[0].findAll('td')[1].text()).toBe('')
    expect(rows[1].text()).toContain('📄')
    expect(rows[1].findAll('td')[1].text()).toBe('2.0 KB')
    expect(wrapper.text()).toContain('2 entries')
    expect(wrapper.text()).not.toContain('entry list truncated')
  })

  it('shows the truncation notice with the full entry count', async () => {
    const { wrapper } = await mountArchive({
      ok: true,
      entries: [{ name: 'a.txt', size: 1, is_dir: false }],
      total_entries: 5000,
      truncated: true,
    })
    expect(wrapper.text()).toContain('5000 entries')
    expect(wrapper.text()).toContain('entry list truncated')
  })

  it('shows an error card when the handler reports a failure', async () => {
    const { wrapper } = await mountArchive({ ok: false, error: 'archive too large' })
    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.find('.arcp-card-name').text()).toBe('archive.zip')
    expect(wrapper.find('.arcp-card-error').text()).toContain('Failed to read the archive.')
    expect(wrapper.find('.arcp-card-error').text()).toContain('archive too large')
  })

  it('shows an error card when the request itself rejects', async () => {
    const send = vi.fn(async () => {
      throw new Error('backend offline')
    })
    const wrapper = mount(ArchivePreview, {
      props: {
        workspacePath: '/ws',
        relPath: 'x.tgz',
        name: 'x.tgz',
        backend: { httpUrl: ref('http://127.0.0.1:8123'), send } as never,
      },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.find('.arcp-card-error').text()).toContain('backend offline')
  })
})
