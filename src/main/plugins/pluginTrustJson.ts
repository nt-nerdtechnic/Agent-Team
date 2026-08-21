import { readFileSync } from 'node:fs'

export type TrustJsonObject = Record<string, unknown>

function isObject(value: unknown): value is TrustJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonString(text: string, start: number): { value: string; next: number } {
  if (text[start] !== '"') throw new Error('invalid JSON string')
  let cursor = start + 1
  while (cursor < text.length) {
    const char = text[cursor++]
    if (char === '\\') {
      cursor++
      continue
    }
    if (char === '"') {
      const raw = text.slice(start, cursor)
      const value = JSON.parse(raw)
      if (typeof value !== 'string') throw new Error('invalid JSON string')
      return { value, next: cursor }
    }
    if (char < ' ') throw new Error('invalid JSON string')
  }
  throw new Error('unterminated JSON string')
}

/** Scan JSON syntax far enough to reject duplicate object keys before the
 * built-in parser can silently retain only the last value. */
function assertUniqueJsonKeys(text: string): void {
  let cursor = 0

  const skipWhitespace = (): void => {
    while (/\s/.test(text[cursor] ?? '')) cursor++
  }

  const parseValue = (): void => {
    skipWhitespace()
    const char = text[cursor]
    if (char === '{') return parseObject()
    if (char === '[') return parseArray()
    if (char === '"') {
      cursor = parseJsonString(text, cursor).next
      return
    }
    if (text.startsWith('true', cursor)) {
      cursor += 4
      return
    }
    if (text.startsWith('false', cursor)) {
      cursor += 5
      return
    }
    if (text.startsWith('null', cursor)) {
      cursor += 4
      return
    }
    const number = text
      .slice(cursor)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (number) {
      cursor += number[0].length
      return
    }
    throw new Error('invalid JSON value')
  }

  const parseObject = (): void => {
    cursor++
    skipWhitespace()
    const keys = new Set<string>()
    if (text[cursor] === '}') {
      cursor++
      return
    }
    while (cursor < text.length) {
      skipWhitespace()
      const key = parseJsonString(text, cursor)
      cursor = key.next
      if (keys.has(key.value)) {
        throw new Error(`duplicate JSON object key: ${key.value}`)
      }
      keys.add(key.value)
      skipWhitespace()
      if (text[cursor++] !== ':') throw new Error('invalid JSON object')
      parseValue()
      skipWhitespace()
      if (text[cursor] === '}') {
        cursor++
        return
      }
      if (text[cursor++] !== ',') throw new Error('invalid JSON object')
    }
    throw new Error('unterminated JSON object')
  }

  const parseArray = (): void => {
    cursor++
    skipWhitespace()
    if (text[cursor] === ']') {
      cursor++
      return
    }
    while (cursor < text.length) {
      parseValue()
      skipWhitespace()
      if (text[cursor] === ']') {
        cursor++
        return
      }
      if (text[cursor++] !== ',') throw new Error('invalid JSON array')
    }
    throw new Error('unterminated JSON array')
  }

  parseValue()
  skipWhitespace()
  if (cursor !== text.length) throw new Error('trailing JSON data')
}

/** Parse a Host-owned trust document with duplicate-key and object-root
 * protection. Schema-specific callers must still validate their exact fields. */
export function parseHostTrustJsonObject(text: string, label: string): TrustJsonObject {
  if (text.charCodeAt(0) === 0xfeff) {
    throw new Error(`${label} JSON must not start with UTF-8 BOM`)
  }
  try {
    assertUniqueJsonKeys(text)
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isObject(parsed)) throw new Error(`${label} must be a JSON object`)
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be a JSON object`) throw error
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function readHostTrustJsonObject(path: string, label: string): TrustJsonObject {
  return parseHostTrustJsonObject(readFileSync(path, 'utf8'), label)
}

/** Validate the exact key set for one trust-document schema object. */
export function assertExactTrustFields(
  value: TrustJsonObject,
  label: string,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional])
  const actual = Object.keys(value)
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  const unknown = actual.filter((key) => !allowed.has(key))
  if (missing.length > 0 || unknown.length > 0) {
    const details: string[] = []
    if (missing.length > 0) details.push(`missing ${missing.join(', ')}`)
    if (unknown.length > 0) details.push(`unknown fields ${unknown.join(', ')}`)
    throw new Error(`${label} has ${details.join('; ')}`)
  }
}

export function requireTrustObject(value: unknown, label: string): TrustJsonObject {
  if (!isObject(value)) throw new Error(`${label} must be a JSON object`)
  return value
}
