import type { JsonValue } from '../../../packages/plugin-contracts/src/index'

/** Maximum number of nested JSON containers accepted by the Host boundary. */
export const MAX_JSON_DEPTH = 128

export interface NormalizedJsonValue {
  value: JsonValue
  json: string
  bytes: number
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Validate and canonicalize one JSON value in a bounded traversal.
 *
 * The returned tree is newly allocated, has sorted object keys, and contains
 * no accessors or inherited behavior. That makes the following stringify a
 * single canonicalization pass instead of recursively sorting from a
 * stringify replacer. Invalid values, cycles, proxies that throw, and values
 * deeper than MAX_JSON_DEPTH all return null rather than escaping an error.
 */
export function normalizeJsonValue(input: unknown): NormalizedJsonValue | null {
  try {
    const ancestors = new Set<object>()
    const normalized = visit(input, 0, ancestors)
    if (normalized === undefined) return null
    const json = JSON.stringify(normalized)
    return { value: normalized, json, bytes: utf8ByteLength(json) }
  } catch {
    return null
  }
}

export function isJsonValue(input: unknown): input is JsonValue {
  return normalizeJsonValue(input) !== null
}

function visit(value: unknown, depth: number, ancestors: Set<object>): JsonValue | undefined {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object') return undefined

  const object = value as object
  const containerDepth = depth + 1
  if (containerDepth > MAX_JSON_DEPTH || ancestors.has(object)) return undefined
  ancestors.add(object)
  try {
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value)
      if (names.some((name) => name !== 'length' && !isArrayIndex(name, value.length))) {
        return undefined
      }
      const result: JsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return undefined
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return undefined
        const item = visit(descriptor.value, containerDepth, ancestors)
        if (item === undefined) return undefined
        result.push(item)
      }
      return result
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined
    const names = Object.getOwnPropertyNames(value)
    const keys = names.sort()
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return undefined
      const child = visit(descriptor.value, containerDepth, ancestors)
      if (child === undefined) return undefined
      result[key] = child
    }
    return result
  } finally {
    ancestors.delete(object)
  }
}

function isArrayIndex(name: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(name)) return false
  const index = Number(name)
  return Number.isSafeInteger(index) && index < length
}
