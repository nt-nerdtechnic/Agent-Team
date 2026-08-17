import {
  parseManifestJson as parsePublicManifestJson,
  PluginContractError,
} from '../../../packages/plugin-contracts/src/index'
import { InstalledPluginError } from './pluginManifestErrors'

/**
 * Host adapter preserving the Host error type while delegating duplicate-key
 * and JSON validation to the public contracts package.
 */
export function parseManifestJson(text: string): Record<string, unknown> {
  try {
    return parsePublicManifestJson(text)
  } catch (error) {
    if (error instanceof PluginContractError) {
      throw new InstalledPluginError(error.message)
    }
    throw error
  }
}
