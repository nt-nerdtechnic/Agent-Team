export const NAVIDE_UI_TOKENS = {
  colorText: 'var(--navide-color-text)',
  colorSurface: 'var(--navide-color-surface)',
  colorAccent: 'var(--navide-color-accent)',
  space1: 'var(--navide-space-1)',
  space2: 'var(--navide-space-2)',
  radius: 'var(--navide-radius)',
} as const

export type PluginButtonVariant = 'primary' | 'secondary'

export interface PluginButtonOptions {
  readonly label: string
  readonly variant?: PluginButtonVariant
  readonly disabled?: boolean
  readonly onClick?: (event: MouseEvent) => void
}

export function createPluginButton(options: PluginButtonOptions): HTMLButtonElement {
  const variant = options.variant ?? 'primary'
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = options.label
  button.disabled = options.disabled ?? false
  button.className = `navide-plugin-button navide-plugin-button--${variant}`
  button.dataset.navidePrimitive = 'button'
  button.dataset.navideVariant = variant
  if (options.onClick) button.addEventListener('click', options.onClick)
  return button
}
