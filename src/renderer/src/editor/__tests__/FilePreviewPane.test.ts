// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import FilePreviewPane from '../FilePreviewPane.vue'
import { i18n } from '@navide/ui-foundation'

i18n.global.locale.value = 'en-US'

function makeBackend() {
  return {
    httpUrl: ref('http://127.0.0.1:8123'),
    status: ref('connected'),
    send: vi.fn(async () => ({ payload: { ok: true } })),
  }
}

// Minimal fetch response for /fs/raw range requests.
function fakeResponse(bytes: Uint8Array, total: number) {
  return {
    ok: true,
    status: 206,
    headers: {
      get: (key: string) =>
        key.toLowerCase() === 'content-range' ? `bytes 0-${bytes.length - 1}/${total}` : null,
    },
    arrayBuffer: async () => bytes.slice().buffer,
  }
}

function mountPane(relPath: string) {
  return mount(FilePreviewPane, {
    props: {
      workspacePath: '/ws',
      relPath,
      name: relPath.split('/').pop()!,
      backend: makeBackend() as never,
    },
    global: { plugins: [i18n] },
  })
}

const fetchMock = vi.fn(async () => fakeResponse(new Uint8Array(0), 0))

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockImplementation(async () => fakeResponse(new Uint8Array(0), 0))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FilePreviewPane – image', () => {
  it('renders an <img> pointing at /fs/raw with encoded params', async () => {
    const wrapper = mountPane('assets/photo.png')
    await flushPromises()
    const img = wrapper.find('img.fpv-img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe(
      'http://127.0.0.1:8123/fs/raw?workspace=%2Fws&rel=assets%2Fphoto.png',
    )
  })

  it('toggles between fit-to-window and actual size', async () => {
    const wrapper = mountPane('photo.jpg')
    await flushPromises()
    expect(wrapper.find('img.fpv-img--fit').exists()).toBe(true)
    const zoom = wrapper.find('.fpv-zoom-btn')
    expect(zoom.text()).toContain('Actual size')
    await zoom.trigger('click')
    expect(wrapper.find('img.fpv-img--full').exists()).toBe(true)
    expect(wrapper.find('.fpv-zoom-btn').text()).toContain('Fit to window')
  })

  it('shows the file size from the range response headers', async () => {
    fetchMock.mockImplementation(async () => fakeResponse(new Uint8Array(1), 2048))
    const wrapper = mountPane('photo.png')
    await flushPromises()
    expect(wrapper.find('.fpv-meta').text()).toContain('2.0 KB')
  })
})

describe('FilePreviewPane – media', () => {
  it('renders a <video controls> for video files', async () => {
    const wrapper = mountPane('clip.mp4')
    await flushPromises()
    const video = wrapper.find('video.fpv-video')
    expect(video.exists()).toBe(true)
    expect(video.attributes('controls')).toBeDefined()
    expect(video.attributes('src')).toContain('/fs/raw?workspace=%2Fws&rel=clip.mp4')
  })

  it('renders an <audio controls> for audio files', async () => {
    const wrapper = mountPane('song.mp3')
    await flushPromises()
    const audio = wrapper.find('audio.fpv-audio')
    expect(audio.exists()).toBe(true)
    expect(audio.attributes('controls')).toBeDefined()
  })
})

describe('FilePreviewPane – pdf', () => {
  it('embeds an iframe when the Chromium PDF viewer is available', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { value: true, configurable: true })
    const wrapper = mountPane('doc.pdf')
    await flushPromises()
    const frame = wrapper.find('iframe.fpv-pdf-frame')
    expect(frame.exists()).toBe(true)
    expect(frame.attributes('src')).toContain('rel=doc.pdf')
  })

  it('falls back to an info card when the PDF viewer is unavailable', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { value: false, configurable: true })
    const wrapper = mountPane('doc.pdf')
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.text()).toContain('The embedded PDF viewer is not available')
    expect(wrapper.find('.fpv-open-btn').exists()).toBe(true)
  })
})

describe('FilePreviewPane – html', () => {
  it('renders a fully sandboxed iframe pointing at the path-addressed /fs/page route', async () => {
    const wrapper = mountPane('site/index.html')
    await flushPromises()
    const frame = wrapper.find('iframe.fpv-html-frame')
    expect(frame.exists()).toBe(true)
    // L3dz = unpadded URL-safe base64 of '/ws'; slashes in rel survive.
    expect(frame.attributes('src')).toBe('http://127.0.0.1:8123/fs/page/L3dz/site/index.html')
    // Empty sandbox attribute = no allow-* tokens (scripts/forms blocked).
    expect(frame.attributes('sandbox')).toBe('')
  })

  it('shows the scripts-disabled hint in the toolbar', async () => {
    const wrapper = mountPane('page.htm')
    await flushPromises()
    expect(wrapper.find('.fpv-hint').text()).toBe('Scripts are disabled in preview')
  })
})

