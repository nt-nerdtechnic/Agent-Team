import { readFileSync, writeFileSync } from 'node:fs'

// Chrome DevTools Protocol (CDP) debug toggle, persisted in a small
// main-owned JSON file in userData (mirrors health-timeout.ts). Must be
// readable synchronously before app.whenReady(): index.ts appends the
// --remote-debugging-port switch at that point, and Electron only honors it
// when set before the app is ready.

export const DEFAULT_CDP_PORT = 9223

export interface CdpDebugConfig {
  enabled: boolean
  port: number
}

export function defaultCdpDebugConfig(): CdpDebugConfig {
  return { enabled: false, port: DEFAULT_CDP_PORT }
}

/** Parse a CDP debug config file's text, tolerating missing/corrupt content —
 *  any read/parse failure must resolve to disabled, never enabled. */
export function parseCdpDebugDoc(text: string | null): CdpDebugConfig {
  if (!text) return defaultCdpDebugConfig()
  try {
    const data = JSON.parse(text)
    const port = Number(data?.port)
    return {
      enabled: data?.enabled === true,
      port: Number.isFinite(port) && port > 0 && port <= 65535 ? Math.round(port) : DEFAULT_CDP_PORT,
    }
  } catch {
    return defaultCdpDebugConfig()
  }
}

export function readCdpDebugConfig(filePath: string): CdpDebugConfig {
  let text: string | null = null
  try { text = readFileSync(filePath, 'utf-8') } catch { /* missing file → default (disabled) */ }
  return parseCdpDebugDoc(text)
}

export function writeCdpDebugConfig(filePath: string, config: CdpDebugConfig): void {
  const normalized: CdpDebugConfig = {
    enabled: !!config.enabled,
    port: Number.isFinite(config.port) && config.port > 0 ? Math.round(config.port) : DEFAULT_CDP_PORT,
  }
  writeFileSync(filePath, JSON.stringify(normalized), 'utf-8')
}
