import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { RestoredUpdateState } from './updater-service'

// The updater service keeps its state purely in memory, so a restart used to
// forget that any check had ever run — including a run of failing background
// checks. This persists only the facts worth carrying across a session: when a
// check last succeeded, and whether checks are currently failing.
//
// The caller resolves the path (this module stays electron-free so it can be
// unit tested in isolation).

export function parseUpdaterStateDoc(text: string | null): RestoredUpdateState {
  if (!text) return {}
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object') return {}
  const doc = raw as Record<string, unknown>
  const state: RestoredUpdateState = {}
  if (typeof doc.checkedAt === 'string') state.checkedAt = doc.checkedAt
  const failure = doc.lastCheckFailure
  if (failure && typeof failure === 'object') {
    const entry = failure as Record<string, unknown>
    if (
      typeof entry.message === 'string' &&
      typeof entry.count === 'number' &&
      Number.isFinite(entry.count) &&
      entry.count > 0 &&
      typeof entry.at === 'string'
    ) {
      state.lastCheckFailure = { message: entry.message, count: entry.count, at: entry.at }
    }
  }
  return state
}

export function readUpdaterState(filePath: string): RestoredUpdateState {
  try {
    return parseUpdaterStateDoc(readFileSync(filePath, 'utf-8'))
  } catch {
    return {}
  }
}

// Best-effort persistence: losing this file only costs the carried-over check
// history, so a write failure must never break the updater.
export function writeUpdaterState(filePath: string, state: RestoredUpdateState): void {
  try {
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(tmp, filePath)
  } catch (error) {
    console.warn('[updater] failed to persist update state:', error)
  }
}