describe('FilePreviewPane – binary hex dump', () => {
  it('fetches the first 64 KB with a Range header and renders offset/hex/ascii', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x41, 0x42, 0x43])
    fetchMock.mockImplementation(async () => fakeResponse(bytes, bytes.length))
    const wrapper = mountPane('archive.7z')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8123/fs/raw?workspace=%2Fws&rel=archive.7z',
      { headers: { Range: 'bytes=0-65535' } },
    )
    const hex = wrapper.find('pre.fpv-hex')
    expect(hex.exists()).toBe(true)
    expect(hex.text()).toContain('00000000')
    expect(hex.text()).toContain('50 4b 03 04 41 42 43')
    expect(hex.text()).toContain('|PK..ABC|')
  })

  it('shows an info card with name and size, and a truncation note for large files', async () => {
    const bytes = new Uint8Array(16)
    fetchMock.mockImplementation(async () => fakeResponse(bytes, 5 * 1048576))
    const wrapper = mountPane('big.bin')
    await flushPromises()
    expect(wrapper.find('.fpv-card-name').text()).toBe('big.bin')
    expect(wrapper.find('.fpv-meta').text()).toContain('5.0 MB')
    expect(wrapper.text()).toContain('Showing the first 64 KB of 5.0 MB.')
  })

  it('shows an error status when the fetch fails', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }))
    const wrapper = mountPane('broken.bin')
    await flushPromises()
    expect(wrapper.find('.fpv-hex-status--error').text()).toContain('Failed to load file contents.')
  })
})

describe('FilePreviewPane – dispatch for new kinds', () => {
  it('routes new media extensions to the media branches (.mkv video, .aac audio, .apng image)', async () => {
    const mkv = mountPane('movies/clip.mkv')
    await flushPromises()
    expect(mkv.find('video.fpv-video').exists()).toBe(true)

    const aac = mountPane('sounds/tone.aac')
    await flushPromises()
    expect(aac.find('audio.fpv-audio').exists()).toBe(true)

    const apng = mountPane('anim/loader.apng')
    await flushPromises()
    expect(apng.find('img.fpv-img').exists()).toBe(true)
  })

  it('mounts CsvPreview for .csv files', async () => {
    const wrapper = mountPane('data/table.csv')
    await flushPromises()
    expect(wrapper.find('.csvp').exists()).toBe(true)
    expect(wrapper.find('pre.fpv-hex').exists()).toBe(false)
  })

  it('mounts FontPreview for .ttf files instead of the hex fallback', async () => {
    const wrapper = mountPane('fonts/custom.ttf')
    await flushPromises()
    expect(wrapper.find('.fontp').exists()).toBe(true)
    expect(wrapper.find('pre.fpv-hex').exists()).toBe(false)
  })

  it('mounts ArchivePreview for .zip and .tar.gz files instead of the hex fallback', async () => {
    const zip = mountPane('bundle/archive.zip')
    await flushPromises()
    expect(zip.find('.arcp').exists()).toBe(true)
    expect(zip.find('pre.fpv-hex').exists()).toBe(false)

    const targz = mountPane('bundle/site.tar.gz')
    await flushPromises()
    expect(targz.find('.arcp').exists()).toBe(true)
  })

  it('mounts NotebookPreview for .ipynb files', async () => {
    const wrapper = mountPane('nb/analysis.ipynb')
    await flushPromises()
    expect(wrapper.find('.nbp').exists()).toBe(true)
    expect(wrapper.find('pre.fpv-hex').exists()).toBe(false)
  })

  it('mounts OfficePreview for .docx and .xlsx files instead of the hex fallback', async () => {
    const docx = mountPane('docs/report.docx')
    await flushPromises()
    expect(docx.find('.offp').exists()).toBe(true)
    expect(docx.find('pre.fpv-hex').exists()).toBe(false)

    const xlsx = mountPane('docs/data.xlsx')
    await flushPromises()
    expect(xlsx.find('.offp').exists()).toBe(true)
    expect(xlsx.find('pre.fpv-hex').exists()).toBe(false)
  })
})

describe('FilePreviewPane – open externally', () => {
  it('calls window.agentTeam.openPath with the absolute path', async () => {
    const openPath = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { openPath }
    const wrapper = mountPane('dist/app.dmg')
    await flushPromises()
    await wrapper.find('.fpv-open-btn').trigger('click')
    expect(openPath).toHaveBeenCalledWith('/ws/dist/app.dmg')
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })
})
