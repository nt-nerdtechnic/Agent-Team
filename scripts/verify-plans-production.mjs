import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageDirectory = join(repositoryRoot, 'dist-plugins/navide-plans')
const backendDirectory = join(packageDirectory, 'backend')
const fixtureDirectory = join(repositoryRoot, 'dist-test-fixtures/plans/backend')
const suffix = process.platform === 'win32' ? '.exe' : ''
const executableName = `navide-plans${suffix}`

function regularFile(path) {
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) {
    throw new Error(`Expected a nonempty regular build artifact: ${path}`)
  }
  return readFileSync(path)
}

regularFile(join(repositoryRoot, 'dist-plugins/plans/index.html'))
regularFile(join(packageDirectory, 'frontend/left/index.html'))
regularFile(join(packageDirectory, 'frontend/window/index.html'))
const manifest = JSON.parse(regularFile(join(packageDirectory, 'manifest.json')).toString('utf8'))
if (manifest.backend?.entry !== 'backend/navide-plans') {
  throw new Error('Production Plans manifest must select its packaged backend.')
}
const entries = readdirSync(backendDirectory)
if (entries.length !== 1 || entries[0] !== executableName) {
  throw new Error('Production Plans backend contains unexpected artifacts, including possible test fixtures.')
}
const executable = regularFile(join(backendDirectory, executableName))
if (executable[0] === 0x23 && executable[1] === 0x21) {
  throw new Error('Production Plans backend must be a packaged executable, not a script.')
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const productionDigest = digest(executable)
for (const fixture of [`navide-plans${suffix}`, `navide-plans-go${suffix}`]) {
  if (digest(regularFile(join(fixtureDirectory, fixture))) === productionDigest) {
    throw new Error(`Production Plans backend was replaced by the test-only fixture: ${fixture}`)
  }
}
console.log('Production Plans backend is present and excludes packaged test fixtures.')
