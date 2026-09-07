/**
 * Who is allowed to invoke a sensitive IPC handler.
 *
 * `ipcMain.handle` answers whoever can reach `ipcRenderer` — that is every
 * frame of every window, including a `<webview>` guest a plugin renders and
 * any iframe a preview loads. The preload only exposes narrow functions, but
 * a handler that runs a command, writes a settings file, or mints a trust
 * confirmation must not take the frame's word for it: it has to look at who
 * is asking. Electron's own checklist puts this as item 17, "validate the
 * sender of all IPC messages".
 *
 * The rule here is deliberately structural rather than a registry lookup:
 * the sender must be the TOP frame of a real BrowserWindow. That admits the
 * main windows and the app's own contribution windows (Editor, Plan, Git —
 * they are BrowserWindows too) and refuses webview guests (`getType()` is
 * "webview") and sub-frames (`senderFrame.parent` is set). A registry of
 * known windows would be stricter but would have to be maintained in step
 * with every window the app opens; this cannot fall out of date.
 */

/** The slice of Electron's IpcMainInvokeEvent this decision reads, so the
 *  function can be unit-tested without an Electron runtime. */
export interface SenderLike {
  sender: { getType?: () => string; isDestroyed?: () => boolean }
  senderFrame?: { parent?: unknown } | null
}

export function isAppWindowSender(event: SenderLike): boolean {
  const { sender, senderFrame } = event
  if (!sender || typeof sender.getType !== 'function') return false
  if (sender.isDestroyed?.()) return false
  if (sender.getType() !== 'window') return false
  // A missing senderFrame means an old Electron with no frame info; refuse
  // rather than guess — every supported version has it.
  if (!senderFrame) return false
  return !senderFrame.parent
}

/** The refusal handlers return, in the shape most of them already use. */
export const UNTRUSTED_SENDER = { ok: false as const, error: 'unauthorized sender' }
