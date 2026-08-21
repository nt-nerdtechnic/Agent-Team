/** Host adapter for the public plugin archive path policy. */

export type {
  ArchivePathKind,
  PortableArchiveEntry,
  PortableArchiveValidationIssue,
} from '../../../packages/plugin-contracts/src/archive'
export {
  canonicalArchivePath,
  canonicalHtmlPath,
  canonicalPackagePath,
  comparePortableArchivePaths,
  portableArchiveCollisionKey,
  validatePortableArchiveEntries,
} from '../../../packages/plugin-contracts/src/archive'
