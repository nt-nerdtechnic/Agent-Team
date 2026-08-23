# Keyboard Shortcuts Reference

This Mini-IDE's keybindings align with VS Code / Cursor conventions.
All rules are defined in `src/renderer/src/keybindings/defaults.ts` and resolved
via `useKeybindings` (capture-phase), with support for chord keys (e.g. `⌘K ⌘K`)
and when-clause conditions.

> **macOS symbols:** `⌘` Cmd · `⌥` Option/Alt · `⌃` Ctrl · `⇧` Shift · `↩` Enter

Every binding below can be changed in **Settings → Shortcuts**; see
[Customizing shortcuts](#customizing-shortcuts) for the file format and the
rules the editor writes.

---

## Workbench

### File Operations

| Shortcut | Action |
|----------|--------|
| `⌘S` | Save current file |
| `⌘⇧S` | Save all |
| `⌘W` | Close active editor; close the focused CLI pane in the main window (confirms first — a running pane always asks, an idle one asks unless the user ticked "don't show again", restorable under Settings → General); close the open modal while one is open |
| `⌘⇧W` | Close the current window |
| `⌘K ⌘W` | Close all editors |
| `⌘O` | Open file |
| `⌘N` | New file |
| `⌘⇧N` | New window |
| `⌘⇧T` | Reopen closed editor |

### Panels & Sidebar

| Shortcut | Action |
|----------|--------|
| `⌘B` | Toggle sidebar |
| `⌘⇧E` | Focus Explorer |
| `⌘⇧G` | Open the Git window from the main window; focus the Source Control sidebar inside the Mini IDE (when find is closed) |
| `⌘⇧I` | Open the Mini IDE window |
| `⌥⌘V` | Focus the right rail's Preview panel (main window) |
| `⌘J` | Toggle AI Terminal panel |
| `⌘⇧A` | Toggle AI Terminal panel |
| `` ⌃` `` | Toggle AI Terminal panel |
| `⌘⇧U` | Open Agent |
| `⌘R` / `⌘⇧B` | Rebuild the focused pane (resume) |
| `⌘⇧R` | Reload the window (Git window: refresh) |
| `⌘⇧L` | Open Debug (backend log, shell, AI) — outside the Mini IDE, where this chord belongs to the editor |
| `Escape` / `⌘W` | Close modal dialog (⌘W also works with focus in an embedded terminal, where Escape belongs to the CLI) |

### Quick Open

| Shortcut | Action |
|----------|--------|
| `⌘P` | Quick open file |
| `⌘⇧P` / `F1` | Command palette |
| `⌘⇧O` | Go to symbol in file |
| `⌘T` | Go to symbol in workspace (scans all open files) |
| `⌘L` / `⌃G` | Go to line |

### Settings

| Shortcut | Action |
|----------|--------|
| `⌘,` | Open settings |
| `⌘K ⌘S` | Open keyboard shortcuts |
| `⌘K ⌘T` | Select theme |
| `⌘K ⌘M` | Change language mode |

### Font Zoom

| Shortcut | Action |
|----------|--------|
| `⌘=` | Zoom in |
| `⌘-` | Zoom out |
| `⌘0` | Reset zoom |

---

## Editor Tabs

| Shortcut | Action |
|----------|--------|
| `⌃Tab` | Next editor |
| `⌃⇧Tab` | Previous editor |
| `⌘⇧]` | Move tab right |
| `⌘⇧[` | Move tab left |
| `⌘1` – `⌘9` | Jump to tab 1–9 |

---

## Navigation

| Shortcut | Action |
|----------|--------|
| `⌃-` | Navigate back |
| `⌃⇧-` | Navigate forward |
| `⌘K ⌘Q` | Go to last edit location |
| `F12` | Open imported file at cursor (go to definition) |
| `⇧F12` | Find all references |
| `F2` | Rename symbol (select all occurrences) |

---

## Search & Replace

| Shortcut | Action | Condition |
|----------|--------|-----------|
| `⌘F` | Open find | editor open |
| `⌘E` | Use selection as find term | editor open |
| `⌘H` | Open replace | editor open |
| `⌘⇧F` | Find in files | — |
| `⌘⇧H` | Find and replace in files | — |
| `⌘G` / `F3` | Next match | find open |
| `⌘⇧G` / `⇧F3` | Previous match | find open |

---

## Cursor Movement

### Basic Navigation

| Shortcut | Action |
|----------|--------|
| `⌘↑` | Go to file start |
| `⌘↓` | Go to file end |
| `Home` | Go to line start (smart: first non-whitespace, then col 0) |
| `End` | Go to line end |
| `⌃Home` | Go to file start (cross-platform alias for `⌘↑`) |
| `⌃End` | Go to file end (cross-platform alias for `⌘↓`) |
| `⌥←` | Move word left |
| `⌥→` | Move word right |
| `⌃↑` | Scroll view up one line (cursor stays) |
| `⌃↓` | Scroll view down one line (cursor stays) |
| `PageUp` | Page up |
| `PageDown` | Page down |

### Navigation with Selection

| Shortcut | Action |
|----------|--------|
| `⌘⇧↑` | Select to file start |
| `⌘⇧↓` | Select to file end |
| `⇧Home` | Select to line start |
| `⇧End` | Select to line end |
| `⌃⇧Home` | Select to file start (cross-platform) |
| `⌃⇧End` | Select to file end (cross-platform) |
| `⌃⇧←` | Select word left (Windows/Linux style) |
| `⌃⇧→` | Select word right (Windows/Linux style) |

---

## Selection

| Shortcut | Action |
|----------|--------|
| `⌘A` | Select all |
| `⌃L` | Select current line |
| `⌘⇧L` / `⌘F2` | Select all occurrences |
| `⌘D` | Add selection to next find match |
| `⌘K ⌘D` | Move selection to next find match (skip) |
| `⇧⌥←` | Shrink smart selection |
| `⇧⌥→` | Expand smart selection |
| `⌘⇧\|` | Jump to matching bracket |

### Multi-cursor

| Shortcut | Action |
|----------|--------|
| `⌘⌥↑` | Add cursor above |
| `⌘⌥↓` | Add cursor below |
| `⇧⌥I` | Add cursors to end of each selected line |

> Any arrow key, Home, End, PageUp/Down, or Undo clears all extra cursors.

---

## Editing

### Basic

| Shortcut | Action |
|----------|--------|
| `⌘Z` | Undo |
| `⌘⇧Z` / `⌘Y` | Redo |
| `⌘↩` | Insert line below |
| `⌘⇧↩` | Insert line above |
| `⌃T` | Transpose characters around cursor |

### Line Operations

| Shortcut | Action |
|----------|--------|
| `⌥↑` | Move line(s) up |
| `⌥↓` | Move line(s) down |
| `⇧⌥↑` | Copy line(s) up |
| `⇧⌥↓` | Copy line(s) down |
| `⌘⇧K` | Delete line |
| `⌃J` | Join next line onto current line |

### Indentation

| Shortcut | Action |
|----------|--------|
| `⌘]` | Indent line(s) |
| `⌘[` | Outdent line(s) |
| `Tab` (with selection) | Indent selected lines |
| `⇧Tab` (with selection) | Outdent selected lines |

### Deletion

| Shortcut | Action |
|----------|--------|
| `⌥Backspace` | Delete word left |
| `⌥Delete` | Delete word right |
| `⌘Backspace` | Delete to line start |
| `⌘Delete` | Delete to line end |

---

## Code Folding

| Shortcut | Action |
|----------|--------|
| `⌘⌥[` | Fold block at cursor |
| `⌘⌥]` | Unfold block at cursor |
| `⌘K ⌘[` | Fold recursively (fold cursor block and all children) |
| `⌘K ⌘]` | Unfold recursively |
| `⌘K ⌘0` | Fold all |
| `⌘K ⌘J` | Unfold all |
| `⌘K ⌘1` | Fold to level 1 |
| `⌘K ⌘2` | Fold to level 2 |
| `⌘K ⌘3` | Fold to level 3 |
| `⌘K ⌘4` | Fold to level 4 |
| `⌘K ⌘5` | Fold to level 5 |
| `⌘K ⌘6` | Fold to level 6 |
| `⌘K ⌘7` | Fold to level 7 |

> Fold ranges are detected by indentation. A foldable line has at least one following line with greater indentation. Folded blocks show `…` at the end of the fold-start line. Click the `▶/▼` gutter icon to toggle folding.

---

## Comments

| Shortcut | Action |
|----------|--------|
| `⌘/` | Toggle line comment |
| `⌘⌥/` / `⇧⌥A` | Toggle block comment (`/* ... */`) |
| `⌘K ⌘C` | Add line comment |
| `⌘K ⌘U` | Remove line comment |

---

## Formatting

| Shortcut | Action |
|----------|--------|
| `⇧⌥F` | Format document (JSON gets pretty-printed) |
| `⌘K ⌘F` | Format selection |
| `⌘K ⌘X` | Trim trailing whitespace |

---

## Editor Groups (Split Editor)

| Shortcut | Action |
|----------|--------|
| `⌘\` | Split editor (opens current file in secondary group) |
| `⌘K ⌘←` | Focus previous editor group |
| `⌘K ⌘→` | Focus next editor group |

> Close all tabs in the secondary group to dismiss it. Click inside a group to make it active.

---

## Problems Panel

| Shortcut | Action |
|----------|--------|
| `⌘⇧M` | Show Problems panel |
| `F8` | Go to next problem |
| `⇧F8` | Go to previous problem |

> Diagnostics come from AI Code Review findings and JSON parse errors detected on format. Affected lines show `●` (error) or `▲` (warning) in the gutter.

---

## Code Intelligence

| Shortcut | Action |
|----------|--------|
| `⌘.` | Quick Fix — shows AI Fix options for the current line's diagnostics |

---

## Text Transforms (Command Palette only)

Run these via `⌘⇧P`. No default keybinding.

| Command | Action |
|---------|--------|
| Transform to Uppercase | UPPERCASE |
| Transform to Lowercase | lowercase |
| Transform to Title Case | Title Case |
| Transform to Snake Case | snake_case |
| Transform to Camel Case | camelCase |
| Transform to Kebab Case | kebab-case |
| Transform to Pascal Case | PascalCase |
| Transform to Base64 | Base64-encode selection |
| Transform from Base64 | Base64-decode selection |
| URL Encode Selection | Percent-encode selection |
| URL Decode Selection | Percent-decode selection |
| Sort Lines Ascending | Sort selected lines A → Z |
| Sort Lines Descending | Sort selected lines Z → A |
| Reverse Lines | Reverse order of selected lines |
| Remove Duplicate Lines | Remove duplicate lines in selection |
| Join Lines | Merge lines into one (same as `⌃J`) |

---

## Line Endings & Indentation (Command Palette only)

| Command | Action |
|---------|--------|
| Change End of Line to CRLF | Switch to Windows line endings |
| Change End of Line to LF | Switch to Unix/macOS line endings |
| Convert Indentation to Spaces | Replace tab indents with spaces |
| Convert Indentation to Tabs | Replace space indents with tabs |

> The current EOL and indentation settings are also shown in the status bar at the bottom of the editor — click to toggle.

---

## AI Features

| Shortcut | Action |
|----------|--------|
| `⌘I` / `⌃Space` | Trigger AI inline completion (Ghost Text) |
| `⌘K ⌘K` / `⌃⇧I` | AI inline rewrite (select code, then type instruction) |
| `⌘⇧A` / `⌘J` / `` ⌃` `` | Open / close AI Terminal panel |
| `⌘⇧L` | Add current selection or word to the AI Terminal prompt (when editor is open but text area is not focused) |
| `Tab` (Ghost Text visible) | Accept full AI suggestion |
| `→` (Ghost Text visible) | Accept one character of AI suggestion |
| `⌘→` / `⌥→` (Ghost Text visible) | Accept one word of AI suggestion |

---

## File Utilities

| Shortcut | Action |
|----------|--------|
| `⌘K ⌘P` | Copy absolute file path |
| `⌘⇧⌥C` | Copy relative file path |
| `⌘K ⌘R` | Reveal file in Explorer sidebar |
| `⇧⌥R` | Reveal file in Finder |
| `F12` | Open imported/required file at cursor |
| `⌘⌥↩` | Open URL under cursor in browser |
| `⌘K ⌘Z` | Toggle Zen Mode (hides sidebar and tab bar) |
| `⌘K ⌘L` | Toggle line numbers |
| `⌘K ⌘E` | Focus active editor |
| `⌘K ⌘O` | Open folder |

---

## Git Window

Only active in the standalone Git window (`gitWindow` context). Every shortcut
here yields to the window's AI terminal while it has focus, and stays inert
while an operation is running or the folder is not a repository — the same
condition that greys out the matching toolbar button.

| Shortcut | Action |
|----------|--------|
| `F5` / `⌘⇧R` | Refresh status, log, branches, remotes, tags, stashes, worktrees |
| `⌘↩` | Commit staged changes |
| `⌘⇧↩` | Amend the last commit |
| `⌘⇧M` | Generate the commit message with AI |
| `⌘⇧A` | Stage all changes |
| `⌘⇧U` | Unstage all staged files |
| `⌘⇧F` | Fetch |
| `⌘⇧L` | Pull |
| `⌘⇧P` | Push |
| `⌘⇧S` | Sync (pull then push) |
| `⌘L` | Open and focus the AI terminal dock |

---

## Chord Key Reference (`⌘K …`)

`⌘K` is a chord prefix. In editor text focus, pressing `⌘K` enters chord mode (300 ms timeout); the next key completes the command.

| Prefix | Second Key | Action |
|--------|-----------|--------|
| `⌘K` | `⌘K` | AI inline rewrite |
| `⌘K` | `⌘C` | Add line comment |
| `⌘K` | `⌘U` | Remove line comment |
| `⌘K` | `⌘X` | Trim trailing whitespace |
| `⌘K` | `⌘F` | Format selection |
| `⌘K` | `⌘M` | Change language mode |
| `⌘K` | `⌘P` | Copy absolute path |
| `⌘K` | `⌘R` | Reveal in Explorer |
| `⌘K` | `⌘S` | Keyboard shortcuts settings |
| `⌘K` | `⌘T` | Select theme |
| `⌘K` | `⌘Z` | Toggle Zen Mode |
| `⌘K` | `⌘O` | Open folder |
| `⌘K` | `⌘E` | Focus editor |
| `⌘K` | `⌘L` | Toggle line numbers |
| `⌘K` | `⌘Q` | Go to last edit location |
| `⌘K` | `⌘D` | Move to next find match (skip) |
| `⌘K` | `⌘W` | Close all editors |
| `⌘K` | `⌘[` | Fold recursively |
| `⌘K` | `⌘]` | Unfold recursively |
| `⌘K` | `⌘0` | Fold all |
| `⌘K` | `⌘J` | Unfold all |
| `⌘K` | `⌘1`–`⌘7` | Fold to indentation level 1–7 |

---

## When-Clause Conditions

Keybindings can be gated by context conditions. These eight are the whole set —
every condition any rule tests, and every one any window publishes.

**Window identity.** No window ever sets two of these, which is what lets the
same key mean different things in different windows (`⌘⇧G` is `openGitWindow` in
the main window and `focusSourceControl` in the Mini IDE). Settings' conflict
detection relies on it: without knowing the two can never meet, almost every
shared key would report as broken.

| Condition | Set by | True in |
|-----------|--------|---------|
| `paneStage` | main window | The workspace window with the CLI panes |
| `editorOpen` | Mini IDE | At least one editor tab is open — also how a rule says "the Mini IDE" |
| `gitWindow` | Git window | The standalone Git window |
| `planWindow` | Plan window | The standalone plan review window |

**Transient state.** Unlike the identities, these come and go while a window
stays open, so a rule that waits on one is not dead — it just waits.

| Condition | Description |
|-----------|-------------|
| `editorTextFocus` | The editor text area has keyboard focus |
| `findOpen` | The find widget is currently open |
| `modalOpen` | A modal dialog is currently open |
| `terminalFocus` | A terminal has focus — ESC and friends belong to the PTY |

Conditions support `&&` (and), `||` (or), `!` (not); `!editorTextFocus` reads as
"the editor is there but the text area does not have focus". There are no
parentheses and no comparisons — `&&` simply binds tighter than `||`, and an
unknown identifier evaluates to `false`, so a typo silently disables the rule
rather than reporting anything. The Settings editor therefore shows `when`
read-only; to write a new condition, edit `keybindings.json` by hand.

---

## Customizing shortcuts

**Settings → Shortcuts** (also reachable with `⌘K ⌘S`) lists every command as
one row per (command, `when`) pair. Click a key cap to record a replacement, `+` to add a
second binding, `✕` to remove one, and `↺` to restore that row's defaults.
Overrides are written to `keybindings.json` in the Electron `userData`
directory and broadcast to every open window, so they apply without a restart.

### File format

The file is a flat array of the same `KeybindingRule` shape `defaults.ts` uses.
Later rules win over earlier ones, and user rules are appended after the
defaults:

```jsonc
[
  // cancel the shipped binding…
  { "key": "cmd+s", "command": "-editor.action.save", "when": "editorOpen && !terminalFocus" },
  // …and put the command somewhere else
  { "key": "cmd+alt+s", "command": "editor.action.save", "when": "editorOpen && !terminalFocus" }
]
```

A command prefixed with `-` is a **removal**: it cancels the rule that binds
that same key to that same command. Removal is deliberately narrow rather than
"blank the key", because several keys carry more than one command separated
only by their `when` clause — `⌘⇧G` is `focusSourceControl` in the Mini IDE and
`openGitWindow` in the main window, and unbinding one must not take the other
down with it. Removals are matched on the canonical form of the key, so
`shift+cmd+p` and `cmd+shift+p` refer to the same binding.

A malformed entry is skipped rather than discarding the whole file.

### Commands with no default key

The list is generated from a static command manifest (`COMMAND_IDS` in
`commandCatalog.ts`) joined with `defaults.ts`, not from `defaults.ts` alone —
about a quarter of the app's commands ship with no key, and those are exactly
the ones worth binding. They appear as `unassigned` and can be given a key like
any other row. `commandManifest.test.ts` scans the source and fails if the
manifest and the `registerCommand` calls drift apart.

### Import / export

**Export** writes the current overrides to a file you choose. **Import**
replaces them wholesale, after checking every entry: a rule whose key is
malformed, whose chord has three segments, or whose command this build does not
have is listed as rejected rather than dropped quietly.

### Protected shortcuts

`workbench.action.openSettings` and `workbench.action.openKeyboardShortcuts`
must keep at least one binding — removing the last one would hide the only
screen that could undo it. They can still be rebound freely; the editor shows a
lock instead of the remove button on the final key, and a hand-edit that would
strand them is ignored on load.

### What cannot be rebound here

Both of these are listed read-only at the bottom of the Shortcuts page, since
that page replaced the old reference:

- **Terminal keys** (`⇧↩`, `⌘←`, `⌥⌫`, …) are intercepted by `useTerminal` and
  turned into control sequences before the rule table is consulted.
- **Electron menu accelerators** (`⌥⌘I`, `⌘Q`, `⌃⌘F`, `⌘C`/`⌘V`/`⌘Z`/`⌘A`, …)
  fire in the main process ahead of the renderer. They also fire while the
  Settings recorder is capturing, so those combinations cannot be recorded as
  shortcuts. `⌘R`, `⇧⌘R` and `⌘W` are **not** on this list: their menu roles
  were dropped precisely so the rule table could have them.

---

## Implementation Architecture

```
KeybindingRule (defaults.ts)  +  user overrides (keybindings.json)
    ↓  merged, later rules win; '-command' rules cancel their target
    ↓  resolved by KeyResolver
useKeybindings — window.addEventListener('keydown', handler, { capture: true })
    ↓  match found → stopPropagation
executeCommand (useKeybindings.ts)
    ↓
registerCommand handlers
    ↓
EditorWindowApp → activeEditor() → EditorPane → EditorView
```

- **Capture phase** — interception happens before the event reaches any target element, allowing chords to override native browser/OS behaviour.
- **Command registry** — commands are decoupled from UI; the palette and keybindings share the same `registerCommand` registry.
- **No-op safety** — unregistered commands return `false` without calling `stopPropagation`, so native element behaviour falls through unaffected.
- **Per-window resolvers** — each renderer window builds its own `KeyResolver`, so a write to `keybindings.json` is broadcast from the main process (`keybindings:changed`) and re-applied everywhere.
- **Recording** — while the Settings recorder is reading raw keystrokes it calls `setKeyCaptureActive(true)`, which suspends the dispatcher; the dispatcher's listener is installed first and window capture-phase listeners run in registration order, so the recorder cannot outrank it any other way.
