import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// `warnMain` runs once per stderr line of a plugin backend child, on the main
// thread. These count the syscalls an ordinary line actually costs: a rotation
// routine on the per-call path turns a chatty backend into synchronous fs
// pressure, which this project has repeatedly seen surface as a startup
// timeout. The bound on retained bytes still has to hold.

const counters = vi.hoisted(() => ({
  appendFileSync: 0,
  writeFileSync: 0,
  statSync: 0,
  readSync: 0,
  renameSync: 0,
  mkdirSync: 0,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const counted = <K extends keyof typeof counters>(name: K, fn: (typeof actual)[K]): (typeof actual)[K] =>
    ((...args: unknown[]) => {
      counters[name]++
      return (fn as (...a: unknown[]) => unknown)(...args)
    }) as unknown as (typeof actual)[K]
  return {
    ...actual,
    default: actual,
    appendFileSync: counted('appendFileSync', actual.appendFileSync),
    writeFileSync: counted('writeFileSync', actual.writeFileSync),
    statSync: counted('statSync', actual.statSync),
    readSync: counted('readSync', actual.readSync),
    renameSync: counted('renameSync', actual.renameSync),
    mkdirSync: counted('mkdirSync', actual.mkdirSync),
  }
})

const { logMain, setMaxDiagnosticLogBytes, setLogDirectory, resetDiagnosticLogConfig, getRetainedLogBytes } =
  await import('./main-log')

function resetCounters(): void {
  for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0
}

describe('main-log syscall cost per line', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'navide-main-log-syscalls-'))
    setLogDirectory(tempDir)
    resetCounters()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetDiagnosticLogConfig()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('costs exactly one append syscall per ordinary line, with no per-line stat, read or write', () => {
    // Capacity large enough that none of these lines can trigger a rotation.
    setMaxDiagnosticLogBytes(4 * 1024 * 1024)

    // The first call pays a one-time measurement of the existing log pair.
    logMain('[plugin-backend] first line pays initialization')
    resetCounters()

    const lineCount = 200
    for (let i = 0; i < lineCount; i++) {
      logMain(`[plugin-backend] Traceback line ${i}: spawn /custom/private/plans ENOENT`)
    }

    const observed = { ...counters }
    expect(observed.appendFileSync).toBe(lineCount)
    expect(observed.statSync).toBe(0)
    expect(observed.readSync).toBe(0)
    expect(observed.writeFileSync).toBe(0)
    expect(observed.renameSync).toBe(0)
    expect(observed.mkdirSync).toBe(0)
  })

  it('keeps rotation amortized and the size bound intact across enough writes to rotate many times', () => {
    const configuredCapacity = 2048
    const halfCapacity = 1024
    setMaxDiagnosticLogBytes(configuredCapacity)

    const lineCount = 500
    for (let i = 0; i < lineCount; i++) {
      logMain(`[plugin-backend] rotation pressure line ${i}`)
    }

    const observed = { ...counters }

    // Rotation really happened, so the bound below is not vacuous.
    expect(existsSync(join(tempDir, 'main.log.1'))).toBe(true)
    expect(observed.renameSync).toBeGreaterThan(1)

    // ...and it stayed amortized: the measurement work is per rotation, not
    // per line, so it is far below one stat per line.
    expect(observed.renameSync).toBeLessThan(lineCount / 4)
    expect(observed.statSync).toBeLessThan(lineCount / 4)
    expect(observed.readSync).toBeLessThan(lineCount / 4)
    expect(observed.appendFileSync + observed.writeFileSync).toBe(lineCount)

    expect(getRetainedLogBytes(tempDir)).toBeLessThanOrEqual(configuredCapacity)
    expect(getRetainedLogBytes(tempDir)).toBeGreaterThan(halfCapacity / 2)
  })

  it('re-measures after the log directory changes so a pre-existing oversized log is still bounded', () => {
    const configuredCapacity = 1000
    setMaxDiagnosticLogBytes(configuredCapacity)

    // Warm the in-memory size tracking against the first directory.
    logMain('[plugin-backend] line in the first log directory')

    const secondDir = mkdtempSync(join(tmpdir(), 'navide-main-log-syscalls-2-'))
    try {
      const seeded = Array.from(
        { length: 200 },
        (_, i) => `2026-09-03T10:00:00.000Z [plugin-backend] pre-existing line ${i}\n`,
      ).join('')
      writeFileSync(join(secondDir, 'main.log'), seeded, 'utf8')

      setLogDirectory(secondDir)
      logMain('[plugin-backend] first line after switching directories')

      expect(getRetainedLogBytes(secondDir)).toBeLessThanOrEqual(configuredCapacity)
    } finally {
      setLogDirectory(tempDir)
      rmSync(secondDir, { recursive: true, force: true })
    }
  })
})
