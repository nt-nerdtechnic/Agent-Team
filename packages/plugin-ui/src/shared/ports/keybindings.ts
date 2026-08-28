export interface KeybindingsReadResult {
  ok: boolean
  content?: string
  error?: string
}

export interface KeybindingsWriteResult {
  ok: boolean
  error?: string
}

/** Named persistence/event port for the shared keyboard resolver. */
export interface KeybindingsPort {
  read?(): Promise<KeybindingsReadResult>
  write?(content: string): Promise<KeybindingsWriteResult>
  onChanged?(callback: (content: string) => void): () => void
}
