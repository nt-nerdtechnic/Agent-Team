# Terminal width-reflow fixtures

Raw PTY output recorded from a real `claude` 2.1.250 TUI, used by
`useTerminalResize.widthRace.test.ts` to pin the width-resize ordering
against actual CLI bytes rather than a hand-written approximation.

| File | What it is |
|---|---|
| `s_boot120.bin` | Boot banner + `/help` output, drawn for **120** columns. Also stands in for "a frame the CLI drew before it learned about the new width". |
| `s_shrink90.bin` | The repaint Claude emits after the PTY winsize drops to **90** columns. |
| `s_widen120.bin` | The repaint after widening back to **120** columns. |

Recorded at 120x30 with `TERM=xterm-256color`, `CLAUDE*`/`NAVIDE*` env stripped
so the child does not inherit pane markers. `/help` is a local command — no API
call is made. The capture script is in
`.agent-team/plans/cli-pane_4dd73b.html` under "如何重建夾具".

The assertions do not depend on the exact bytes (they look for wrapped
box-drawing rows in the scrollback, not for specific content), so a re-recording
from a different `claude` build remains valid.
