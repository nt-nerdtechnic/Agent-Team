# Security Policy

Navide is a desktop app (Electron + a local Python backend) plus an optional
relay server (Navide Cloud). Both live in this organisation's repositories.

## Reporting a vulnerability

Please report security issues privately through GitHub's **"Report a
vulnerability"** button on this repository's Security tab (private
vulnerability reporting). Do not open a public issue for anything that could
be exploited.

What helps us act quickly:

- the version (Navide → About, or the release tag) and the platform
- steps to reproduce, or the request/message that triggers the problem
- what an attacker gains (read another pane's data, change trust state,
  execute a command, …) and from where (remote peer, another local account,
  a process running as the same user, untrusted content in a window)

## What to expect

- Acknowledgement within 3 business days.
- Triage and a severity call within 7 business days. We use the same threat
  model as our internal audits: a controlled relay or remote peer; another
  local OS account; a same-user process holding a pane or socket token;
  untrusted content rendered inside a window.
- Fixes ship in the next release for high and critical issues, and are
  batched for the rest. We will tell you when the fix is out and credit you
  in the release notes unless you prefer otherwise.

## Scope

In scope: this repository, the Navide desktop app, and the Navide Cloud
server at `server.navide.dev`.

Out of scope: the third-party CLIs Navide launches (report those upstream),
issues that require physical access to an unlocked machine, and findings
that only apply with `contextIsolation`, `sandbox`, or code signing
deliberately disabled.

## Safe harbour

Good-faith research that stays within the scope above, avoids privacy
violations and service disruption, and gives us reasonable time to fix
before disclosure will not be met with legal action. Please do not test
against other people's accounts or devices on the production server; the
server can be run locally (see `Navide-Server/server/deploy/`).

## Supported versions

Only the latest signed release receives security fixes.
