// Per-workspace registry for plan review windows: one window per workspace,
// reopening the same workspace focuses the existing window. Kept free of
// Electron imports so the single-instance semantics are unit-testable.

export interface DestroyableWindow {
  isDestroyed(): boolean
}

export class PlanWindowRegistry<T extends DestroyableWindow> {
  private readonly windows = new Map<string, T>()

  /** Live window for the workspace; prunes destroyed entries. */
  get(workspacePath: string): T | null {
    const win = this.windows.get(workspacePath)
    if (!win) return null
    if (win.isDestroyed()) {
      this.windows.delete(workspacePath)
      return null
    }
    return win
  }

  set(workspacePath: string, win: T): void {
    this.windows.set(workspacePath, win)
  }

  /**
   * Remove the entry only when it still points at `win` — a close event from
   * a stale window must not evict a newer one registered for the same
   * workspace.
   */
  remove(workspacePath: string, win: T): void {
    if (this.windows.get(workspacePath) === win) this.windows.delete(workspacePath)
  }
}
