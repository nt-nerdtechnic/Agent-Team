import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface TempTextArtifact {
  path: string
  displayName: string
}

/** Write untrusted text under a Host-chosen non-executable extension. */
export async function writeTempTextArtifact(
  tempRoot: string,
  displayName: string,
  content: string,
): Promise<TempTextArtifact> {
  const directory = join(tempRoot, 'agent-team-head')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${randomUUID()}.txt`)
  await writeFile(path, content, 'utf8')
  return { path, displayName }
}
