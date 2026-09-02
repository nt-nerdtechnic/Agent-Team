import {
  PLANS_STORAGE_KEYS,
  legacyPlansPreferenceStorageKey,
  type LegacyPlansPreferenceProjection,
  type PlansStorageKey,
} from '../../../shared/plansPreferences'

export { PLANS_STORAGE_KEYS }
export type { LegacyPlansPreferenceProjection, PlansStorageKey }

/** The Host marks retained legacy windows and the main recovery renderer with
 * this boot flag. Recovery must not project values back into v2 storage. */
export function isLegacyPlansRecoveryRuntime(): boolean {
  return typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('legacy_plans_recovery') === '1'
}

/** Read only the fixed legacy Plans key projection from the trusted renderer. */
export function readLegacyPlansPreferenceProjection(
  workspacePath: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
): LegacyPlansPreferenceProjection {
  const values: LegacyPlansPreferenceProjection = {}
  for (const key of PLANS_STORAGE_KEYS) {
    const value = storage.getItem(legacyPlansPreferenceStorageKey(key, workspacePath))
    if (value !== null) values[key] = value
  }
  return values
}
