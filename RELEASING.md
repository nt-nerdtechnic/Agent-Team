# Releasing Navide

Navide ships as a signed + notarized macOS app. Users receive updates through
the in-app updater (electron-updater), which downloads the full zip for every
update — see "Updates are full downloads" below for why.

We use a **two-tier** model.

| Tier | When | Command | Extra steps |
|------|------|---------|-------------|
| **Patch / hotfix** | small fixes, no new user-facing feature | `./release.sh patch` | none |
| **Minor / major** | new features, notable changes | `./release.sh minor` (or `major`) | announce (release notes, etc.) |

`release.sh` updates the README download links to the new version on **every**
release (patch included), so the download point always reflects the latest
version — no manual README edit is needed for any tier.

Every release — patch or major — is fully built, signed, notarized, and
published to GitHub Releases (with `latest-mac.yml`). There is no "hot patch"
that skips the build; the difference between the tiers is only the **ceremony**
around it, not the build itself.

## Prerequisites

- Clean `main`, in sync with `origin/main` (`release.sh` enforces this).
- Signing assets present and GitHub secrets set. See `~/navide-signing/README.md`
  (5 secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`).
- `node`, `pnpm`, `uv`, `git` on PATH.

## Pre-release step: Update What's New announcement

Before running `./release.sh`, add a new entry to `src/renderer/src/lib/whatsNew.ts` for the target version (e.g. `0.1.70`). Include title and bullet points in both `'zh-TW'` and `'en-US'`. This ensures that when users launch the newly updated app, the in-app What's New modal (`WhatsNewModal`) automatically pops up with the new features and fixes.

## Patch / hotfix flow

```bash
./release.sh patch      # e.g. 0.1.50 -> 0.1.51
```

`release.sh` bumps the version across all version files, runs the gates
(typecheck + frontend + backend tests), builds locally, commits, tags, and
(after you confirm) pushes `main` + the tag. The tag push triggers the
**Release macOS** CI workflow, which signs, notarizes, and publishes the GitHub
Release. Existing users' apps auto-check (startup + every 30 min), download the
update in the background, and prompt "Restart to update".

That's the whole hotfix flow. `release.sh` already repointed the README
download links (and the `latest-release` badge tracks the newest release), so
new users downloading a DMG always get the latest version too.

## Minor / major flow

```bash
./release.sh minor      # e.g. 0.1.50 -> 0.2.0
# or
./release.sh major      # e.g. 0.1.50 -> 1.0.0
```

Same as above (the README download links are updated by `release.sh`
automatically), **plus** announce as appropriate (release notes, etc.) after
the GitHub Release is published.

## Explicit version

The classic form still works unchanged:

```bash
./release.sh 0.3.0
```

## Notes

- **Bump keywords** (`patch`/`minor`/`major`) compute the next version from the
  current `package.json`. Never hand-edit version numbers — always go through
  `release.sh`, or the version files desync and the script refuses to run.
- **Updates are full downloads**, not deltas. `scripts/fix-mac-update-zip.mjs`
  re-zips the signed app with `ditto` and deliberately leaves the now-stale
  `.zip.blockmap` alone; since `latest-mac.yml` carries no `blockMapSize`,
  electron-updater never consults the blockmap and fetches the whole `.zip`.
- **Channels** (stable/beta) are an orthogonal, user-facing choice in
  Settings → Updates — unrelated to the patch/major tiers. A beta CI publishing
  feed is not wired yet; the App side is ready for it.
- **First run after upgrade**: the backend backs up its JSON stores
  (`<app-data>/store-backups/<version>/`, last 2 kept) and forward-migrates the
  schema, so an upgrade never corrupts saved settings.
- **Rollback**: users can download an older DMG from the Releases page; to pull
  a bad auto-update, remove/replace its `latest-mac.yml` on the release.
