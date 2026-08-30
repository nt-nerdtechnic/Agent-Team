/** Minimal backend port required by the Plans root-resolution operation. */
export interface PlansBackendPort {
  send(
    type: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; payload: unknown | null }>
}

/** Resolve the document root used by the Plans production path. */
export async function resolvePlanRoot(
  backend: PlansBackendPort,
  workspacePath: string,
): Promise<string> {
  const response = await backend.send('plans.resolve_root', {
    workspace_path: workspacePath,
  })
  const payload = response.payload
  const root =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
    (payload as { ok?: unknown }).ok === true &&
    typeof (payload as { root?: unknown }).root === 'string'
      ? (payload as { root: string }).root
      : undefined
  return typeof root === 'string' && root.length > 0 ? root : workspacePath
}
