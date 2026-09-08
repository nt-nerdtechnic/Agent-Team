import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DOC_SUFFIXES,
  isAllowedPlanDocumentPath,
  isPlanDocName,
  PLAN_DOC_DIRS,
} from './plansDirectories'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, statSync: vi.fn(actual.statSync) }
})

describe('plansDirectories', () => {
  let tempWorkspace: string
  let externalDir: string

  beforeEach(() => {
    tempWorkspace = mkdtempSync(join(tmpdir(), 'navide-plans-dir-test-'))
    externalDir = mkdtempSync(join(tmpdir(), 'navide-plans-ext-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempWorkspace, { recursive: true, force: true })
    } catch {
      // ignore
    }
    try {
      rmSync(externalDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('bounds total nested repository probes even when no repository is found', () => {
    for (let parent = 0; parent < 50; parent++) {
      for (let child = 0; child < 50; child++) {
        mkdirSync(join(tempWorkspace, `parent-${parent}`, `child-${child}`), { recursive: true })
      }
    }
    vi.mocked(statSync).mockClear()
    expect(isAllowedPlanDocumentPath('parent-0/child-0/.agent-team/plans/missing.html', tempWorkspace)).toBe(false)
    const probes = vi.mocked(statSync).mock.calls.filter(([path]) => String(path).endsWith('/.git'))
    expect(probes.length).toBeGreaterThan(50)
    expect(probes.length).toBeLessThanOrEqual(2000)
  })

  describe('isPlanDocName', () => {
    it('accepts valid plan document filenames', () => {
      expect(isPlanDocName('plan-1.html')).toBe(true)
      expect(isPlanDocName('feature.plan.md')).toBe(true)
      expect(isPlanDocName('report.md')).toBe(true)
      expect(isPlanDocName('UPPERCASE.HTML')).toBe(true)
    })

    it('rejects infrastructure, hidden, or invalid extensions', () => {
      expect(isPlanDocName('_spec.md')).toBe(false)
      expect(isPlanDocName('_template.html')).toBe(false)
      expect(isPlanDocName('.hidden.html')).toBe(false)
      expect(isPlanDocName('script.js')).toBe(false)
      expect(isPlanDocName('data.json')).toBe(false)
      expect(isPlanDocName('')).toBe(false)
    })
  })

  describe('isAllowedPlanDocumentPath - Top Level', () => {
    it('allows valid plan documents across all 7 canonical directories', () => {
      for (const dir of PLAN_DOC_DIRS) {
        mkdirSync(join(tempWorkspace, dir), { recursive: true })
        writeFileSync(join(tempWorkspace, dir, 'doc.html'), '<html></html>')
        expect(isAllowedPlanDocumentPath(`${dir}/doc.html`, tempWorkspace)).toBe(true)
      }
    })

    it('rejects disallowed filenames in top-level plan directories', () => {
      const dir = '.agent-team/plans'
      mkdirSync(join(tempWorkspace, dir), { recursive: true })
      writeFileSync(join(tempWorkspace, dir, '_template.html'), 'template')
      writeFileSync(join(tempWorkspace, dir, '.secret.html'), 'secret')
      writeFileSync(join(tempWorkspace, dir, 'notes.txt'), 'notes')

      expect(isAllowedPlanDocumentPath(`${dir}/_template.html`, tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath(`${dir}/.secret.html`, tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath(`${dir}/notes.txt`, tempWorkspace)).toBe(false)
    })

    it('rejects paths outside canonical plan directories', () => {
      mkdirSync(join(tempWorkspace, 'src/plans'), { recursive: true })
      writeFileSync(join(tempWorkspace, 'src/plans/feature.html'), 'html')
      expect(isAllowedPlanDocumentPath('src/plans/feature.html', tempWorkspace)).toBe(false)
    })

    it('rejects invalid, absolute, or traversal inputs', () => {
      expect(isAllowedPlanDocumentPath('', tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath('   ', tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath('/etc/passwd', tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath('C:/test/doc.html', tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath('.agent-team/plans/\0evil.html', tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath('../../etc/passwd', tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath('.agent-team/plans/../secrets.txt', tempWorkspace)).toBe(false)
    })

    it('directly rejects raw absolute paths even when shaped like a plan directory', () => {
      expect(isAllowedPlanDocumentPath('/ws/.agent-team/plans/p.html', tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath('/.agent-team/plans/p.html', tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath('\\.agent-team\\plans\\p.html', tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath('C:/.agent-team/plans/p.html', tempWorkspace)).toBe(false)
      expect(isAllowedPlanDocumentPath('D:\\.agent-team\\plans\\p.html', tempWorkspace)).toBe(false)
    })

    it('allows top-level plan document immediately without failing on unreadable sibling directories', () => {
      const dir = '.agent-team/plans'
      mkdirSync(join(tempWorkspace, dir), { recursive: true })
      writeFileSync(join(tempWorkspace, dir, 'p.html'), '<html></html>')
      const unreadableDir = join(tempWorkspace, 'unreadable')
      mkdirSync(unreadableDir, { recursive: true })
      try {
        chmodSync(unreadableDir, 0o000)
      } catch {}
      try {
        expect(isAllowedPlanDocumentPath(`${dir}/p.html`, tempWorkspace)).toBe(true)
      } finally {
        try {
          chmodSync(unreadableDir, 0o755)
        } catch {}
      }
    })
  })

  describe('isAllowedPlanDocumentPath - Nested Repositories', () => {
    it('allows plan documents when nested repository has a genuine .git directory', () => {
      const nestedRepo = join(tempWorkspace, 'packages/nested-app')
      const gitDir = join(nestedRepo, '.git')
      const planDir = join(nestedRepo, '.agent-team/plans')
      mkdirSync(gitDir, { recursive: true })
      mkdirSync(planDir, { recursive: true })
      writeFileSync(join(planDir, 'feature.html'), '<html></html>')

      expect(
        isAllowedPlanDocumentPath('packages/nested-app/.agent-team/plans/feature.html', tempWorkspace),
      ).toBe(true)
    })

    it('allows plan documents in nested repo with spaces or unicode characters', () => {
      const nestedRepo = join(tempWorkspace, 'packages/專案 repo')
      const gitDir = join(nestedRepo, '.git')
      const planDir = join(nestedRepo, 'docs/plans')
      mkdirSync(gitDir, { recursive: true })
      mkdirSync(planDir, { recursive: true })
      writeFileSync(join(planDir, '設計.plan.md'), '# 設計')

      expect(
        isAllowedPlanDocumentPath('packages/專案 repo/docs/plans/設計.plan.md', tempWorkspace),
      ).toBe(true)
    })

    it('rejects nested candidates where .git is a FILE (submodule or worktree)', () => {
      const subRepo = join(tempWorkspace, 'packages/submodule-app')
      const planDir = join(subRepo, '.agent-team/plans')
      mkdirSync(planDir, { recursive: true })
      // Simulate submodule or linked worktree .git file:
      writeFileSync(join(subRepo, '.git'), 'gitdir: ../../.git/modules/submodule-app\n')
      writeFileSync(join(planDir, 'feature.html'), '<html></html>')

      expect(
        isAllowedPlanDocumentPath('packages/submodule-app/.agent-team/plans/feature.html', tempWorkspace),
      ).toBe(false)
    })

    it('rejects nested candidates that have no .git at all', () => {
      const normalFolder = join(tempWorkspace, 'packages/plain-lib')
      const planDir = join(normalFolder, '.agent-team/plans')
      mkdirSync(planDir, { recursive: true })
      writeFileSync(join(planDir, 'feature.html'), '<html></html>')

      expect(
        isAllowedPlanDocumentPath('packages/plain-lib/.agent-team/plans/feature.html', tempWorkspace),
      ).toBe(false)
    })

    it('rejects candidate nested repository deeper than MAX_NESTED_ROOT_DEPTH (depth 3)', () => {
      const deepRepo = join(tempWorkspace, 'a/b/c')
      mkdirSync(join(deepRepo, '.git'), { recursive: true })
      mkdirSync(join(deepRepo, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(deepRepo, '.agent-team/plans/deep.html'), '<html></html>')

      expect(
        isAllowedPlanDocumentPath('a/b/c/.agent-team/plans/deep.html', tempWorkspace),
      ).toBe(false)
    })

    it('rejects candidate nested repository inside noise directories', () => {
      const noiseRepo = join(tempWorkspace, 'node_modules/dep')
      mkdirSync(join(noiseRepo, '.git'), { recursive: true })
      mkdirSync(join(noiseRepo, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(noiseRepo, '.agent-team/plans/dep.html'), '<html></html>')

      expect(
        isAllowedPlanDocumentPath('node_modules/dep/.agent-team/plans/dep.html', tempWorkspace),
      ).toBe(false)
    })

    it('continues descent when candidate .git is a file (submodule) and allows valid inner repo', () => {
      const submoduleDir = join(tempWorkspace, 'submodule')
      mkdirSync(submoduleDir, { recursive: true })
      writeFileSync(join(submoduleDir, '.git'), 'gitdir: ../../.git/modules/submodule\n')

      const innerRepo = join(submoduleDir, 'inner-repo')
      mkdirSync(join(innerRepo, '.git'), { recursive: true })
      mkdirSync(join(innerRepo, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(innerRepo, '.agent-team/plans/inner.html'), '<html></html>')

      expect(
        isAllowedPlanDocumentPath('submodule/inner-repo/.agent-team/plans/inner.html', tempWorkspace),
      ).toBe(true)
      expect(
        isAllowedPlanDocumentPath('submodule/.agent-team/plans/sub.html', tempWorkspace),
      ).toBe(false)
    })

    it('enforces deterministic 50-root limit using utf8 bytes ascending order with case-differing names', () => {
      // Create 49 repositories R00 through R48 (starting with 'R' 0x52, second char '0'-'4' 0x30-0x34)
      for (let i = 0; i < 49; i++) {
        const name = `R${i.toString().padStart(2, '0')}`
        const repoPath = join(tempWorkspace, name)
        mkdirSync(join(repoPath, '.git'), { recursive: true })
        mkdirSync(join(repoPath, '.agent-team/plans'), { recursive: true })
        writeFileSync(join(repoPath, '.agent-team/plans/p.html'), '<html></html>')
      }

      // 50th candidate: Repo-Alpha (starts with 'R' 0x52, second char 'e' 0x65 > '0'-'4')
      const repoAlpha = join(tempWorkspace, 'Repo-Alpha')
      mkdirSync(join(repoAlpha, '.git'), { recursive: true })
      mkdirSync(join(repoAlpha, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(repoAlpha, '.agent-team/plans/p.html'), '<html></html>')

      // 51st candidate: repo-alpha (starts with 'r' 0x72 > 0x52)
      const repoAlphaLower = join(tempWorkspace, 'repo-alpha')
      mkdirSync(join(repoAlphaLower, '.git'), { recursive: true })
      mkdirSync(join(repoAlphaLower, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(repoAlphaLower, '.agent-team/plans/p.html'), '<html></html>')

      // 50th repo is accepted in utf8 bytes ascending order
      expect(
        isAllowedPlanDocumentPath('Repo-Alpha/.agent-team/plans/p.html', tempWorkspace),
      ).toBe(true)

      // 51st repo is rejected as it falls outside the 50-root limit
      expect(
        isAllowedPlanDocumentPath('repo-alpha/.agent-team/plans/p.html', tempWorkspace),
      ).toBe(false)
    })

    it('enforces 2000 directory entry cap with 2001 candidate dirs (d0000..d1998, r0000-within, z0000-beyond)', () => {
      // 1,999 non-repo directories d0000 through d1998
      for (let i = 0; i < 1999; i++) {
        const name = `d${i.toString().padStart(4, '0')}`
        mkdirSync(join(tempWorkspace, name))
      }

      // 2,000th candidate directory with .git: r0000-within ('d' < 'r' < 'z')
      const repoWithin = join(tempWorkspace, 'r0000-within')
      mkdirSync(join(repoWithin, '.git'), { recursive: true })
      mkdirSync(join(repoWithin, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(repoWithin, '.agent-team/plans/p.html'), '<html></html>')

      // 2,001st candidate directory with .git: z0000-beyond
      const repoBeyond = join(tempWorkspace, 'z0000-beyond')
      mkdirSync(join(repoBeyond, '.git'), { recursive: true })
      mkdirSync(join(repoBeyond, '.agent-team/plans'), { recursive: true })
      writeFileSync(join(repoBeyond, '.agent-team/plans/p.html'), '<html></html>')

      // r0000-within is discovered within 2000-entry cap
      expect(
        isAllowedPlanDocumentPath('r0000-within/.agent-team/plans/p.html', tempWorkspace),
      ).toBe(true)

      // z0000-beyond is excluded beyond 2000-entry cap
      expect(
        isAllowedPlanDocumentPath('z0000-beyond/.agent-team/plans/p.html', tempWorkspace),
      ).toBe(false)
    })
  })

  describe('isAllowedPlanDocumentPath - Security & Symlink Containment', () => {
    it('rejects when workspace contains a symlink pointing outside workspace to external plan doc', () => {
      // Create external plan directory & file
      const extPlanDir = join(externalDir, '.agent-team/plans')
      mkdirSync(extPlanDir, { recursive: true })
      writeFileSync(join(extPlanDir, 'escaped.html'), '<html>escaped</html>')

      // Symlink external directory into workspace
      symlinkSync(extPlanDir, join(tempWorkspace, 'linked-plans'), 'dir')

      expect(
        isAllowedPlanDocumentPath('linked-plans/escaped.html', tempWorkspace),
      ).toBe(false)
    })

    it('rejects when nested repo .git is a symlink pointing outside workspace', () => {
      const nestedRepo = join(tempWorkspace, 'packages/fake-repo')
      const planDir = join(nestedRepo, '.agent-team/plans')
      mkdirSync(planDir, { recursive: true })
      writeFileSync(join(planDir, 'doc.html'), '<html></html>')

      // Create external git directory and symlink it into nestedRepo
      const extGitDir = join(externalDir, 'external-git')
      mkdirSync(extGitDir, { recursive: true })
      symlinkSync(extGitDir, join(nestedRepo, '.git'), 'dir')

      expect(
        isAllowedPlanDocumentPath('packages/fake-repo/.agent-team/plans/doc.html', tempWorkspace),
      ).toBe(false)
    })
  })
})
