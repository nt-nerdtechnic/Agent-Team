/** Read the Host-only settings snapshot before the renderer root is loaded. */
export function readHostBootstrapSettings(): Record<string, unknown> {
  try {
    const raw = window.agentTeam?.getBootstrapSettings?.() ?? '{}'
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (err) {
    console.warn('[settings] bootstrap parse failed; starting empty', err)
  }
  return {}
}
