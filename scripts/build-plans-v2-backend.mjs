import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(repositoryRoot, 'plugins/navide-plans/backend/plans_backend.py')
const backendDirectory = resolve(repositoryRoot, 'dist-plugins/navide-plans/backend')
const executableName = process.platform === 'win32' ? 'navide-plans.exe' : 'navide-plans'
const executable = join(backendDirectory, executableName)
const cacheFile = resolve(repositoryRoot, 'node_modules/.cache/navide/plans-v2-backend.json')
const fingerprint = createHash('sha256')
  .update(`${process.platform}\0${process.arch}\0`)
for (const input of [source, fileURLToPath(import.meta.url), resolve(repositoryRoot, 'backend/pyproject.toml'), resolve(repositoryRoot, 'backend/uv.lock')]) {
  fingerprint.update(readFileSync(input)).update('\0')
}
const inputDigest = fingerprint.digest('hex')

function executableDigest() {
  const entry = lstatSync(executable)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0 || (process.platform !== 'win32' && (entry.mode & 0o111) === 0)) {
    throw new Error(`Plans backend output is not a regular executable: ${executable}`)
  }
  const bytes = readFileSync(executable)
  if (bytes[0] === 0x23 && bytes[1] === 0x21) {
    throw new Error(`Plans backend output is a script, not a packaged executable: ${executable}`)
  }
  return createHash('sha256').update(bytes).digest('hex')
}

if (process.argv.includes('--if-needed')) {
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (cached.inputDigest === inputDigest && cached.outputDigest === executableDigest()) {
      console.log(`Reusing unchanged production Plans backend: ${executable}`)
      process.exit(0)
    }
  } catch {
    // Missing, invalid, or changed build output must be rebuilt before use.
  }
}
// A failed build must never leave a successful cache marker behind.
rmSync(cacheFile, { force: true })
const temporaryRoot = mkdtempSync(join(tmpdir(), 'navide-plans-v2-backend-'))

try {
  mkdirSync(backendDirectory, { recursive: true })
  execFileSync(
    'uv',
    [
      '--project',
      resolve(repositoryRoot, 'backend'),
      'run',
      'pyinstaller',
      '--noconfirm',
      '--clean',
      '--onefile',
      '--name',
      'navide-plans',
      '--distpath',
      backendDirectory,
      '--workpath',
      join(temporaryRoot, 'work'),
      '--specpath',
      join(temporaryRoot, 'spec'),
      source,
    ],
    {
      cwd: repositoryRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        PYINSTALLER_CONFIG_DIR: join(temporaryRoot, 'config'),
      },
    },
  )

  const entry = lstatSync(executable)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) {
    throw new Error(`PyInstaller did not produce a regular Plans backend executable: ${executable}`)
  }
  if (process.platform !== 'win32') chmodSync(executable, entry.mode | 0o111)
  const outputDigest = executableDigest()
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, `${JSON.stringify({ inputDigest, outputDigest })}\n`)
  console.log(`Built production Plans backend: ${executable}`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
