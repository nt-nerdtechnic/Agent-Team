export function closeGitWindowMenuOnEscape(
  event: KeyboardEvent,
  menuOpen: boolean,
  close: () => void,
): boolean {
  if (event.key !== 'Escape' || !menuOpen) return false
  close()
  event.preventDefault()
  event.stopPropagation()
  return true
}

export interface GitPaneMenuEscapeContext {
  root: HTMLElement | null
  menuOwnerId: string
  activeMenuOwnerId: string | null
  isMenuOpen: boolean
  close: () => void
}

export function closeGitPaneMenusOnEscape(
  event: KeyboardEvent,
  context: GitPaneMenuEscapeContext,
): boolean {
  if (event.key !== 'Escape') return false
  const target = event.target
  const inPane = context.root && target instanceof Node && context.root.contains(target)
  const targetPaneOwner = target instanceof Element
    ? target.closest('[data-git-pane-owner]')?.getAttribute('data-git-pane-owner')
    : null
  const targetMenuOwner = target instanceof Element
    ? target.closest('[data-git-pane-menu-owner]')?.getAttribute('data-git-pane-menu-owner')
    : null
  if (targetPaneOwner && targetPaneOwner !== context.menuOwnerId) return false
  if (targetMenuOwner && targetMenuOwner !== context.menuOwnerId) return false
  const inOwnedMenu = target instanceof Element && Boolean(
    target.closest(`[data-git-pane-menu-owner="${context.menuOwnerId}"]`),
  )
  const ownsActiveMenu = context.activeMenuOwnerId === context.menuOwnerId
  if (context.activeMenuOwnerId !== null && !ownsActiveMenu) return false
  if (!inPane && !inOwnedMenu && !ownsActiveMenu) return false
  if (!context.isMenuOpen) return false
  context.close()
  event.preventDefault()
  event.stopPropagation()
  return true
}
