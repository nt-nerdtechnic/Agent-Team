/** Minimal backend seam needed by the Git UI for repo-tab persistence. */
export interface GitUiBackend {
  send<TPayload = unknown>(
    type: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{
    ok: boolean
    payload?: TPayload | null
    error?: { message?: string } | null
  }>
}
