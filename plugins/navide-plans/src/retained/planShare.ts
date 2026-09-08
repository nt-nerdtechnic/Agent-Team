/**
 * planShare.ts
 *
 * Shared "share to Git" action for plan documents: copy the plan verbatim
 * into `.plans/<filename>` — a git-tracked path (`.agent-team/plans/` is
 * gitignored by design) — so the user can commit the snapshot to share it.
 * Re-reads the file first so the snapshot reflects the latest on-disk bytes;
 * an existing snapshot is overwritten. The backend's fs write creates missing
 * parent directories itself. Used by PlanReviewToolbar and PlansPane.
 */
import type { PlansTransport } from './transport'

export async function sharePlanToGit(
  backend: PlansTransport,
  workspacePath: string,
  relPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const readResp = await backend.send<{ ok: boolean; content?: string; error?: string }>(
    'fs.read_file',
    { workspace_path: workspacePath, rel_path: relPath },
  )
  if (!readResp.payload?.ok || readResp.payload.content === undefined) {
    return { ok: false, error: readResp.payload?.error }
  }
  const fileName = relPath.split('/').pop() ?? relPath
  const resp = await backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
    workspace_path: workspacePath,
    rel_path: `.plans/${fileName}`,
    content: readResp.payload.content,
  })
  if (!resp.payload?.ok) return { ok: false, error: resp.payload?.error }
  return { ok: true }
}
