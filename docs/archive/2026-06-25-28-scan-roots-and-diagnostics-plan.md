# Plan: Editable transcript folders + state-aware help

> **Historical document — completed and superseded.** This plan was implemented in the 0.2.2 work. Current behavior and maintenance guidance live in [Architecture](../ARCHITECTURE.md) and [Development](../DEVELOPMENT.md).

## Context
Usage history only reads local Claude Code / Codex **CLI** transcripts from fixed locations (`~/.claude/projects`, `~/.codex/sessions`, a few known Codex homes). A user (the friend) whose sessions live elsewhere has no way to point the app at them, and no guidance on what to do. This adds: (1) an in-app editor to add/remove folders scanned per CLI, persisted in config; (2) a **?** help button whose text is generated from the app's *current* scan state (not static). Both live in the Diagnostics tab.

## Approach

### 1. Config: additive scan roots (`server.js`)
Add a top-level `scanRoots: { claude: string[], codex: string[] }` to the config (file: `~/.rate-limit-tool/accounts.json`). These are **additional** folders — defaults are always still scanned.
- `defaultConfig()` (server.js:106): add `scanRoots: { claude: [], codex: [] }`.
- `normalizeConfig` (server.js:323-337): read `raw.scanRoots`, coerce to two string arrays, `expandHome` each, dedupe, and **include it in the returned object** (it currently drops unknown fields).
- `serializeConfig` (server.js:339-371): emit `scanRoots` with `compactHome` on each path.
- Export `expandHome`/`compactHome` from server.js for reuse.

### 2. Thread extra roots through scanning (`usage-history/*`)
Add an optional `extraRoots = { claude: [], codex: [] }` param (defaults preserve current behavior):
- `sources.js`: `listAllTranscriptFiles(homeDir, extraRoots)` walks each extra Claude root (recursively for `*.jsonl`, tagged `claude`) and each extra Codex root (tagged `codex`), in addition to defaults. Reuse internal `walkJsonl`.
- Thread `extraRoots` into `aggregate.scanUsageHistory` (:163), `windows.recentPricedPoints`/`transcriptFingerprint`/`computeWindowValues`, and `diagnostics.buildDiagnostics` — all forwarding to `listAllTranscriptFiles`. `buildDiagnostics` also lists each configured root with `{dir, exists, readable, files}` so the user sees whether their folder has sessions.

### 3. Wire config → scanning (`electron-main.js`)
`computeHistoryPayload` is sync but `getState` is async, so cache the roots:
- Module var `scanRoots = { claude: [], codex: [] }`; load it after `ensureConfig` at startup and refresh it inside the `rate-limit:save-config` handler (:1361). Store `expandHome`-d absolute paths.
- Pass `scanRoots` into the three calls in `computeHistoryPayload` (:972-974) and `transcriptFingerprint` (:991).
- In the save-config handler, after saving, **clear `historyCache` + `historyFingerprint`** so the next `getUsageHistory` recomputes with the new folders.

### 4. Native folder picker
Add `dialog` to the electron import (:6-16); IPC `usage-history:pick-folder` → `dialog.showOpenDialog({ properties: ["openDirectory"] })` returning the path; expose `pickFolder()` in `preload.js`. Plus a manual path text input as fallback.

### 5. Diagnostics-tab UI (`public/history.html`, `public/history.js`)
In `#page-diagnostics`, below the scan breakdown, add a **Session folders** editor: two groups (Claude / Codex), each listing configured folders with a remove (×), an "Add folder…" button (picker + manual entry). Edits call `nativeApi.saveConfig(updatedConfig)` (fetched via `getState`), then re-fetch usage history to refresh. Add a **?** button by the Diagnostics heading that toggles a help panel.
- **State-aware help** (`renderHelp(d)`): build text from `d.diagnostics` — e.g. both found → "✓ all set"; Claude 0 → explain `~/.claude/projects`, add-folder, and the API/IDE caveat; Codex 0 → same for `~/.codex/sessions`; any root `readable:false` → "grant Full Disk Access"; a configured root with 0 files → "that folder has no .jsonl sessions — check the path." Generated each render from current state.
- Guard editor controls behind `nativeApi?.saveConfig`/`pickFolder` so the website demo (mock API) degrades to read-only; the help panel still renders from mock diagnostics.

### 6. Mirror to site + tests
- Copy `public/history.js` → `site/history.js`; add the same tab markup is already present; add minimal mock so the demo doesn't error (editor hidden without `saveConfig`).
- Tests: `sources` finds files in a configured extra root; `normalizeConfig`/`serializeConfig` round-trip `scanRoots` (with `~` expand/compact); `buildDiagnostics` lists configured roots + counts.

### 7. Publish
Bump to **0.2.2**; commit+push; build DMG; `gh release create v0.2.2`; reinstall; redeploy site.

## Files
- **Modify**: `server.js` (config), `usage-history/sources.js`, `usage-history/aggregate.js`, `usage-history/windows.js`, `usage-history/diagnostics.js`, `electron-main.js`, `preload.js`, `public/history.html`, `public/history.js`, `site/history.js`, `site/mock.js`, `package.json`
- **Tests**: extend `test/diagnostics.test.js`, `test/server.test.js`; maybe `test/windows.test.js`

## Verification
- `node --test` green.
- Real app: Diagnostics → **Add folder** pointing at a dir containing `.jsonl` → history/totals repopulate; remove it → reverts. **?** shows different guidance when Claude/Codex are present vs absent (force-empty by pointing only at empty dirs). Folder picker opens.
- Demo: Diagnostics tab + help render from mock; editor hidden (no `saveConfig`).
- Publish checks: `gh release view v0.2.2` has the DMG, latest-download resolves, installed app reports 0.2.2, live site loads.
