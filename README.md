# Usage Meter

**[Download for macOS](https://github.com/Samarth2709/UsageMeter/releases/latest/download/UsageMeter-arm64.dmg)** · **[Website](https://usage-meter-five.vercel.app)** · MIT licensed · Apple Silicon

Usage Meter is a local macOS menu-bar app for understanding Codex and Claude Code limits and local CLI usage.

> The first release containing the verified updater must be installed from the DMG once. After that, routine app/UI updates download as a verified Core from the menu bar; Electron and shell upgrades still use a new DMG.

## What it does

- Shows live Codex and Claude Code allowance windows, including dynamically reported weekly-only plans.
- Refreshes limit data in the background and shows the last successful value in grey with a `Cached` label if a provider is temporarily unavailable.
- Opens with the menu-bar icon or `Control` + `Option` + `L`.
- Enables macOS launch-at-login on the first packaged launch from `/Applications`; later changes in macOS Login Items are respected.
- Reads local Claude Code and Codex transcripts to power a Usage History dashboard with daily trends, project grouping, model cost/cache analysis, subscription value, and diagnostics.
- Lets you add extra transcript folders when your CLI sessions live outside the standard locations.

## Install and use

1. Download and install the DMG into `/Applications`.
2. Open **Usage Meter** once. It adds a menu-bar icon and enables launch-at-login for the packaged app.
3. Use the refresh control to load limits. Connect a row if the app cannot find an existing CLI login.
4. Select **View usage history** for local transcript analytics. If history is empty, open **Diagnostics** and add the folder containing your `.jsonl` sessions.

The packaged app supports Apple Silicon Macs. If macOS blocks an unsigned download, use the instructions on the [website](https://usage-meter-five.vercel.app).

## Updates

The installed app has a small fixed Electron shell and a separately versioned Core. When a compatible Core update is published, the menu bar shows **Update available**. Select it to download and verify the signed archive, then select **Restart now**. The current Core remains active if verification fails, and the previous healthy Core is restored on the next launch if a new Core never becomes healthy.

This is not macOS bundle auto-update: without an Apple Developer ID, Electron/security updates and any incompatible shell change require downloading and replacing the DMG manually. Update checks and Core archives are public GitHub Release requests; no transcript contents are sent with them.

## Data and privacy

Usage Meter is designed around local CLI state:

- Usage History indexes local `.jsonl` transcripts in a short-lived worker, reads only newly appended bytes after the first pass, and saves compact 90-day aggregates under `~/.rate-limit-tool/`. Indexed history stays available when a CLI cleans up an old transcript. It does not upload transcript contents.
- Codex limits use the authenticated credentials already stored by Codex and call its usage service.
- Claude limits use the app's existing authenticated `claude.ai` web session. Usage Meter never starts Claude Code for automatic refreshes or automation; it invokes the CLI only after an explicit Sign In or Log Out action.
- App configuration, saved identities, caches, window state, verified Core versions, and optional automation state live under `~/.rate-limit-tool/`.

Append validation detects truncation, replacement, source reclassification, and changes at the saved file tail. An in-place rewrite earlier in an already-indexed prefix cannot be detected without rereading the whole prefix, so **Usage History → Diagnostics → Rebuild index** provides an explicit full repair from current transcripts while preserving retained 90-day history for files the CLIs already cleaned up.
See [Architecture](docs/ARCHITECTURE.md) for the exact data flow and [Development](docs/DEVELOPMENT.md) for environment overrides.

## Run from source

Prerequisites: macOS, Node.js 20 or newer, and an installed Codex and/or Claude Code CLI for live data.

```bash
npm ci
npm start
```

Useful commands:

```bash
npm test          # full Node test suite
npm run server    # browser/debug mode at http://localhost:4545
npm run build:core # create the local fallback Core in build/core/
npm run dist:mac  # build DMG and ZIP under dist/
npm run clean     # remove generated dist/ and build/ artifacts only
```

Source-mode runs do not register a macOS login item.

## Optional Codex 5-hour automation

The app normally only reads limits. Setting `RATE_LIMIT_TOOL_AUTOSTART_ENABLED=1` opts into automation that starts a minimal **Codex** CLI task when an eligible 5-hour allowance resets. Claude accounts are always excluded. The task can consume usage, so it is disabled by default.

```bash
RATE_LIMIT_TOOL_AUTOSTART_ENABLED=1 npm start
```

Use `RATE_LIMIT_TOOL_AUTOSTART_DRY_RUN=1` to inspect eligible actions without running a CLI task. Details and other environment variables are in [Development](docs/DEVELOPMENT.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, data paths, storage, and UI mirrors.
- [Development](docs/DEVELOPMENT.md) — setup, commands, tests, and environment variables.
- [Releasing](docs/RELEASING.md) — build, release, website deployment, and verification.
- [Project history](docs/HISTORY.md) — shipped milestones and historical references.

Historical plans and review material live under [docs/archive](docs/archive/README.md). They are retained for context and are not current operating instructions.
