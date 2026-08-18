import { describe, expect, it } from 'vitest'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { planPublicCapabilityCall } from './pluginCapabilityBroker'
import { readManifestFromEntries, readZipEntries } from './pluginPackage'
import { manifestV2CapabilityPolicy } from './pluginPermissions'

type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
}

function packageManager(): { command: string; prefix: string[] } {
  const configured = process.env.NAVIDE_PNPM ?? process.env.npm_execpath
  if (!configured) return { command: 'pnpm', prefix: [] }
  if (configured.endsWith('.js') || configured.endsWith('.cjs')) {
    return { command: process.execPath, prefix: [configured] }
  }
  return { command: configured, prefix: [] }
}

function subprocessEnvironment(): NodeJS.ProcessEnv {
  const nodeDirectory = dirname(process.execPath)
  return {
    ...process.env,
    CI: '1',
    PNPM_CONFIG_PM_ON_FAIL: 'ignore',
    PATH: `${nodeDirectory}:${process.env.PATH ?? ''}`,
  }
}

function runPnpm(args: string[], cwd: string): CommandResult {
  const invocation = packageManager()
  const result = spawnSync(invocation.command, [...invocation.prefix, ...args], {
    cwd,
    encoding: 'utf8',
    env: subprocessEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function runPnpmOrThrow(args: string[], cwd: string): CommandResult {
  const result = runPnpm(args, cwd)
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`
    )
  }
  return result
}

function runNpmOrThrow(args: string[], cwd: string, cacheDirectory: string): CommandResult {
  const result = spawnSync(join(dirname(process.execPath), 'npm'), args, {
    cwd,
    encoding: 'utf8',
    env: { ...subprocessEnvironment(), npm_config_cache: cacheDirectory },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(' ')} failed in ${cwd}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
    )
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function runExternalCli(args: string[], cwd: string): CommandResult {
  const bin = join(cwd, 'node_modules', '.bin', 'navide-plugin')
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    env: subprocessEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function writeManifest(directory: string, manifest: unknown): void {
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

describe('third-party plugin external workspace', () => {
  it(
    'installs public packages, validates/types/builds/packages the example, and enforces Host capability denial',
    async () => {
      const repository = process.cwd()
      const temporaryRoot = mkdtempSync(join(tmpdir(), 'navide-plugin-external-'))
      const artifacts = join(temporaryRoot, 'artifacts')
      const externalProject = join(temporaryRoot, 'example')
      try {
        mkdirSync(artifacts)
        for (const schemaName of ['plugin-manifest-v2.schema.json', 'capabilities-v1.json']) {
          expect(
            readFileSync(join(repository, 'packages', 'plugin-contracts', 'src', 'schemas', schemaName), 'utf8')
          ).toBe(readFileSync(join(repository, 'docs', 'plugin-contracts', schemaName), 'utf8'))
        }
        for (const packageName of ['plugin-contracts', 'plugin-sdk', 'plugin-ui']) {
          const packageJson = readFileSync(
            join(repository, 'packages', packageName, 'package.json'),
            'utf8'
          )
          expect(packageJson).not.toContain('workspace:')
          expect(packageJson).not.toContain('packages/features')
        }
        runPnpmOrThrow(['run', 'build:public-packages'], repository)

        const packageTarballs: Record<string, string> = {}
        for (const packageName of ['plugin-contracts', 'plugin-sdk', 'plugin-ui']) {
          const packageDirectory = join(repository, 'packages', packageName)
          const result = runPnpmOrThrow(
            ['pack', '--pack-destination', artifacts],
            packageDirectory
          )
          const tarball = result.stdout
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.endsWith('.tgz'))
          if (!tarball) throw new Error(`pnpm pack did not report a tarball for ${packageName}`)
          packageTarballs[`@navide/${packageName}`] = realpathSync(
            tarball.startsWith('/') ? tarball : join(packageDirectory, tarball)
          )
        }

        const require = createRequire(import.meta.url)
        const typescriptPackageDirectory = dirname(
          realpathSync(require.resolve('typescript/package.json'))
        )
        const typescriptPackage = runNpmOrThrow(
          ['pack', typescriptPackageDirectory, '--pack-destination', artifacts],
          repository,
          join(temporaryRoot, 'npm-cache')
        )
        const typescriptTarball = typescriptPackage.stdout
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.endsWith('.tgz'))
        if (!typescriptTarball) throw new Error('npm pack did not report a TypeScript tarball')
        const localTypeScriptTarball = realpathSync(
          typescriptTarball.startsWith('/')
            ? typescriptTarball
            : join(artifacts, typescriptTarball)
        )

        cpSync(join(repository, 'examples', 'third-party-files'), externalProject, {
          recursive: true,
        })
        const externalPackageJsonPath = join(externalProject, 'package.json')
        const externalPackageJson = JSON.parse(readFileSync(externalPackageJsonPath, 'utf8')) as {
          dependencies: Record<string, string>
          devDependencies: Record<string, string>
        }
        for (const packageName of Object.keys(packageTarballs)) {
          externalPackageJson.dependencies[packageName] = `file:${packageTarballs[packageName]}`
        }
        externalPackageJson.devDependencies.typescript = `file:${localTypeScriptTarball}`
        writeFileSync(externalPackageJsonPath, `${JSON.stringify(externalPackageJson, null, 2)}\n`)

        expect(JSON.stringify(externalPackageJson)).not.toContain('workspace:')
        expect(JSON.stringify(externalPackageJson)).not.toContain('@navide/feature-')
        expect(
          Object.values(externalPackageJson.dependencies).every((value) => value.startsWith('file:'))
        ).toBe(true)
        expect(
          Object.values(externalPackageJson.devDependencies).every((value) => value.startsWith('file:'))
        ).toBe(true)

        runPnpmOrThrow(
          ['install', '--offline', '--ignore-scripts', '--lockfile=false'],
          externalProject
        )
        runPnpmOrThrow(['run', 'typecheck'], externalProject)
        runPnpmOrThrow(['run', 'build'], externalProject)
        runPnpmOrThrow(['run', 'check'], externalProject)
        runPnpmOrThrow(['run', 'package'], externalProject)

        const archivePath = join(externalProject, 'dist', 'acme-files.vsix')
        const secondArchivePath = join(externalProject, 'dist', 'acme-files-second.vsix')
        const secondPackageResult = runExternalCli(
          ['package', join(externalProject, 'dist', 'package'), '--out', secondArchivePath],
          externalProject
        )
        expect(secondPackageResult.status).toBe(0)
        expect(readFileSync(secondArchivePath)).toEqual(readFileSync(archivePath))
        const entries = readZipEntries(readFileSync(archivePath))
        const regularPaths = entries.filter((entry) => entry.type === 'regular').map((entry) => entry.path)
        expect(regularPaths).toContain('manifest.json')
        expect(regularPaths).toContain('frontend/index.html')
        expect(regularPaths).toContain('frontend/main.js')
        expect(regularPaths.some((path) => path.startsWith('src/'))).toBe(false)
        expect(regularPaths.some((path) => path.startsWith('node_modules/'))).toBe(false)
        expect(readManifestFromEntries(entries)).toMatchObject({
          id: 'acme.files',
          permissions: { system: ['fs'] },
        })

        const validationRoot = join(temporaryRoot, 'validation-cases')
        cpSync(join(externalProject, 'dist', 'package'), validationRoot, { recursive: true })
        const contractsModule = await import(
          pathToFileURL(
            join(externalProject, 'node_modules', '@navide', 'plugin-contracts', 'dist', 'index.js')
          ).href
        )
        expect(
          contractsModule.validatePortableArchiveEntries([
            { path: 'frontend/main.js', type: 'regular' },
            { path: 'frontend/MAIN.JS', type: 'regular' },
          ])
        ).toEqual({ kind: 'duplicate', path: 'frontend/MAIN.JS' })

        const duplicateDirectory = join(validationRoot, 'duplicate')
        cpSync(join(externalProject, 'dist', 'package'), duplicateDirectory, { recursive: true })
        writeFileSync(
          join(duplicateDirectory, 'manifest.json'),
          '{"schemaVersion":2,"permissions":{},"permissions":{}}\n'
        )
        const duplicateResult = runExternalCli(['validate', duplicateDirectory], externalProject)
        expect(duplicateResult.status).not.toBe(0)
        expect(`${duplicateResult.stdout}\n${duplicateResult.stderr}`).toContain(
          'duplicate JSON object key'
        )

        const unknownDirectory = join(validationRoot, 'unknown')
        cpSync(join(externalProject, 'dist', 'package'), unknownDirectory, { recursive: true })
        const unknownManifest = JSON.parse(
          readFileSync(join(unknownDirectory, 'manifest.json'), 'utf8')
        ) as Record<string, unknown>
        unknownManifest.unknownField = true
        writeManifest(unknownDirectory, unknownManifest)
        const unknownResult = runExternalCli(['validate', unknownDirectory], externalProject)
        expect(unknownResult.status).not.toBe(0)
        expect(`${unknownResult.stdout}\n${unknownResult.stderr}`).toContain('unknown field')

        const publisherDirectory = join(validationRoot, 'publisher-mismatch')
        cpSync(join(externalProject, 'dist', 'package'), publisherDirectory, { recursive: true })
        const publisherManifest = JSON.parse(
          readFileSync(join(publisherDirectory, 'manifest.json'), 'utf8')
        ) as Record<string, unknown>
        publisherManifest.publisher = 'other'
        writeManifest(publisherDirectory, publisherManifest)
        const publisherResult = runExternalCli(['validate', publisherDirectory], externalProject)
        expect(publisherResult.status).not.toBe(0)
        expect(`${publisherResult.stdout}\n${publisherResult.stderr}`).toContain(
          'publisher must match id namespace'
        )

        const collisionDirectory = join(validationRoot, 'portable-collision')
        cpSync(join(externalProject, 'dist', 'package'), collisionDirectory, { recursive: true })
        writeFileSync(join(collisionDirectory, 'frontend', 'MAIN.JS'), 'case collision\n')
        const collisionNames = readdirSync(join(collisionDirectory, 'frontend'))
        if (collisionNames.includes('main.js') && collisionNames.includes('MAIN.JS')) {
          const collisionResult = runExternalCli(['validate', collisionDirectory], externalProject)
          expect(collisionResult.status).not.toBe(0)
          expect(`${collisionResult.stdout}\n${collisionResult.stderr}`).toContain(
            'portable archive collision'
          )
        }

        const aliasDirectory = join(validationRoot, 'portable-alias')
        cpSync(join(externalProject, 'dist', 'package'), aliasDirectory, { recursive: true })
        writeFileSync(join(aliasDirectory, 'frontend', 'alias'), 'alias\n')
        writeFileSync(join(aliasDirectory, 'frontend', 'alias.'), 'portable alias\n')
        const aliasResult = runExternalCli(['validate', aliasDirectory], externalProject)
        expect(aliasResult.status).not.toBe(0)
        expect(`${aliasResult.stdout}\n${aliasResult.stderr}`).toContain('portable archive collision')

        const unsafeDirectory = join(validationRoot, 'unsafe')
        cpSync(join(externalProject, 'dist', 'package'), unsafeDirectory, { recursive: true })
        const unsafeManifest = JSON.parse(
          readFileSync(join(unsafeDirectory, 'manifest.json'), 'utf8')
        ) as { contributes: { views: Array<Record<string, unknown>> } }
        unsafeManifest.contributes.views[0].entry = '../outside.html'
        writeManifest(unsafeDirectory, unsafeManifest)
        const unsafeResult = runExternalCli(['validate', unsafeDirectory], externalProject)
        expect(unsafeResult.status).not.toBe(0)
        expect(`${unsafeResult.stdout}\n${unsafeResult.stderr}`).toContain('safe package-relative')

        const missingDirectory = join(validationRoot, 'missing')
        cpSync(join(externalProject, 'dist', 'package'), missingDirectory, { recursive: true })
        rmSync(join(missingDirectory, 'frontend', 'index.html'))
        const missingResult = runExternalCli(['validate', missingDirectory], externalProject)
        expect(missingResult.status).not.toBe(0)
        expect(`${missingResult.stdout}\n${missingResult.stderr}`).toContain('does not exist')

        const symlinkPath = join(validationRoot, 'symlink-file')
        symlinkSync(join(externalProject, 'dist', 'package', 'frontend', 'main.js'), symlinkPath)
        const packageFilesModule = await import(
          pathToFileURL(join(repository, 'packages', 'plugin-sdk', 'bin', 'package-files.mjs')).href
        )
        expect(() => packageFilesModule.readRegularFileNoFollow(symlinkPath)).toThrow()

        const pluginModule = await import(
          `${pathToFileURL(join(externalProject, 'dist', 'package', 'frontend', 'main.js')).href}?smoke=1`
        )
        const HostPluginError = contractsModule.PluginError as new (
          code: string,
          message: string
        ) => Error & { code: string }
        const binding = {
          pluginId: 'acme.files',
          packageVersion: '1.0.0',
          workspaceId: 'workspace-1',
          instanceId: 'instance-1',
          audience: 'external',
        }
        const policy = manifestV2CapabilityPolicy({ system: ['fs'] })
        const authorization = {
          publisherEligible: false,
          userGrant: { packageVersion: '1.0.0', system: ['fs'] as const },
          runtimeBinding: binding,
        }
        let requestId = 0
        const invoke = async (address: string, params: unknown): Promise<unknown> => {
          const separator = address.indexOf('.')
          const decision = planPublicCapabilityCall(
            {
              pluginId: binding.pluginId,
              ns: address.slice(0, separator),
              method: address.slice(separator + 1),
              args: params,
              reqId: `external-${requestId++}`,
            },
            policy,
            authorization
          )
          if (decision.kind === 'deny') {
            const error = decision.response.error
            throw new HostPluginError(error?.code ?? 'INTERNAL_ERROR', error?.message ?? 'denied')
          }
          if (decision.plan.address === 'fs.readFile') return { content: 'README from Host' }
          throw new Error(`unexpected allowed capability ${decision.plan.address}`)
        }

        await pluginModule.plugin.activate({
          pluginId: binding.pluginId,
          packageVersion: binding.packageVersion,
          contributionKey: 'main',
          instanceId: binding.instanceId,
          workspaceId: binding.workspaceId,
          startupDeadlineMs: 5000,
          capabilities: { invoke },
          events: { subscribe: () => ({ dispose() {} }) },
          lifecycle: { reportProgress() {} },
          view: { hide: async () => {} },
          targets: { subscribe: () => ({ dispose() {} }) },
        })
        expect(pluginModule.lastRun).toMatchObject({
          allowedContent: 'README from Host',
          deniedCode: 'CAPABILITY_DENIED',
        })
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    },
    180_000
  )
})
