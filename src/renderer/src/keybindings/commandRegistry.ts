import type { CommandHandler } from './types'

const _commands = new Map<string, CommandHandler>()

export function registerCommand(id: string, handler: CommandHandler): void {
  _commands.set(id, handler)
}

// Returns true if a handler was found and called.
export function executeCommand(id: string, args?: unknown): boolean {
  const handler = _commands.get(id)
  if (!handler) return false
  void handler(args)
  return true
}

export function hasCommand(id: string): boolean {
  return _commands.has(id)
}

export function listCommands(): string[] {
  return [..._commands.keys()]
}

export interface InvokeCommandResult {
  ok: boolean
  result?: unknown
  error?: string
}

// Like executeCommand, but awaits the handler and surfaces its return value
// (or a stringified error if it throws/rejects) instead of firing-and-forgetting.
// Used by the external UI action bus, whose caller needs a real reply.
export async function invokeCommand(id: string, args?: unknown): Promise<InvokeCommandResult> {
  const handler = _commands.get(id)
  if (!handler) return { ok: false, error: `unknown command: ${id}` }
  try {
    const result = await handler(args)
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// For testing only.
export function _resetRegistry(): void {
  _commands.clear()
}
