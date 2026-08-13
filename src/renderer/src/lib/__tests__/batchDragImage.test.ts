// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setBatchDragImage } from '../batchDragImage'

function fakeTransfer(): { setDragImage: ReturnType<typeof vi.fn> } {
  return { setDragImage: vi.fn() }
}

describe('setBatchDragImage', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('sets a chip carrying the batch label', () => {
    const dt = fakeTransfer()
    setBatchDragImage(dt as unknown as DataTransfer, 3, 'Moving 3 agents')

    expect(dt.setDragImage).toHaveBeenCalledTimes(1)
    const [node] = dt.setDragImage.mock.calls[0]
    expect((node as HTMLElement).textContent).toBe('Moving 3 agents')
  })

  it('mounts the chip off-screen so the snapshot never covers the page', () => {
    const dt = fakeTransfer()
    setBatchDragImage(dt as unknown as DataTransfer, 2, '2')

    const [node] = dt.setDragImage.mock.calls[0]
    const chip = node as HTMLElement
    expect(chip.isConnected).toBe(true)
    expect(chip.style.position).toBe('fixed')
    expect(chip.getAttribute('aria-hidden')).toBe('true')
  })

  it('removes the chip on the next frame', async () => {
    const dt = fakeTransfer()
    setBatchDragImage(dt as unknown as DataTransfer, 2, '2')
    const [node] = dt.setDragImage.mock.calls[0]

    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect((node as HTMLElement).isConnected).toBe(false)
  })

  it('leaves the default drag image alone below two panes', () => {
    const dt = fakeTransfer()
    setBatchDragImage(dt as unknown as DataTransfer, 1, 'one')
    setBatchDragImage(dt as unknown as DataTransfer, 0, 'none')

    expect(dt.setDragImage).not.toHaveBeenCalled()
    expect(document.body.children).toHaveLength(0)
  })

  it('is a no-op without a DataTransfer', () => {
    expect(() => setBatchDragImage(null, 3, 'three')).not.toThrow()
    expect(document.body.children).toHaveLength(0)
  })
})
