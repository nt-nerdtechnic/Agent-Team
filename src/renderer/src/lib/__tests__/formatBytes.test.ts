import { describe, expect, it } from 'vitest'
import { formatBytes } from '../formatBytes'

describe('formatBytes', () => {
  it('scales through the units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe('3.5 GB')
  })

  // One decimal below 100 and none above, so a column of these lines up.
  it('drops the decimal once the number is three digits', () => {
    expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB')
    expect(formatBytes(99.4 * 1024 * 1024)).toBe('99.4 MB')
  })

  it('reads nothing as zero rather than NaN', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})
