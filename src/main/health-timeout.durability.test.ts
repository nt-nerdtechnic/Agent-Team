import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync as realWriteFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A bare writeFileSync truncates the target before it writes. If the process
// dies in that gap the file parses to the default and the user's configured
// timeout is gone — with nothing said about it. These cover both halves of
// that: the write not being destructive, and the read not being silent.

const hooks = vi.hoisted(() => ({ crashMidWrite: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    writeFileSync: (path: Parameters<typeof actual.writeFileSync>[0], data: unknown, opts?: unknown) => {
      if (hooks.crashMidWrite) {
        // Land a truncated payload, then die — exactly what a crash between
        // truncate and the final byte leaves behind.
        actual.writeFileSync(path as string, String(data).slice(0, 6), opts as never)
        throw new Error('simulated crash mid-write')
      }
      return actual.writeFileSync(path as string, data as string, opts as never)
    },
  }
})

const { readHealthCheckTimeoutSec, writeHealthCheckTimeoutSec, DEFAULT_HEALTH_CHECK_TIMEOUT_SEC } =
  await import('./health-timeout')

describe('health timeout durability', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-timeout-durability-'))
    file = join(dir, 'health-check-timeout.json')
    hooks.crashMidWrite = false
  })
  afterEach(() => {
    hooks.crashMidWrite = false
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the stored value when a write dies partway through', () => {
    writeHealthCheckTimeoutSec(file, 75)
    expect(readHealthCheckTimeoutSec(file)).toBe(75)

    hooks.crashMidWrite = true
    expect(() => writeHealthCheckTimeoutSec(file, 120)).toThrow('simulated crash mid-write')

    // The half-written bytes went to the temp path, so the live file is still
    // the last good document. Without temp+rename this reads back as the
    // default — the value silently reverting is the bug.
    hooks.crashMidWrite = false
    expect(readHealthCheckTimeoutSec(file)).toBe(75)
  })

  it('leaves no temp file behind on a successful write', () => {
    writeHealthCheckTimeoutSec(file, 90)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(readHealthCheckTimeoutSec(file)).toBe(90)
  })

  it('reports a corrupt document instead of quietly using the default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    realWriteFileSync(file, '{truncated', 'utf-8')

    expect(readHealthCheckTimeoutSec(file)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_SEC)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('corrupt document'),
      expect.anything(),
    )
  })

  it('stays quiet when there is simply no file yet', () => {
    // First run is not a fault — warning here would train the user to ignore it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(readHealthCheckTimeoutSec(file)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_SEC)
    expect(warn).not.toHaveBeenCalled()
  })
})
