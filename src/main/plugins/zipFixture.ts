// Test-only helper: build a minimal, valid `.vsix`-style ZIP (stored / method 0,
// no compression) in memory, so the pure package reader and installer can be
// exercised without a real registry or `zip` binary. Not imported by runtime
// code. Layout matches what `pluginPackage.readZipEntries` walks.

export interface ZipFile {
  name: string
  data: Buffer | string
  /** Optional Unix entry kind used by archive-boundary tests. */
  kind?: 'file' | 'directory' | 'symlink' | 'special'
  /** Optional Unix mode; when omitted, it follows `kind`/the file name. */
  unixMode?: number
  /** ZIP creator platform encoded in the central-directory metadata. */
  creator?: 'unix' | 'dos'
  /** DOS directory attribute used when `creator` is not Unix. */
  dosDirectory?: boolean
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

/** Build a stored-method ZIP archive buffer from the given files. */
export function makeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : file.data
    const kind = file.kind ?? (file.name.endsWith('/') ? 'directory' : 'file')
    const unixMode =
      file.unixMode ??
      (kind === 'directory'
        ? 0o040755
        : kind === 'symlink'
          ? 0o120777
          : kind === 'special'
            ? 0o010644
            : 0o100644)
    const creator = file.creator ?? 'unix'
    const versionMadeBy = creator === 'unix' ? 0x0314 : 0x0014
    const externalAttributes =
      ((creator === 'unix' ? unixMode << 16 : 0) | (file.dosDirectory ? 0x10 : 0)) >>> 0

    const local = Buffer.concat([
      u32(0x04034b50), // local header sig
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: store
      u16(0), // mod time
      u16(0), // mod date
      u32(0), // crc32 (reader ignores)
      u32(data.length), // compressed size
      u32(data.length), // uncompressed size
      u16(name.length),
      u16(0), // extra len
      name,
      data,
    ])
    locals.push(local)

    const central = Buffer.concat([
      u32(0x02014b50), // central header sig
      u16(versionMadeBy), // version made by: Unix or DOS, 2.0
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method
      u16(0), // mod time
      u16(0), // mod date
      u32(0), // crc32
      u32(data.length), // compressed size
      u32(data.length), // uncompressed size
      u16(name.length),
      u16(0), // extra len
      u16(0), // comment len
      u16(0), // disk start
      u16(0), // internal attrs
      u32(externalAttributes), // Unix mode or DOS attributes
      u32(offset), // local header offset
      name,
    ])
    centrals.push(central)
    offset += local.length
  }

  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50), // EOCD sig
    u16(0), // disk num
    u16(0), // disk with cd
    u16(files.length), // entries this disk
    u16(files.length), // total entries
    u32(centralDir.length), // cd size
    u32(offset), // cd offset
    u16(0), // comment len
  ])

  return Buffer.concat([...locals, centralDir, eocd])
}
