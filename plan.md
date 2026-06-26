# Subscription Value — per-window API-dollar worth

**Goal:** On the history dashboard's **Economics** page, show how much API-priced value each
live limit window (Codex 5H/Week, Claude 5H/Week) has delivered, and the projected full-window
value, so a flat-subscription user can see "$ of API usage received."

## Numbers
- **$ used (per window):** sum of API-priced tokens from local transcripts whose timestamp falls
  in `[resetAt − duration, min(now, resetAt)]`. duration: 5-hour = 5h, weekly = 7d.
- **% used + resetAt:** from the live snapshot (same data as the popover).
- **Projected full:** `clampedPct = min(%used, 100)`. `pct ≥ 100` → "full" (projected = $used);
  `5 ≤ pct < 100` → `$used ÷ (pct/100)`; `pct < 5` → null (too little signal).
- **Caveat:** $used is local transcripts on this machine only; %used is server-side (all devices).

## Tasks
1. `usage-history/windows.js` — `computeWindowValues({ homeDir, nowMs, limits })`.
   Reuses `sources.listAllTranscriptFiles`, the parsers (event-level `timestampMs`), and
   `pricing.priceRecord`. Only reads files with mtime within the last 7 days. + unit tests.
2. `electron-main.js` `usage-history:get` — collect live windows from `latestSnapshot.results`,
   call `computeWindowValues`, attach as `payload.windowValues`.
3. `public/history.html` — add `Subscription value` block (`#ec-value` + caveat note) to the
   Economics section.
4. `public/history.js` `renderEconomics` — render `d.windowValues` grouped by provider; degrade
   gracefully when absent.
5. Mirror to `site/demo.html`, `site/history.js`, `site/mock.js` (mock windowValues).
6. Verify: `node --test`; open history → Economics in the running app and read it back.
