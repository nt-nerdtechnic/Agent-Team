/**
 * The only legacy Plans preferences that may cross from the trusted renderer
 * into the Host-owned v2 storage migration.
 */
export const PLANS_STORAGE_KEYS = [
  'plans.filter',
  'plans.sort',
  'plans.sortdir',
  'plans.group',
  'plans.collapsed',
  'plans.recent',
  'plans.pinned',
] as const

export type PlansStorageKey = (typeof PLANS_STORAGE_KEYS)[number]

export type LegacyPlansPreferenceProjection = Partial<Record<PlansStorageKey, string>>

export const PLANS_LEGACY_SUFFIXES: Readonly<Record<PlansStorageKey, string>> = {
  'plans.filter': 'filter',
  'plans.sort': 'sort',
  'plans.sortdir': 'sortdir',
  'plans.group': 'group',
  'plans.collapsed': 'collapsed',
  'plans.recent': 'recent',
  'plans.pinned': 'pinned',
}

export function legacyPlansPreferenceStorageKey(
  key: PlansStorageKey,
  workspacePath: string,
): string {
  return `navide.plans.${PLANS_LEGACY_SUFFIXES[key]}.${workspacePath}`
}
