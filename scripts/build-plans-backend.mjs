import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// This artifact is deliberately outside dist-plugins/. It is a self-contained
// Issue 21 integration fixture, not a production Plans backend.
const source = resolve(repositoryRoot, 'src/main/plugins/test-fixtures/plans-backend-wire.py')
const goSource = resolve(repositoryRoot, 'src/main/plugins/test-fixtures/plans-backend-wire.go')
const backendDirectory = resolve(repositoryRoot, 'dist-test-fixtures/plans/backend')
const executableName = process.platform === 'win32' ? 'navide-plans.exe' : 'navide-plans'
const executable = join(backendDirectory, executableName)
const goExecutableName = process.platform === 'win32' ? 'navide-plans-go.exe' : 'navide-plans-go'
const goExecutable = join(backendDirectory, goExecutableName)
const temporaryRoot = mkdtempSync(join(tmpdir(), 'navide-plans-backend-'))

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
  if (process.platform !== 'win32') {
    chmodSync(executable, entry.mode | 0o111)
  }
  const prefix = readFileSync(executable).subarray(0, 5)
  if (prefix[0] === 0x23 && prefix[1] === 0x21) {
    throw new Error(`Plans backend output is a script, not a packaged executable: ${executable}`)
  }
  console.log(`Built packaged Plans backend fixture: ${executable}`)

  const goVersion = execFileSync('go', ['version'], { encoding: 'utf8' })
  if (!/\bgo1\.27(?:\.\d+)?\b/u.test(goVersion)) {
    throw new Error(`Plans Go fixture requires Go 1.27.x, received: ${goVersion.trim()}`)
  }
  execFileSync(
    'go',
    ['build', '-trimpath', '-o', goExecutable, goSource],
    { cwd: repositoryRoot, stdio: 'inherit' },
  )
  const goEntry = lstatSync(goExecutable)
  if (!goEntry.isFile() || goEntry.isSymbolicLink() || goEntry.size === 0) {
    throw new Error(`Go did not produce a regular Plans backend executable: ${goExecutable}`)
  }
  if (process.platform !== 'win32') {
    chmodSync(goExecutable, goEntry.mode | 0o111)
  }
  const goPrefix = readFileSync(goExecutable).subarray(0, 5)
  if (goPrefix[0] === 0x23 && goPrefix[1] === 0x21) {
    throw new Error(`Plans Go backend output is a script, not a packaged executable: ${goExecutable}`)
  }
  console.log(`Built packaged Plans backend fixture: ${goExecutable}`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
