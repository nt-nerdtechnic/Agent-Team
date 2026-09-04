import { app } from 'electron'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_MAX_DIAGNOSTIC_LOG_BYTES = 256 * 1024 // 256 KB

let configuredMaxLogBytes = DEFAULT_MAX_DIAGNOSTIC_LOG_BYTES
let customLogDir: string | null = null

export function setMaxDiagnosticLogBytes(bytes: number): void {
  configuredMaxLogBytes = Math.max(256, bytes)
}

export function getMaxDiagnosticLogBytes(): number {
  return configuredMaxLogBytes
}

export function setLogDirectory(dir: string | null): void {
  customLogDir = dir
}

export function resetDiagnosticLogConfig(): void {
  configuredMaxLogBytes = DEFAULT_MAX_DIAGNOSTIC_LOG_BYTES
  customLogDir = null
}

export function getRetainedLogBytes(dir?: string): number {
  try {
    const targetDir = dir ?? customLogDir ?? join(app.getPath('userData'), 'logs')
    let total = 0
    try {
      total += statSync(join(targetDir, 'main.log')).size
    } catch {
      /* file not present */
    }
    try {
      total += statSync(join(targetDir, 'main.log.1')).size
    } catch {
      /* file not present */
    }
    return total
  } catch {
    return 0
  }
}

/**
 * Truncate a UTF-8 string to fit within `maxBytes` without cutting inside a
 * multi-byte character sequence.
 */
export function truncateUtf8Bytes(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(str, 'utf8')
  if (buf.byteLength <= maxBytes) return str

  let end = maxBytes
  let i = end - 1
  while (i >= 0 && i >= end - 4) {
    const byte = buf[i]
    if ((byte & 0xc0) === 0xc0) {
      let seqLen = 1
      if ((byte & 0xe0) === 0xc0) seqLen = 2
      else if ((byte & 0xf0) === 0xe0) seqLen = 3
      else if ((byte & 0xf8) === 0xf0) seqLen = 4
      if (i + seqLen > end) {
        end = i
      }
      break
    } else if ((byte & 0x80) === 0) {
      break
    }
    i--
  }
  return buf.subarray(0, end).toString('utf8')
}

/**
 * Trim an oversized log file to keep at most `maxBytes` from its tail,
 * aligning to a newline boundary or valid UTF-8 lead byte.
 */
export function trimFileTail(filePath: string, maxBytes: number): void {
  try {
    const stat = statSync(filePath)
    if (stat.size <= maxBytes) return
    if (maxBytes <= 0) {
      writeFileSync(filePath, '', 'utf8')
      return
    }

    const start = stat.size - maxBytes
    const fd = openSync(filePath, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buffer, 0, maxBytes, start)
    closeSync(fd)

    let slice = buffer.subarray(0, bytesRead)
    const firstNewline = slice.indexOf(0x0a)
    if (firstNewline >= 0 && firstNewline < slice.length - 1) {
      slice = slice.subarray(firstNewline + 1)
    } else {
      let offset = 0
      while (offset < slice.length && (slice[offset] & 0xc0) === 0x80) {
        offset++
      }
      slice = slice.subarray(offset)
    }
    writeFileSync(filePath, slice)
  } catch {
    /* best effort */
  }
}

/**
 * Append one timestamped line to `<userData>/logs/main.log`, beside the
 * backend's own log, rotating to `main.log.1` when exceeding configured capacity.
 *
 * The main process only had stdout, which a packaged launch discards. A
 * degradation that merely `console.warn`ed — the Git v2 → legacy recovery
 * reason above all — therefore left no evidence at all once the app was
 * running, and the reason could not be recovered afterwards. Best-effort by
 * design: a logging failure must never take down the caller.
 */
export function logMain(line: string): void {
  try {
    const dir = customLogDir ?? join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'main.log')
    const rotatedPath = join(dir, 'main.log.1')

    const halfCapacity = Math.max(128, Math.floor(configuredMaxLogBytes / 2))
    const rawEntry = `${new Date().toISOString()} ${line}`
    const rawEntryBytes = Buffer.byteLength(rawEntry + '\n', 'utf8')
    let entry: string
    let entryBytes: number

    if (rawEntryBytes > halfCapacity) {
      const budget = Math.max(0, halfCapacity - Buffer.byteLength('... [entry truncated]\n', 'utf8'))
      const truncated = truncateUtf8Bytes(rawEntry, budget)
      entry = `${truncated}... [entry truncated]\n`
      entryBytes = Buffer.byteLength(entry, 'utf8')
    } else {
      entry = `${rawEntry}\n`
      entryBytes = rawEntryBytes
    }

    let currentSize = 0
    try {
      currentSize = statSync(logPath).size
    } catch {
      currentSize = 0
    }

    if (currentSize > halfCapacity) {
      trimFileTail(logPath, halfCapacity)
      try {
        currentSize = statSync(logPath).size
      } catch {
        currentSize = 0
      }
    }

    if (currentSize + entryBytes > halfCapacity) {
      try {
        renameSync(logPath, rotatedPath)
      } catch {
        /* best effort */
      }
      trimFileTail(rotatedPath, halfCapacity)
      writeFileSync(logPath, entry, 'utf8')
    } else {
      appendFileSync(logPath, entry, 'utf8')
    }

    // Enforce total active + rotated capacity after every write
    let activeSize = 0
    try {
      activeSize = statSync(logPath).size
    } catch {
      activeSize = 0
    }

    let rotatedSize = 0
    try {
      rotatedSize = statSync(rotatedPath).size
    } catch {
      rotatedSize = 0
    }

    if (activeSize + rotatedSize > configuredMaxLogBytes) {
      const allowedRotated = Math.max(0, configuredMaxLogBytes - activeSize)
      trimFileTail(rotatedPath, allowedRotated)
    }

    if (activeSize > configuredMaxLogBytes) {
      trimFileTail(logPath, configuredMaxLogBytes)
    }
  } catch {
    /* observability is never worth a crash */
  }
}

/** `console.warn` for a live terminal, plus a durable line for a packaged run. */
export function warnMain(line: string): void {
  console.warn(line)
  logMain(line)
}
