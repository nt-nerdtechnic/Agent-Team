export type McpTransport = 'stdio' | 'http' | 'sse'

interface McpTransportShape {
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

const SECRET_NAME_PARTS = new Set([
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'AUTH',
  'AUTHORIZATION',
  'COOKIE',
  'CREDENTIAL',
  'CREDENTIALS',
])

export function isSecretSettingKey(key: string): boolean {
  const parts = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase())
  return parts.some((part) => SECRET_NAME_PARTS.has(part))
}

export interface RevisionedMcpSaveOutcome {
  ok: boolean
  revision?: string | null
}

export class RevisionedMcpSaveQueue<T> {
  private tail: Promise<void> = Promise.resolve()
  private queued = 0
  private batchFailed = false
  private readonly revisionRebases = new Map<string | null, string | null>()

  constructor(
    private readonly save: (snapshot: T, expectedRevision: string | null) => Promise<RevisionedMcpSaveOutcome>,
    private readonly refreshAfterDrain: (lastSnapshot: T) => Promise<void>
  ) {}

  get pending(): number {
    return this.queued
  }

  enqueue(draft: T, expectedRevision: string | null): Promise<boolean> {
    const snapshot = JSON.parse(JSON.stringify(draft)) as T
    this.queued += 1
    const run = this.tail.then(async () => {
      const resolvedRevision = this.resolveRevision(expectedRevision)
      const outcome = await this.save(snapshot, resolvedRevision)
      if (outcome.ok && outcome.revision !== undefined) {
        this.revisionRebases.set(resolvedRevision, outcome.revision)
      }
      return outcome
    })
    const finalized = run.then(async (outcome) => {
      this.queued -= 1
      if (!outcome.ok) this.batchFailed = true
      if (this.queued === 0) {
        const shouldRefresh = !this.batchFailed
        this.batchFailed = false
        this.revisionRebases.clear()
        if (shouldRefresh) await this.refreshAfterDrain(snapshot)
      }
      return outcome.ok
    })
    this.tail = finalized.then(() => undefined, () => undefined)
    return finalized
  }

  private resolveRevision(revision: string | null): string | null {
    let resolved = revision
    const visited = new Set<string | null>()
    while (this.revisionRebases.has(resolved) && !visited.has(resolved)) {
      visited.add(resolved)
      resolved = this.revisionRebases.get(resolved) ?? null
    }
    return resolved
  }
}

export function switchMcpTransportShape(server: McpTransportShape, transport: McpTransport): void {
  server.transport = transport
  if (transport === 'stdio') {
    delete server.url
    delete server.headers
    server.command ??= ''
    server.args ??= []
    server.env ??= {}
  } else {
    delete server.command
    delete server.args
    delete server.env
    server.url ??= ''
    server.headers ??= {}
  }
}

export function shouldReloadMcpAfterBundleImport(applied: readonly string[] | undefined): boolean {
  return applied?.includes('mcp') ?? false
}

export function nextRecordKey(record: Record<string, string>, base: string): string {
  if (!(base in record)) return base
  let suffix = 2
  while (`${base}_${suffix}` in record) suffix += 1
  return `${base}_${suffix}`
}
