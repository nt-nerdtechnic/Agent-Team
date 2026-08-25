import type { WebContents } from 'electron'

type ZoomLockedWebContents = Pick<
  WebContents,
  'on' | 'setVisualZoomLevelLimits' | 'setZoomFactor'
>

type ZoomChangedListener = () => void

/**
 * Keep Electron's page zoom separate from pane-local content zoom.
 *
 * Chromium can retain a zoom factor for an origin across reloads. Reset it as
 * soon as the WebContents exists and again after a document finishes loading,
 * while disabling pinch/visual zoom. Terminal and editor font-size shortcuts
 * remain independent and continue to work in the renderer.
 */
export function lockPageZoom(
  contents: ZoomLockedWebContents,
  onZoomChanged?: ZoomChangedListener,
): void {
  const resetPageZoom = (): void => contents.setZoomFactor(1)

  resetPageZoom()
  contents.on('did-finish-load', resetPageZoom)
  contents.on('zoom-changed', () => {
    resetPageZoom()
    onZoomChanged?.()
  })
  void contents.setVisualZoomLevelLimits(1, 1)
}
