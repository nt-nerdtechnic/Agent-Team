import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function file(root: string, relative: string, content: string): string {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'navide-plans-build-'))
  roots.push(root)
  file(root, 'plugins/navide-plans/backend/plans_backend.py', '# production source\n')
  file(root, 'backend/pyproject.toml', '# build dependencies\n')
  file(root, 'backend/uv.lock', '# pinned toolchain\n')
  file(root, 'scripts/build-plans-v2-backend.mjs', readFileSync('scripts/build-plans-v2-backend.mjs', 'utf8'))
  const uv = file(root, 'bin/uv', `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync('build-calls', 'build\\n');
if (process.env.NAVIDE_TEST_FAIL_BUILD) process.exit(1);
const destination = process.argv[process.argv.indexOf('--distpath') + 1];
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, process.platform === 'win32' ? 'navide-plans.exe' : 'navide-plans'), 'MZproduction-binary');
`)
  chmodSync(uv, 0o755)
  return root
}

function build(root: string, conditional = true, environment: Record<string, string> = {}): void {
  execFileSync(process.execPath, [join(root, 'scripts/build-plans-v2-backend.mjs'), ...(conditional ? ['--if-needed'] : [])], {
    cwd: root,
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, ...environment },
    stdio: 'pipe',
  })
}

function buildCount(root: string): number {
  return readFileSync(join(root, 'build-calls'), 'utf8').trim().split('\n').length
}

describe('Plans backend build cache', () => {
  it('skips unchanged development builds and rebuilds changed inputs or missing output', () => {
    const root = fixture()
    build(root)
    build(root)
    expect(buildCount(root)).toBe(1)
    file(root, 'plugins/navide-plans/backend/plans_backend.py', '# changed production source\n')
    build(root)
    expect(buildCount(root)).toBe(2)
    file(root, 'backend/uv.lock', '# changed toolchain\n')
    build(root)
    expect(buildCount(root)).toBe(3)
    rmSync(join(root, 'dist-plugins/navide-plans/backend'), { recursive: true })
    build(root)
    expect(buildCount(root)).toBe(4)
  })

  it('rebuilds altered output and never caches a failed build; release builds remain unconditional', () => {
    const root = fixture()
    build(root)
    file(root, 'dist-plugins/navide-plans/backend/navide-plans', 'MZaltered-output')
    build(root)
    expect(buildCount(root)).toBe(2)
    build(root, false)
    expect(buildCount(root)).toBe(3)
    expect(() => build(root, false, { NAVIDE_TEST_FAIL_BUILD: '1' })).toThrow()
    build(root)
    expect(buildCount(root)).toBe(5)
  })
})

describe('production Plans CI fixture exclusion', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
  const command = workflow.jobs.plans.steps.find((step: { name?: string }) => step.name === 'Verify production Plans bundle excludes fixture').run as string

  function check(contamination?: 'extra' | 'replacement', fixtures = true): ReturnType<typeof spawnSync> {
    const root = fixture()
    const pnpm = file(root, 'bin/pnpm', '#!/bin/sh\nexit 0\n')
    chmodSync(pnpm, 0o755)
    file(root, 'dist-plugins/plans/index.html', '<html>Legacy</html>')
    file(root, 'dist-plugins/navide-plans/frontend/left/index.html', '<html>Plans</html>')
    file(root, 'dist-plugins/navide-plans/frontend/window/index.html', '<html>Plans window</html>')
    file(root, 'dist-plugins/navide-plans/manifest.json', JSON.stringify({ backend: { entry: 'backend/navide-plans' } }))
    const production = file(root, 'dist-plugins/navide-plans/backend/navide-plans', 'MZproduction-binary')
    chmodSync(production, 0o755)
    if (fixtures) {
      const packagedFixture = file(root, 'dist-test-fixtures/plans/backend/navide-plans', 'MZtest-only-fixture')
      file(root, 'dist-test-fixtures/plans/backend/navide-plans-go', 'MZtest-only-go-fixture')
      if (contamination) copyFileSync(packagedFixture, contamination === 'extra'
        ? join(root, 'dist-plugins/navide-plans/backend/copied-fixture')
        : production)
    }
    if (existsSync('scripts/verify-plans-production.mjs')) {
      copyFileSync('scripts/verify-plans-production.mjs', join(root, 'scripts/verify-plans-production.mjs'))
    }
    return spawnSync('/bin/sh', ['-ec', command], {
      cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8',
    })
  }

  it('accepts the production executable alongside separate test fixtures', () => {
    const result = check()
    expect(result.status, String(result.stderr)).toBe(0)
  })

  it.each(['extra', 'replacement'] as const)('rejects a fixture copied into the production backend (%s)', (contamination) => {
    const result = check(contamination)
    expect(result.status).not.toBe(0)
  })

  it('passes in a job that ships the artifact without building the test fixtures', () => {
    // The comparison is evidence when a fixture exists; its absence is not
    // evidence of a swap, and must not fail a job whose whole purpose is to
    // verify a shipped build.
    const result = check(undefined, false)
    expect(result.status, String(result.stderr)).toBe(0)
  })
})

describe('release workflow verifies the Plans artifact it signs', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'))
  const steps = workflow.jobs['release-macos-arm64'].steps as Array<{ name?: string; run?: string }>
  const buildStep = steps.find((step) => step.name === 'Build, sign & notarize application')?.run ?? ''
  const verifyStep = steps.find((step) => step.name === 'Verify signature & notarization')?.run ?? ''

  it('runs the production Plans verifier before signing', () => {
    expect(buildStep).toContain('node scripts/verify-plans-production.mjs')
    // Ahead of electron-builder: an empty backend must fail the release before
    // the notarization leg, not silently ship.
    expect(buildStep.indexOf('verify-plans-production.mjs'))
      .toBeLessThan(buildStep.indexOf('pnpm exec electron-builder'))
  })

  it('asserts the signed app actually carries the packaged Plans backend', () => {
    expect(verifyStep).toContain('Contents/Resources/plugins/navide-plans/backend/navide-plans')
  })
})
