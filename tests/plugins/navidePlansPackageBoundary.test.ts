import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const packageRoot = join(repositoryRoot, 'plugins/navide-plans')

function sourceText(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name === 'tests' || entry.name === '__pycache__') return []
      const path = join(root, entry.name)
      if (entry.isDirectory()) return sourceText(path)
      return /\.(?:ts|vue|py)$/.test(entry.name) ? [readFileSync(path, 'utf8')] : []
    })
    .join('\n')
}

describe('navide.plans production package boundary', () => {
  it('declares one combined v2 package without a public Plans permission', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'manifest.json'), 'utf8')) as {
      schemaVersion: number
      id: string
      version: string
      permissions: { system?: string[]; shell?: string }
      contributes?: { views?: Array<Record<string, unknown>> }
      backend?: { entry?: string; protocolVersion?: number; activation?: string }
    }

    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.id).toBe('navide.plans')
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.permissions.system).toEqual(['fs', 'ui', 'aiCli'])
    expect(manifest.permissions).not.toHaveProperty('plans')
    expect(manifest.permissions.shell).toBeUndefined()
    expect(manifest.contributes?.views).toEqual([
      {
        id: 'left',
        kind: 'custom',
        location: 'left',
        title: 'Plans',
        entry: 'frontend/left/index.html',
      },
      {
        id: 'window',
        kind: 'custom',
        location: 'window',
        title: 'Plans',
        entry: 'frontend/window/index.html',
      },
    ])
    expect(manifest.backend).toEqual({
      entry: 'backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
    })
  })

  it('depends only on public package APIs', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      '@navide/plugin-sdk',
      '@navide/plugin-ui',
      'vue',
    ])

    const source = sourceText(join(packageRoot, 'src'))
    expect(source).toContain('@navide/plugin-sdk')
    expect(source).toContain('@navide/plugin-ui')
    for (const privateSurface of [
      'from \'electron\'',
      'agent_team_backend',
      'src/main',
      'window.nav',
      'window.agentTeam',
      'node:child_process',
      'node:fs',
    ]) {
      expect(source, privateSurface).not.toContain(privateSurface)
    }
  })

  it('keeps the Backend Wire child on the Host-private filesystem Bridge', () => {
    const backend = readFileSync(join(packageRoot, 'backend/plans_backend.py'), 'utf8')
    expect(backend).toContain('navide/host/call')
    expect(backend).toContain('"filesystem"')
    expect(backend).not.toContain('"shell"')
    expect(backend).not.toContain('"network"')
    expect(backend).not.toContain('agentMethods')
    expect(backend).not.toContain('agent_team_backend')
  })

  it('ships both the v2 artifact and explicit legacy recovery resources', () => {
    const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
      build?: { extraResources?: Array<{ from?: string; to?: string }> }
    }
    expect(rootPackage.scripts?.['build:plans:v2']).toContain('plugins/navide-plans/vite.config.ts')
    expect(rootPackage.scripts?.['build:plans:backend']).toContain('build-plans-v2-backend.mjs')
    expect(rootPackage.scripts?.['build:plans']).toContain('build:plans:legacy')
    expect(rootPackage.scripts?.['build:plans']).toContain('build:plans:v2')
    expect(rootPackage.scripts?.['build:plans']).toContain('build:plans:backend')
    expect(rootPackage.build?.extraResources).toEqual(expect.arrayContaining([
      { from: 'dist-plugins/navide-plans', to: 'plugins/navide-plans' },
      { from: 'dist-plugins/plans', to: 'plugins/plans' },
    ]))
  })
})
