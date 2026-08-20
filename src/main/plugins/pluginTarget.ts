/** Existing Registry target wire values bound to the current Host runtime. */
export const UNIVERSAL_PLUGIN_TARGET = 'universal'

export function currentPluginHostTarget(): string {
  return `${process.platform}-${process.arch}`
}

export function isPluginTargetCompatible(
  target: unknown,
  expectedTarget = currentPluginHostTarget()
): target is string {
  return target === UNIVERSAL_PLUGIN_TARGET || target === expectedTarget
}

export function assertPluginTargetCompatible(
  target: unknown,
  expectedTarget = currentPluginHostTarget()
): asserts target is string {
  if (!isPluginTargetCompatible(target, expectedTarget)) {
    throw new Error(`plugin target '${String(target)}' is not compatible with host target '${expectedTarget}'`)
  }
}
