/** Host-private resource limits for package-local Backend Wire routing. */
export const MAX_BACKEND_CALLS_PER_INSTANCE = 64
export const MAX_BACKEND_SUBSCRIPTIONS_PER_INSTANCE = 32
export const MAX_BACKEND_TIMEOUT_MS = 120_000

export function isAllowedBackendTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_BACKEND_TIMEOUT_MS
}
