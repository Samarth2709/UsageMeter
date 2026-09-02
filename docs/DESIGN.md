# Design

Usage Meter follows the macOS design language: system type, system materials, hairline separators, grouped inset surfaces, and one signature element per surface. It follows the system light or dark appearance automatically.

## Principles

- Native first. System font (SF Pro via `-apple-system`), rounded numerals (`ui-rounded`) for the figures that matter, semantic system colors, 10–14 px continuous corners.
- One accent, used for state. Service tints identify Claude and Codex. System red appears only when an allowance is nearly exhausted or something failed. Nothing else is colored.
- Quiet chrome. No eyebrow labels, no pulsing text, no decoration that is not data. Separators are hairlines; surfaces are translucent materials or low-alpha fills.
- Structure encodes meaning. A filled band is an allowance. A row is an account. A card is a data set. Nothing is decorated for its own sake.

## Signature: the row is the meter

The popover is almost nothing but the meters. Each account row's background runs edge to edge and is split into one full-width band per allowance window: the 5-hour band on top at half height (20 px) with a smaller percent, the weekly band below at full height (40 px). A weekly-only row keeps the full height. Each band is the service tint up to the remaining share and nothing after it: the unfilled remainder is the popover material. The leading (right) edge is a calm sea: a clip-path polygon generated from several small sine waves (a few pixels of amplitude) that travel in opposite directions at different speeds and pass through each other, sampled densely in time and looped over 18–23 s so the motion stays fluid and never repeats visibly. The two bands run different seas. A soft highlight bobs along the edge and a slow shimmer drifts through the fill. The keyframes are generated: edit the wave components in `scripts/generate-waves.js` and run it rather than editing `waves-a`/`waves-b` by hand. At 15 % or less remaining a fill turns system red and breathes.

By default a row shows only the service name (in its brand face) and the remaining percent of each band. Identity, window labels and reset times are hidden until the pointer rests on the row, when they slide in between the name and the number. There is no title. A bottom bar carries the status text (only when something needs attention), the update pill (only when an update exists), and two faint icons: refresh and Usage History.

Motion: fills are real widths (`--r1`, `--r2` on the row), so they sweep in from zero on first data and glide between values on later refreshes. The percent counts up in step. Rows fade up in a short stagger when the popover opens, and hovering a row darkens its fill slightly so the revealed text stays readable. All of it respects reduced motion.

The Usage History dashboard marks each live allowance with a small ring (`public/ring.js`) showing the same remaining share.

## Tokens (`public/styles.css`)

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--label` | `#1d1d1f` | `#f5f5f7` | Primary text |
| `--secondary` | `rgba(60,60,67,.6)` | `rgba(235,235,245,.6)` | Secondary text |
| `--tertiary` | `rgba(60,60,67,.3)` | `rgba(235,235,245,.3)` | Tertiary text, ring tracks |
| `--separator` | `rgba(60,60,67,.14)` | `rgba(255,255,255,.1)` | Hairlines |
| `--fill` | `rgba(120,120,128,.08)` | `rgba(120,120,128,.18)` | Grouped surfaces |
| `--material` | `rgba(246,246,246,.84)` | `rgba(36,36,38,.76)` | Popover material over vibrancy |
| `--window-bg` | `#f5f5f7` | `#1e1e1e` | Dashboard window background |
| `--tint-claude` | `#d9734c` | `#e8895f` | Claude |
| `--tint-codex` | `#1f8f4c` | `#1f9d57` | Codex |
| `--blue` | `#007aff` | `#0a84ff` | Update pill, links, focus ring |
| `--red` | `#ff3b30` | `#ff453a` | Low allowance, errors |

## Type scale

| Role | Size / weight | Face |
| --- | --- | --- |
| Popover title, account name, section title | 13 px / 600 | system |
| Service names over meters | Claude 15 px / 500, Codex 13.5 px / 600 | `--font-claude` (Copernicus → New York), `--font-codex` (OpenAI Sans → SF) |
| Text over a meter fill | as above | `--on-meter` / `--on-meter-2`, with a hairline shadow in dark |
| Window label, body | 12 px / 400 | system |
| Secondary, reset times, notes | 11 px / 400 | system |
| Allowance percent, stat value | 13 px and 22 px / 600 | `ui-rounded`, tabular |

## Surfaces

**Popover** (`public/index.html`): frameless, transparent Electron window with `vibrancy: "popover"` and an always-active visual effect state so the material stays lit while the window is shown inactive. Content sits on `--material` with a 14 px radius. Body: one meter row per account, banded per allowance window. Bottom bar: status (hidden when healthy), update pill (hidden when none), refresh and history icons.

**Usage History** (`public/history.html`): standard window with a hidden-inset title bar. The header doubles as the toolbar and drag region and carries the range segmented control and the diagnostics toggle. Content is a single column of grouped cards on `--window-bg`: four stat tiles, live allowances, daily usage, top models and projects, cumulative spend, cost calendar and most expensive days, and the diagnostics panel when open.

## Charts

Bars have rounded tops and no gridlines; the two service tints are the only chart colors. The cumulative line is a 1.5 px stroke over a soft tint fill. The calendar uses five alpha steps of the accent blue. Tooltips are small material cards.

## Site parity

`site/history.js` is a credential-free mirror of the dashboard behavior and keeps its own stylesheet. The app redesign is not mirrored to the site; port the tokens above when the site is next touched.
