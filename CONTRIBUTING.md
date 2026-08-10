# Contributing to Navide

Thank you for your interest in contributing!
<!-- 感謝你對 Navide 的貢獻興趣！ -->

---

## Table of Contents

- [Asking Questions](#asking-questions)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Development Setup](#development-setup)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Code Style](#code-style)
- [Commit Format](#commit-format)

---

## Asking Questions / 提問

Usage questions and open-ended ideas belong in [GitHub Discussions](https://github.com/nt-nerdtechnic/Navide/discussions) — use **Q&A** for help and **Ideas** for early proposals. Issues are reserved for confirmed bugs and concrete feature requests.

> 使用問題與尚未成形的想法請到 [GitHub Discussions](https://github.com/nt-nerdtechnic/Navide/discussions)（Q&A 提問、Ideas 討論構想）；Issue 保留給已確認的 bug 與具體的功能需求。

---

## Reporting Bugs / 回報 Bug

Please open a [GitHub Issue](https://github.com/nt-nerdtechnic/Navide/issues/new?template=bug_report.yml) using the bug report template.
Include a clear description, steps to reproduce, and any relevant logs or screenshots.

> 請開 [GitHub Issue](https://github.com/nt-nerdtechnic/Navide/issues/new?template=bug_report.yml) 並填寫 bug 回報模板，包含重現步驟與相關 log。

---

## Requesting Features / 功能建議

Open a [GitHub Issue](https://github.com/nt-nerdtechnic/Navide/issues/new?template=feature_request.yml) with the feature request template.
Describe the problem you are trying to solve and the solution you have in mind.

> 請開 [GitHub Issue](https://github.com/nt-nerdtechnic/Navide/issues/new?template=feature_request.yml) 並描述你想解決的問題與建議的解法。

---

## Development Setup / 開發環境設定

**Requirements:** Node.js 22+, pnpm 10+, Python 3.12+, uv 0.11+, macOS 13+

```bash
git clone https://github.com/nt-nerdtechnic/Navide.git
cd Navide

pnpm install
uv --project backend sync

pnpm dev
```

The `pnpm dev` command starts Electron, Vite dev server, and the Python FastAPI backend together.

> `pnpm dev` 會同時啟動 Electron、Vite dev server 和 Python FastAPI backend。

---

## Submitting a Pull Request / 提交 PR

1. Fork the repository and create a feature branch:
   ```bash
   git checkout -b feat/your-feature
   ```
2. Make your changes.
3. Run the test suite:
   ```bash
   pnpm test:run
   uv --project backend run pytest backend/tests
   ```
4. Run type checks:
   ```bash
   pnpm typecheck
   ```
5. Commit your changes following the [commit format](#commit-format) below.
6. Push and open a pull request against `main`.

Please fill in the pull request template — include a summary of changes and how you tested them.

> Fork 後建立 feature branch，跑測試與型別檢查無誤後，依照下方 commit 格式提交，並開 PR 至 `main`。

---

## Code Style / 程式碼風格

**TypeScript / Vue**
- Match existing style and patterns in the codebase.
- No new dependencies without prior discussion in an Issue.

**Python**
- Follow PEP 8.
- Run `uv --project backend run pytest backend/tests` before committing.

**Adding a CLI agent**
- Follow [`docs/adding-a-cli-vendor.md`](docs/adding-a-cli-vendor.md). An
  integration is two vendor spec files plus registration — never an
  `if agent_key == "<yours>"` branch in a shared module.

> 請與現有程式碼風格保持一致。Python 提交前請執行完整 backend tests。
> 新增 CLI 整合請依 `docs/adding-a-cli-vendor.md`，一家一檔，不要在共用模組加分支。

---

## Commit Format / Commit 格式

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

Examples:
feat: add manager coordination mode
fix(analyzer): handle empty ollama response
docs: update quick start instructions
refactor(terminal): simplify PTY write path
test: add tests for sentinel detection
chore: update electron to v33
```

| Type | Use for |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | No behavior change |
| `test` | Tests only |
| `chore` | Build / tooling / dependencies |

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
By participating you agree to abide by its terms.

> 本專案遵循 [Contributor Covenant 行為準則](CODE_OF_CONDUCT.md)，參與即表示同意遵守。

## Documentation

User-facing behavior changes must update the relevant canonical document under [`docs/en-US/`](docs/en-US/README.md), synchronize an existing localized counterpart in the same change, and add an entry under `CHANGELOG.md`'s Unreleased section. Avoid describing configurable registries with fixed counts, document any new external data flow in `docs/en-US/privacy.md`, and keep future vision distinct from shipped capability claims.
