import { InstalledPluginError } from './pluginManifestErrors'

function isObject(value: unknown): value is Record<string, unknown> {
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

/** Reject duplicate object keys before JSON.parse can silently overwrite them. */
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
    const number = text.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
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
        throw new InstalledPluginError(`duplicate JSON object key: ${key.value}`)
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

/** Parse manifest JSON with duplicate-key rejection and object validation. */
export function parseManifestJson(text: string): Record<string, unknown> {
  if (text.charCodeAt(0) === 0xfeff) {
    throw new InstalledPluginError('manifest JSON must not start with UTF-8 BOM')
  }
  try {
    assertUniqueJsonKeys(text)
  } catch (error) {
    if (error instanceof InstalledPluginError) throw error
    throw new InstalledPluginError(
      `manifest JSON is not valid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isObject(parsed)) throw new InstalledPluginError('manifest must be a JSON object')
    return parsed
  } catch (error) {
    if (error instanceof InstalledPluginError) throw error
    throw new InstalledPluginError(
      `manifest JSON is not valid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
