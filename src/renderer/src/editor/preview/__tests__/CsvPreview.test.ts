// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import CsvPreview from '../CsvPreview.vue'
import { i18n } from '@navide/ui-foundation'

i18n.global.locale.value = 'en-US'

function makeBackend(resp: unknown) {
  return {
    httpUrl: ref('http://127.0.0.1:8123'),
    status: ref('connected'),
    send: vi.fn(async () => ({ payload: resp })),
  }
}

async function mountCsv(content: string | null, relPath = 'data/table.csv') {
  const backend = makeBackend(
    content === null ? { ok: false, error: 'no such file' } : { ok: true, content },
  )
  const wrapper = mount(CsvPreview, {
    props: { workspacePath: '/ws', relPath, backend: backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return { wrapper, backend }
}

function cellTexts(wrapper: Awaited<ReturnType<typeof mountCsv>>['wrapper'], col: number) {
  return wrapper.findAll('tbody tr').map((tr) => tr.findAll('td')[col].text())
}

describe('CsvPreview – rendering', () => {
  it('requests the file over fs.read_file and renders header + rows', async () => {
    const { wrapper, backend } = await mountCsv('name,size\nfoo,1\nbar,2\n')
    expect(backend.send).toHaveBeenCalledWith('fs.read_file', {
      workspace_path: '/ws',
      rel_path: 'data/table.csv',
    })
    expect(wrapper.findAll('th')).toHaveLength(2)
    expect(wrapper.findAll('th')[0].text()).toContain('name')
    expect(cellTexts(wrapper, 0)).toEqual(['foo', 'bar'])
  })

  it('renders quoted fields correctly', async () => {
    const { wrapper } = await mountCsv('a,b\n"x, y","say ""hi"""\n')
    expect(cellTexts(wrapper, 0)).toEqual(['x, y'])
    expect(cellTexts(wrapper, 1)).toEqual(['say "hi"'])
  })

  it('splits TSV files on tabs', async () => {
    const { wrapper } = await mountCsv('a\tb\n1\t2\n', 'data/table.tsv')
    expect(wrapper.findAll('th')).toHaveLength(2)
    expect(cellTexts(wrapper, 1)).toEqual(['2'])
  })

  it('shows an error status when the read fails', async () => {
    const { wrapper } = await mountCsv(null)
    expect(wrapper.find('.csvp-status--error').text()).toContain('Failed to load file contents.')
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('shows an empty notice for an empty file', async () => {
    const { wrapper } = await mountCsv('')
    expect(wrapper.text()).toContain('The file is empty.')
  })
})

describe('CsvPreview – sorting', () => {
  it('sorts numerically when every value is a number, and reverses on second click', async () => {
    const { wrapper } = await mountCsv('name,size\nb,10\na,9\nc,100\n')
    const sizeTh = wrapper.findAll('th')[1]
    await sizeTh.trigger('click')
    expect(cellTexts(wrapper, 1)).toEqual(['9', '10', '100'])
    await sizeTh.trigger('click')
    expect(cellTexts(wrapper, 1)).toEqual(['100', '10', '9'])
  })

  it('sorts as strings when a column has non-numeric values', async () => {
    const { wrapper } = await mountCsv('k,v\nx,10\ny,9a\nz,2\n')
    await wrapper.findAll('th')[1].trigger('click')
    expect(cellTexts(wrapper, 1)).toEqual(['10', '2', '9a'])
  })
})

describe('CsvPreview – row cap', () => {
  it('caps at 5000 data rows and shows a truncation notice', async () => {
    const lines = ['col']
    for (let i = 0; i < 5050; i++) lines.push(String(i))
    const { wrapper } = await mountCsv(lines.join('\n') + '\n')
    expect(wrapper.findAll('tbody tr')).toHaveLength(5000)
    expect(wrapper.text()).toContain('Showing the first 5000 rows.')
  })

  it('shows no truncation notice at exactly the cap', async () => {
    const lines = ['col']
    for (let i = 0; i < 5000; i++) lines.push(String(i))
    const { wrapper } = await mountCsv(lines.join('\n') + '\n')
    expect(wrapper.findAll('tbody tr')).toHaveLength(5000)
    expect(wrapper.text()).not.toContain('Showing the first')
  })
})
