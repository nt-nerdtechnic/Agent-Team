/**
 * cliPermission.ts
 *
 * One definition of whether a CLI pane starts with its permission-bypass flag.
 *
 * `skipPermissionFlagFor` resolves the global YOLO toggle against the
 * per-vendor override. Every spawn, resume and restore path must go through
 * it — they each used to inline `yolo ? spec.skipPermissionFlag : ''`, which
 * is why a per-vendor setting could otherwise take effect on some paths and
 * not others.
 */

/** Per-vendor override for the global YOLO toggle. */
export type CliPermissionMode = 'inherit' | 'force-on' | 'force-off'

const MODES: readonly string[] = ['inherit', 'force-on', 'force-off']

/** Settings key holding one vendor's override. Mirrors the existing
 *  `agentTeam.cliBinary.<key>` per-vendor key shape. */
export function cliPermissionKey(agentKey: string): string {
  return `agentTeam.cliPermission.${agentKey}`
}

/** Unknown or missing values read as 'inherit', so an unset vendor behaves
 *  exactly as it did before this setting existed. */
export function parseCliPermissionMode(stored: string | null | undefined): CliPermissionMode {
  return MODES.includes(stored as string) ? (stored as CliPermissionMode) : 'inherit'
}

/** The flag to append to a spawn command, or '' for none.
 *
 *  A vendor with no `skipPermissionFlag` (grok / opencode / pi) always yields
 *  '' — there is nothing to force on. */
export function skipPermissionFlagFor(input: {
  spec: { skipPermissionFlag?: string } | undefined
  globalYolo: boolean
  mode: CliPermissionMode
}): string {
  const flag = input.spec?.skipPermissionFlag
  if (!flag) return ''
  if (input.mode === 'force-off') return ''
  if (input.mode === 'force-on') return flag
  return input.globalYolo ? flag : ''
}
