// Drag feedback for a multi-pane drag. The browser's default drag image is a
// snapshot of the grabbed element alone, which reads as "moving one pane" even
// when the drag carries a whole selection — so a batch drag replaces it with a
// small count chip.

/** Attach a "N panes" chip as the drag image. No-op below two panes (the
 *  default snapshot is the honest picture there) or without a DataTransfer.
 *  The chip is mounted off-screen because Chromium only snapshots elements that
 *  are in the document, and removed on the next frame — the snapshot is taken
 *  synchronously, so the node has no reason to outlive the current task. */
export function setBatchDragImage(
  dataTransfer: DataTransfer | null,
  count: number,
  label: string
): void {
  if (!dataTransfer?.setDragImage || count < 2) return
  const chip = document.createElement('div')
  chip.textContent = label
  chip.setAttribute('aria-hidden', 'true')
  chip.style.cssText = [
    'position:fixed',
    'top:-1000px',
    'left:-1000px',
    'padding:4px 10px',
    'border-radius:6px',
    'font:600 12px/1.4 system-ui,sans-serif',
    'color:#fff',
    'background:#2f6feb',
    'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
    'white-space:nowrap',
    'pointer-events:none',
  ].join(';')
  document.body.appendChild(chip)
  dataTransfer.setDragImage(chip, 12, 12)
  const cleanup = (): void => chip.remove()
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cleanup)
  else setTimeout(cleanup, 0)
}
