/**
 * Bytes as a short human-readable size.
 *
 * One decimal below 100 and none above, so a column of these lines up and a
 * figure like "1.1 GB" stays readable without implying precision the caller
 * does not have.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
