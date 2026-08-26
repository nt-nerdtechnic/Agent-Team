// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import FontPreview from '../FontPreview.vue'
import { i18n } from '@navide/ui-foundation'

i18n.global.locale.value = 'en-US'

let created: Array<{ family: string; source: string }> = []
let loadShouldFail = false

class FakeFontFace {
  family: string
  source: string
  constructor(family: string, source: string) {
    this.family = family
    this.source = source
    created.push(this)
  }
  async load(): Promise<this> {
    if (loadShouldFail) throw new Error('bad font data')
    return this
  }
}

const fontsAdd = vi.fn()
const fontsDelete = vi.fn()

beforeEach(() => {
  created = []
  loadShouldFail = false
  fontsAdd.mockClear()
  fontsDelete.mockClear()
  vi.stubGlobal('FontFace', FakeFontFace)
  Object.defineProperty(document, 'fonts', {
    value: { add: fontsAdd, delete: fontsDelete },
    configurable: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mountFont(relPath = 'assets/custom.woff2') {
  return mount(FontPreview, {
    props: {
      workspacePath: '/ws',
      relPath,
      name: relPath.split('/').pop()!,
      backend: { httpUrl: ref('http://127.0.0.1:8123'), send: vi.fn() } as never,
    },
    global: { plugins: [i18n] },
  })
}

describe('FontPreview', () => {
  it('registers a FontFace pointing at /fs/raw and renders the specimen', async () => {
    const wrapper = mountFont()
    await flushPromises()
    expect(created).toHaveLength(1)
    expect(created[0].source).toBe(
      'url("http://127.0.0.1:8123/fs/raw?workspace=%2Fws&rel=assets%2Fcustom.woff2")',
    )
    expect(fontsAdd).toHaveBeenCalledWith(created[0])
    const specimen = wrapper.find('.fontp-specimen')
    expect(specimen.exists()).toBe(true)
    expect(specimen.attributes('style')).toContain(created[0].family)
    expect(specimen.text()).toContain('The quick brown fox')
    expect(specimen.text()).toContain('0123456789')
    expect(specimen.text()).toContain('敏捷的棕色狐狸跳過懶惰的狗')
  })

  it('removes the FontFace from document.fonts on unmount', async () => {
    const wrapper = mountFont()
    await flushPromises()
    wrapper.unmount()
    expect(fontsDelete).toHaveBeenCalledWith(created[0])
  })

  it('uses a distinct family name per instance', async () => {
    const a = mountFont()
    const b = mountFont()
    await flushPromises()
    expect(created).toHaveLength(2)
    expect(created[0].family).not.toBe(created[1].family)
    a.unmount()
    b.unmount()
  })

  it('shows an error card when the font fails to load', async () => {
    loadShouldFail = true
    const wrapper = mountFont('broken.ttf')
    await flushPromises()
    expect(wrapper.find('.fontp-specimen').exists()).toBe(false)
    expect(wrapper.find('.fontp-card-name').text()).toBe('broken.ttf')
    expect(wrapper.find('.fontp-card-error').text()).toContain('Failed to load the font.')
    expect(fontsAdd).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(fontsDelete).not.toHaveBeenCalled()
  })
})
