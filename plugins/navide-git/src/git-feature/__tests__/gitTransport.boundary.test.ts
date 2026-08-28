import { readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const featureSourceRoot = fileURLToPath(new URL('../', import.meta.url))
const testSourceRoot = join(featureSourceRoot, '__tests__')
const boundaryTestPath = fileURLToPath(new URL('./gitTransport.boundary.test.ts', import.meta.url))

const testBareSpecifiers = new Set([
  'vitest',
  'node:fs',
  'node:path',
  'node:url',
])

const importSpecifierPatterns = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
]

const forbiddenGlobalPatterns = [/window\.nav/]

function collectTypeScriptSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) return collectTypeScriptSources(entryPath)
      if (!entry.isFile() || !entryPath.endsWith('.ts') || entryPath === boundaryTestPath) return []
      return [entryPath]
    })
    .sort()
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

function isTestSource(sourcePath: string): boolean {
  return isWithin(testSourceRoot, sourcePath)
}

function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const pattern of importSpecifierPatterns) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

function isAllowedFeatureImport(sourcePath: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) {
    return isTestSource(sourcePath) && testBareSpecifiers.has(specifier)
  }

  return isWithin(featureSourceRoot, resolve(dirname(sourcePath), specifier))
}

const featureSources = collectTypeScriptSources(featureSourceRoot)

const forbiddenImportFixtures = [
  "import { useGit } from '../../../../src/renderer/src/composables/useGit'",
  "import { GitPane } from '../../../../src/renderer/src/components/GitPane.vue'",
  "export { createWsClient } from '../../../../src/shared/wsClient.js'",
  "const load = () => import('electron/renderer')",
  "import { ref } from 'vue'",
  "import { callCapability } from '@navide/plugin-sdk'",
]

describe('Git feature dependency boundary', () => {
  it('rejects imports outside the feature root and unapproved bare specifiers', () => {
    const productionSourcePath = join(featureSourceRoot, 'gitTransport.ts')

    for (const fixture of forbiddenImportFixtures) {
      const [specifier] = collectImportSpecifiers(fixture)
      expect(specifier, fixture).toBeDefined()
      expect(isAllowedFeatureImport(productionSourcePath, specifier), fixture).toBe(false)
    }
  })

  it('allows feature-local imports and the narrow test-only dependency set', () => {
    const productionSourcePath = join(featureSourceRoot, 'gitTransport.ts')
    const testSourcePath = join(testSourceRoot, 'gitTransport.test.ts')

    expect(isAllowedFeatureImport(productionSourcePath, './gitTransport')).toBe(true)
    expect(isAllowedFeatureImport(testSourcePath, './gitTransport.contract')).toBe(true)
    expect(isAllowedFeatureImport(testSourcePath, 'vitest')).toBe(true)
    expect(isAllowedFeatureImport(testSourcePath, 'node:fs')).toBe(true)
    expect(isAllowedFeatureImport(productionSourcePath, 'vitest')).toBe(false)
  })

  it('does not import outside the feature root or use unapproved bare specifiers', () => {
    for (const sourcePath of featureSources) {
      const source = readFileSync(sourcePath, 'utf8')
      for (const specifier of collectImportSpecifiers(source)) {
        expect(isAllowedFeatureImport(sourcePath, specifier), `${sourcePath}: ${specifier}`).toBe(true)
      }
    }
  })

  it('does not access the Host renderer global', () => {
    for (const sourcePath of featureSources) {
      const source = readFileSync(sourcePath, 'utf8')
      for (const forbiddenGlobal of forbiddenGlobalPatterns) {
        expect(source, sourcePath).not.toMatch(forbiddenGlobal)
      }
    }
  })
})
