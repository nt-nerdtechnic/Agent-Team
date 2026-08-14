export type PluginPermissionGrant =
  | { permission: 'fs'; access: 'read' }
  | { permission: 'storage'; access: 'read' | 'write' }
  | { permission: 'ui'; access: 'openInEditor' | 'openExternal' }

export type PluginCapabilityPolicy =
  | { kind: 'legacy'; requires: readonly string[] }
  | { kind: 'manifest-v2'; grants: readonly PluginPermissionGrant[] }

export function legacyCapabilityPolicy(requires: readonly string[]): PluginCapabilityPolicy {
  return { kind: 'legacy', requires: [...requires] }
}

export function manifestV2CapabilityPolicy(
  permissions: Readonly<Record<string, readonly string[]>>
): PluginCapabilityPolicy {
  const grants: PluginPermissionGrant[] = []
  for (const [permission, accesses] of Object.entries(permissions)) {
    for (const access of accesses) {
      if (permission === 'fs' && access === 'read') grants.push({ permission, access })
      else if (permission === 'storage' && (access === 'read' || access === 'write')) {
        grants.push({ permission, access })
      } else if (permission === 'ui' && (access === 'openInEditor' || access === 'openExternal')) {
        grants.push({ permission, access })
      }
    }
  }
  return { kind: 'manifest-v2', grants }
}

export function formatPermissionGrant(grant: PluginPermissionGrant): string {
  return `${grant.permission}:${grant.access}`
}
