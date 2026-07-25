# Troubleshooting

English | [繁體中文](../zh-TW/troubleshooting.md) | [日本語](../ja-JP/troubleshooting.md) | [Documentation](README.md)

## The app does not start

1. Confirm Node.js 22+, pnpm 10+, Python 3.12+, and uv 0.11+.
2. Reinstall locked dependencies:

   ```bash
   pnpm install --frozen-lockfile
   uv --project backend sync --locked
   ```

3. Start from a terminal with `pnpm dev` and inspect the first backend or Electron error.
4. Run `pnpm typecheck` to distinguish environment problems from source errors.

## Backend health stays unavailable

- Confirm another process is not blocking local loopback communication.
- Check whether macOS security software denied the packaged Python backend.
- In development, run `uv --project backend run python -m agent_team_backend` separately to expose startup errors.

## An agent CLI is missing

- Run the CLI's version command in a normal interactive terminal.
- Restart Navide after installation so it receives the updated `PATH`.
- Complete the CLI's own authentication flow before spawning it in Navide.
- Confirm the executable name: `claude`, `codex`, `agy`, or `grok`.

## A CLI reports that its own auto-update failed

A pane may show a vendor message such as `✘ Auto-update failed`. Several panes updating the same CLI at once can collide, because a CLI's installation directory is shared across every pane and profile.

- Open Settings → CLI Agents. A failed update is reported there with the time, the versions involved, and which config home recorded it.
- Use the update action on that row. It runs the CLI's own update command (`claude update`, `codex update`, `agy update`, `grok update`) in a terminal; Navide never updates a CLI itself. A CLI without an update subcommand links to its vendor documentation instead.
- Set Auto-update to Manual for that CLI if collisions repeat. Navide then passes the vendor's own opt-out variable to every spawn, and you update from this panel instead.
- A running session keeps the binary it started with; restart the pane after an update.

## A pane remains on “detecting session”

Codex, Antigravity, and Grok rely on log or database discovery to bind a new CLI session to a Navide pane.

- Send a normal message so the CLI persists the pane marker.
- Confirm the CLI can write to its normal session directory.
- Do not immediately rebuild or resume before the first session is detected.
- If detection never completes, preserve the pane output and relevant backend log before filing an issue.

## Resume does not work

- Verify that the pane previously reached a detected session state.
- Confirm the original CLI still has the session in its own history.
- Check that the workspace path has not changed.
- A CLI upgrade may change resume syntax or session storage; include CLI and Navide versions in a bug report.

## Token Stats is empty or duplicated

- Token tracking depends on provider log formats and only sees usage after the CLI writes compatible records.
- Confirm that Navide has associated the CLI session with the current workspace and pane.
- Compare with the provider dashboard for billing; Navide's display is operational telemetry.
- If duplication persists, report the CLI version, session ID if safe, and a redacted example record.

## Local analyzer is unavailable

- For Ollama, verify that the service is running and the configured model exists.
- For a GGUF model, verify the file path, architecture support, and available memory.
- Analyzer failure should degrade optional automation rather than prevent normal manual terminal use.

## macOS permissions block a workflow

Open **System Settings → Privacy & Security** and inspect Automation, Files and Folders, Accessibility, and Full Disk Access. Grant only permissions required for the specific CLI and workspace. Restart the affected application after changing permissions.

## Context7 or documentation injection fails

Documentation injection is best-effort. Check the MCP configuration, package runtime, and network access. A failed fetch should not block a manual task; disable the integration if the workspace must remain offline.

## Git authentication prompts do not complete

- Verify the remote with `git remote -v`.
- Test the same fetch or push in a normal terminal.
- Prefer your existing SSH agent or credential-manager setup.
- Never paste access tokens into issue reports or terminal screenshots.

## Filing a useful bug

Include:

- Navide commit or version
- macOS version and architecture
- Agent CLI name and version
- Reproduction steps
- Expected and actual behavior
- Redacted logs or screenshots

Use the repository's [bug report template](https://github.com/nt-nerdtechnic/Navide/issues/new?template=bug_report.yml). Report vulnerabilities privately according to the [Security Policy](../../SECURITY.md).
