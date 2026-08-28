import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { isTrustedPluginManagementSender } from './plugins/pluginIpc'

export function trustedGitLeftWindow(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  mainWindows: ReadonlySet<BrowserWindow>,
  detachedWindowIds: ReadonlySet<number>,
): BrowserWindow | null {
  const hostWindow = BrowserWindow.fromWebContents(event.sender)
  if (
    !hostWindow ||
    !event.senderFrame ||
    event.senderFrame.parent ||
    detachedWindowIds.has(hostWindow.id) ||
    !isTrustedPluginManagementSender(event, mainWindows)
  ) return null
  return hostWindow
}

export function registeredGitLeftWorkspace(
  hostWindow: BrowserWindow,
  requestedWorkspace: unknown,
  mainWindowWorkspaces: ReadonlyMap<BrowserWindow, string>,
  normalizeWorkspacePath: (path: string) => string,
): string | null {
  const registeredWorkspace = mainWindowWorkspaces.get(hostWindow)
  if (!registeredWorkspace || typeof requestedWorkspace !== 'string' || !requestedWorkspace.trim()) return null
  if (normalizeWorkspacePath(registeredWorkspace) !== normalizeWorkspacePath(requestedWorkspace)) return null
  return registeredWorkspace
}
