# Development

## Prerequisites

- macOS on Apple Silicon for the packaged app.
- Node.js 20 or newer. The site deployment workflow also uses Node 20.
- An installed Codex and/or Claude Code CLI if you want live-limit or local-history data.

## Setup and commands

```bash
npm ci
npm start
npm test
```

| Command | Purpose |
| --- | --- |
| `npm start` / `npm run dev` | Launch Electron from source. |
| `npm test` | Run all Node tests. |
| `npm run server` | Run the local browser/debug server at `http://localhost:4545`. |
| `npm run build:core` | Assemble the versioned Core and its production dependencies in `build/core/`. |
| `npm run dist:mac` | Build unsigned macOS DMG and ZIP artifacts in `dist/`. |
| `npm run clean` | Remove only generated `dist/` and `build/` artifacts. |
| `node scripts/generate-waves.js` | Regenerate the popover meter's sea-surface keyframes in `public/styles.css` from the wave components in the script. |

Use `npm ci` for a deterministic dependency install. Do not commit `node_modules/` or `dist/`.

## Verification checklist

Run these checks for a code or documentation change:

```bash
npm test
git diff --check
```

For a dashboard change, also verify:

1. The Electron history view loads its 7/30/90-day data.
2. Diagnostics work with default and configured transcript folders.
3. The static demo still loads and native-only controls stay read-only or hidden.
4. `public/history.js` and `site/history.js` remain intentionally aligned.

For a packaging change, additionally build the DMG, install it into `/Applications`, open it once, and check the menu-bar icon, global shortcut, live refresh, and Login Items behavior.

## Environment variables

| Variable | Effect |
| --- | --- |
| `CODEX_HOME` | Adds an alternate Codex home to discovery and live Codex usage. |
| `CLAUDE_CONFIG_DIR` | Replaces the default `~/.claude` root for Claude transcript discovery. |
| `USAGE_METER_UPDATE_REPO` | Overrides the GitHub repository used for update checks. |
| `USAGE_METER_UPDATE_MANIFEST_URL` | Overrides the signed manifest URL; intended for local updater fixtures. |
| `USAGE_METER_UPDATE_SIGNATURE_URL` | Overrides the matching manifest signature URL; intended for local updater fixtures. |
| `USAGE_METER_SHELL_DOWNLOAD_URL` | Overrides the manual shell/DMG download URL. |
| `RATE_LIMIT_TOOL_DEBUG=1` | Enables development diagnostics. |
| `RATE_LIMIT_TOOL_KEEP_OPEN=1` | Keeps the History window open after blur while debugging. |
| `RATE_LIMIT_TOOL_AUTOSTART_ENABLED=1` | Opts into the Codex-only 5-hour reset automation; this can run a Codex CLI task and consume usage. Claude accounts are excluded. |
| `RATE_LIMIT_TOOL_AUTOSTART_DRY_RUN=1` | Reports eligible Codex automation actions without running a task. |

The packaged app enables macOS launch-at-login independently of `RATE_LIMIT_TOOL_AUTOSTART_ENABLED`. They are different features.

## Code ownership guide

| Need | Start here |
| --- | --- |
| Codex/Claude account refresh or login | `server.js` |
| Window labels, resets, or merge behavior | `usage-windows.js`, `server.js` |
| History file discovery and parsing | `usage-history/sources.js`, `parseClaude.js`, `parseCodex.js` |
| Cost, cache savings, or pricing | `usage-history/pricing.js` |
| Range aggregation or persistence | `usage-history/aggregate.js`, `store.js` |
| Subscription value, project, or model insights | `usage-history/windows.js`, `model-insights.js` |
| Electron lifecycle or IPC | `electron-main.js`, `preload.js` |
| Core download, activation, or rollback | `core-updater.js`, `bootstrap-updater.js`, `bootstrap.js` |
| Popover/dashboard UI | `public/` and its `site/` counterpart; visual language in [Design](DESIGN.md) |

## Generated and local-only files

- `node_modules/` is the local dependency tree.
- `dist/` contains rebuildable DMG/ZIP outputs.
- `build/core/` is a rebuildable fallback Core used while packaging; do not commit it.
- `site/.vercel/` links this checkout to the Vercel project and stays ignored.
- `~/.rate-limit-tool/` contains user-local app state and must not be committed or copied into fixtures.

See [Architecture](ARCHITECTURE.md) for data handling and [Releasing](RELEASING.md) for publication steps.
