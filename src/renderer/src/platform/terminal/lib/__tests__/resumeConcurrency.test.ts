import { describe, expect, it } from 'vitest'
import {
  clampResumeConcurrency,
  DEFAULT_RESUME_CONCURRENCY,
  MIN_RESUME_CONCURRENCY,
  MAX_RESUME_CONCURRENCY,
} from '../resumeConcurrency'

describe('clampResumeConcurrency', () => {
  it('passes through in-range integers', () => {
    expect(clampResumeConcurrency(1)).toBe(1)
    expect(clampResumeConcurrency(3)).toBe(3)
    expect(clampResumeConcurrency(10)).toBe(10)
  })

  it('clamps to the [MIN, MAX] bounds', () => {
    expect(clampResumeConcurrency(0)).toBe(MIN_RESUME_CONCURRENCY)
    expect(clampResumeConcurrency(-5)).toBe(MIN_RESUME_CONCURRENCY)
    expect(clampResumeConcurrency(99)).toBe(MAX_RESUME_CONCURRENCY)
  })

  it('rounds fractional values', () => {
    expect(clampResumeConcurrency(2.4)).toBe(2)
    expect(clampResumeConcurrency(2.6)).toBe(3)
  })

  it('coerces numeric strings (the <input type=number> path)', () => {
    expect(clampResumeConcurrency('4')).toBe(4)
    expect(clampResumeConcurrency('12')).toBe(MAX_RESUME_CONCURRENCY)
  })

  it('falls back to the default for unparseable values', () => {
    expect(clampResumeConcurrency('')).toBe(DEFAULT_RESUME_CONCURRENCY)
    expect(clampResumeConcurrency('abc')).toBe(DEFAULT_RESUME_CONCURRENCY)
    expect(clampResumeConcurrency(null)).toBe(DEFAULT_RESUME_CONCURRENCY)
    expect(clampResumeConcurrency(undefined)).toBe(DEFAULT_RESUME_CONCURRENCY)
    expect(clampResumeConcurrency(NaN)).toBe(DEFAULT_RESUME_CONCURRENCY)
  })
})
