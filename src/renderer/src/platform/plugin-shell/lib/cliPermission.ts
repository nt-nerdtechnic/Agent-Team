/** One definition of whether a CLI pane starts with its permission-bypass flag. */

/** Per-vendor override for the global YOLO toggle. */
export type CliPermissionMode = 'inherit' | 'force-on' | 'force-off'

const MODES: readonly string[] = ['inherit', 'force-on', 'force-off']

/** Settings key holding one vendor's override. */
export function cliPermissionKey(agentKey: string): string {
  return `agentTeam.cliPermission.${agentKey}`
}

/** Unknown or missing values preserve the global setting. */
export function parseCliPermissionMode(stored: string | null | undefined): CliPermissionMode {
  return MODES.includes(stored as string) ? (stored as CliPermissionMode) : 'inherit'
}

/** The permission-bypass flag to append to a spawn command, or an empty string. */
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
