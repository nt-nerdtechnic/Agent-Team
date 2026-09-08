import {
  PLANS_STORAGE_KEYS,
  type LegacyPlansPreferenceProjection,
} from '../../shared/plansPreferences'
import type {
  PlansLegacyRecoveryAdapter,
  PlansLegacyRecoveryContext,
} from './plansStorageMigration'

/** Host-to-renderer state used to seed the retained Plans adapter. Storage
 * identity stays in the Host recovery result and is never exposed here. */
export interface PlansLegacyRecoveryBootstrap {
  readonly preferences: LegacyPlansPreferenceProjection
}

function legacyPreferenceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  if (!Array.isArray(value)) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** The production adapter for the retained legacy Plans renderer. It reads
 * only the fixed preference projection from the Host-selected previous
 * snapshot; document reads and all document mutations remain on the existing
 * legacy workspace backend route. */
export const retainedPlansLegacyAdapter: PlansLegacyRecoveryAdapter<PlansLegacyRecoveryBootstrap> =
  Object.freeze({
    async bind(context: PlansLegacyRecoveryContext): Promise<PlansLegacyRecoveryBootstrap> {
      const entries = await Promise.all(
        PLANS_STORAGE_KEYS.map(async (key) => [key, await context.readPreference(key)] as const),
      )
      const preferences: LegacyPlansPreferenceProjection = {}
      for (const [key, result] of entries) {
        if (!result.found) continue
        const value = legacyPreferenceString(result.value)
        if (value !== undefined) preferences[key] = value
      }
      return Object.freeze({ preferences: Object.freeze(preferences) })
    },
  })
