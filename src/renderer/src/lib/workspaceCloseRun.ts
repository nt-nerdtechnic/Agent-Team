/** Does closing a workspace end the pipeline run this window is tracking?
 *
 *  A window holds several workspaces but exactly ONE pipeline run, tracked in
 *  `pipeline.workspacePath`. Closing a workspace kills that workspace's panes,
 *  and every kill releases the killed pane's stage slot — so a stage whose
 *  other slots already finished reaches N/N and advances, spawning the next
 *  stage into a workspace that is being torn down. That is why the close path
 *  has to stop the orchestration first.
 *
 *  Both halves of the question are load-bearing, and asking only one is worse
 *  than asking neither:
 *
 *   • Only "are any doomed panes pipeline-origin?" — a pane whose `origin` is
 *     'pipeline' outlives the run it belonged to, because abort is a PAUSE that
 *     leaves the agents alive. Close workspace B, whose old run was aborted
 *     when the user switched to A, while a NEW run is live in A: B's leftover
 *     panes match, and the guard tears down A's running pipeline and sends
 *     A's backend an abort. Closing B killed the run in A.
 *
 *   • Only "is the run's workspace the one closing?" — true, but says nothing
 *     about whether this close actually takes any of the run's panes with it,
 *     and the origin check is what documents which panes those are.
 *
 *  Paths are compared as given: callers normalize first (App.vue passes both
 *  through its `normWs`), because the trailing-slash rule belongs to the caller
 *  that reads these paths off panes and workspace lists.
 */
export interface WorkspaceCloseProbe {
  /** `pipeline.state` — only a run that is actually running can be ended. */
  state: string
  /** `pipeline.workspacePath`, normalized: the workspace the run belongs to. */
  runWorkspacePath: string
  /** The workspace being closed, normalized. */
  closingWorkspacePath: string
  /** `origin` of every pane this close will kill. */
  doomedOrigins: readonly string[]
}

export function closeEndsTheRun(probe: WorkspaceCloseProbe): boolean {
  if (probe.state !== 'running') return false
  if (probe.runWorkspacePath !== probe.closingWorkspacePath) return false
  return probe.doomedOrigins.includes('pipeline')
}
