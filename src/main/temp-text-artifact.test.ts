import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { writeTempTextArtifact } from './temp-text-artifact'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('writeTempTextArtifact', () => {
  it('writes a Host-owned text artifact regardless of an executable-looking display name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-temp-artifact-'))
    roots.push(root)

    const artifact = await writeTempTextArtifact(root, 'review-result.command', 'read-only content')

    expect(extname(artifact.path)).toBe('.txt')
    expect(artifact.displayName).toBe('review-result.command')
    expect(readFileSync(artifact.path, 'utf8')).toBe('read-only content')
  })
})
