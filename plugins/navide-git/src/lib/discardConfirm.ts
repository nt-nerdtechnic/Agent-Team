// Safety gate for discarding git changes. Discarding is destructive and
// irreversible, so EVERY discard path (single file, selection, folder, all)
// must pass through guardedDiscard — it runs the destructive action only after
// the user confirms a modal dialog. Kept as a tiny pure-ish helper so the
// "confirm-then-discard, never on cancel" contract is unit-testable without
// mounting the whole GitPane.

type ConfirmFn = (
  message: string,
  opts?: { title?: string; confirmText?: string; cancelText?: string },
) => Promise<boolean>

const MAX_LISTED = 12

/** Build the confirmation prompt, capping the listed files so a huge selection
 *  can't overflow the dialog. */
export function discardConfirmMessage(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED).join('\n')
  const more = paths.length > MAX_LISTED ? `\n…and ${paths.length - MAX_LISTED} more` : ''
  return `Discard ${paths.length} change(s)? This cannot be undone.\n\n${shown}${more}`
}

/** Confirm, then discard. Returns true only when the discard actually ran.
 *  No-ops (and never calls discard) on an empty list or a cancelled dialog. */
export async function guardedDiscard(
  paths: string[],
  confirm: ConfirmFn,
  discard: (paths: string[]) => unknown,
): Promise<boolean> {
  if (!paths.length) return false
  const ok = await confirm(discardConfirmMessage(paths), {
    title: 'Discard changes',
    confirmText: 'Discard',
    cancelText: 'Cancel',
  })
  if (!ok) return false
  await discard(paths)
  return true
}
