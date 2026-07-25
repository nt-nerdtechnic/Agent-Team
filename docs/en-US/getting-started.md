# Getting Started

English | [繁體中文](../zh-TW/getting-started.md) | [日本語](../ja-JP/getting-started.md) | [Documentation](README.md)

Navide supports macOS 13 or newer on Apple silicon. The [v0.1.47 GitHub prerelease](https://github.com/nt-nerdtechnic/Navide/releases/tag/v0.1.47) provides unsigned DMG and ZIP downloads. It is not signed or notarized by Apple.

To install the preview, download the DMG, copy Navide to Applications, then Control-click the app in Finder and choose **Open**. If macOS still blocks it, use **System Settings → Privacy & Security → Open Anyway** for Navide. Do not disable Gatekeeper globally.

## What you need to install from source

- macOS 13+
- Node.js 22+
- pnpm 10+
- Python 3.12+
- uv 0.11+
- At least one supported coding CLI:
  - Claude Code (`claude`)
  - Codex (`codex`)
  - Antigravity CLI (`agy`)
  - Grok CLI (`grok`)
- Optional: Ollama or a local GGUF model for local analysis

Each coding CLI has its own installation, authentication, subscription, and data policy. Navide does not replace those requirements.

## Install from source

```bash
git clone https://github.com/nt-nerdtechnic/Navide.git
cd Navide
pnpm install
uv --project backend sync
pnpm dev
```

`pnpm dev` starts the Electron application, Vite renderer, and Python FastAPI backend together.

## First launch

The onboarding wizard checks the required runtimes and detects available agent CLIs. Complete these steps:

1. Resolve any blocked foundation dependency.
2. Confirm that at least one coding CLI is available and authenticated.
3. Configure a local analyzer if you want intent detection and automatic answers.
4. Grant only the macOS permissions needed by the workflows you use.
5. Open a trusted project folder as the workspace.

Navide may request Automation, Files and Folders, or Full Disk Access depending on how agents and terminals interact with the workspace. Review the reason shown by macOS before granting a permission.

After onboarding, Settings → CLI Agents lists every detected CLI with its version, install method, and last update result, and runs that CLI's own update and diagnostic commands.

## Run a first task

For the smallest successful test:

1. Open a disposable or version-controlled workspace.
2. Spawn one agent manually.
3. Give it a read-only task such as “summarize this repository.”
4. Confirm that terminal output, session detection, and History update.
5. Review Token Stats if the CLI exposes compatible usage logs.

After the manual flow works, try a pipeline with a small task. Review stage definitions and disable YOLO or Full Auto until you understand their effects.

## Development checks

```bash
pnpm typecheck
pnpm test:run
uv --project backend run pytest backend/tests
```

See [Troubleshooting](troubleshooting.md) if the app, backend, CLI, session binding, analyzer, or token tracking does not start as expected.
