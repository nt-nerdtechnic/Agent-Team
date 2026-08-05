import { ref } from 'vue'

export interface Diagnostic {
  relPath: string
  /** Workspace root `relPath` is resolved against — files opened from outside
   *  the window's workspace carry their own root, so the same basename in two
   *  roots stays two distinct entries. */
  wsPath?: string
  line: number
  col: number
  endLine?: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source?: string
}

/** Store key: diagnostics are per (workspace, relPath), not per relPath. */
export function diagnosticsKey(wsPath: string, relPath: string): string {
  return `${wsPath}\x00${relPath}`
}

export const diagnosticsStore = ref<Map<string, Diagnostic[]>>(new Map())

export function setDiagnostics(key: string, diags: Diagnostic[]): void {
  const m = new Map(diagnosticsStore.value)
  m.set(key, diags)
  diagnosticsStore.value = m
}

export function clearDiagnostics(key: string): void {
  const m = new Map(diagnosticsStore.value)
  m.delete(key)
  diagnosticsStore.value = m
}

export function allDiagnosticsSorted(): Diagnostic[] {
  const all: Diagnostic[] = []
  for (const diags of diagnosticsStore.value.values()) {
    all.push(...diags)
  }
  return all.sort((a, b) => {
    const ka = diagnosticsKey(a.wsPath ?? '', a.relPath)
    const kb = diagnosticsKey(b.wsPath ?? '', b.relPath)
    if (ka !== kb) return ka.localeCompare(kb)
    return a.line - b.line
  })
}
