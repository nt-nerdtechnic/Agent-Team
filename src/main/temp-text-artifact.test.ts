import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { writeTempTextArtifact } from './temp-text-artifact'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('writeTempTextArtifact', () => {
  it('preserves the sanitized caller filename inside a Host-randomized directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-temp-artifact-'))
    roots.push(root)

    const artifact = await writeTempTextArtifact(root, '../review\\result.command', 'read-only content')

    expect(basename(artifact.path)).toBe('.._review_result.command')
    expect(dirname(artifact.path)).toMatch(/agent-team-head[/\\][0-9a-f-]{36}$/)
    expect(artifact.displayName).toBe('../review\\result.command')
    expect(readFileSync(artifact.path, 'utf8')).toBe('read-only content')
  })

  it('uses a safe fallback for dot-only filenames', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-temp-artifact-'))
    roots.push(root)

    const artifact = await writeTempTextArtifact(root, '..', 'content')

    expect(basename(artifact.path)).toBe('artifact.txt')
  })
})
