# Design

Usage Meter is a compact 3D instrument. The frame, readings and controls have physical depth. Every visible element identifies an account, communicates allowance, explains state, or performs an action. Standalone sculptures and the decorative slash have been removed.

## Purpose and hierarchy

| Element | Purpose and treatment |
| --- | --- |
| Account section | Provider and identity group each account directly on the chassis, without separate boxes. Sections share spare vertical space. |
| Provider and identity | The wide left column identifies the account. The service is prominent; identity is smaller, with ellipsis and a full tooltip. Short-term usage and reconnect actions sit below it. |
| Window label | Weekly captions sit below the right-hand circles. The 5-hour caption sits beside its inline percentage on the left. Tiny compact layouts use 9 px short-term captions; the Week reset label identifies the weekly ring. |
| Percentage | Centered in the loop, from 18 to 48 px, with a smaller percent mark. Tabular numerals keep updates steady. |
| Allowance loop | The colored arc gives the exact remaining share. Zero is empty and 100% is a seamless complete ring. Only weekly limits use rings, 56 px or wider (48 px at heights up to 175 px), in one aligned right-hand column. |
| Short-term allowance | A thin, exact line below the identity shows 5-hour allowance with its label and percentage. It uses the same provider, low and cached colors as weekly usage. |
| Reset details | Every reported window shows a labeled reset countdown below the account. Tooltips show the exact local reset date and time. |
| Refresh and History | Quiet icon controls stay visible in the footer, with 24 px hit targets and clear hover/focus states. |
| Status and updates | Appear only when useful. Cached and failure states remain explicit. |
| Chassis and lighting | A back plane, bevels, shallow perspective, and shared light make the entire interface a physical object. They add no content or extra controls. |
| Resize grip | The bottom-left grip and edge cursors expose resizing. Arrow keys move that corner in 8 px steps; Left enlarges and Right narrows the meter. |

The default outer width is **276 px**. Two connected accounts need approximately **212 px** of height; three need **286 px**. The user can drag any edge or corner, between **236–520 px** wide and **160–620 px** tall, constrained to the screen. A selected size persists across refresh, hide/show and restart. Account sections, weekly circles, short-term lines and percentages grow with the available space. No empty allowance column is reserved when an account has only a weekly limit. At 240 px height or below, accounts sit side by side with provider, weekly circle and short-term/reset detail stacked. The redundant app heading and identity text are hidden in this short layout; identity remains in the account tooltip. Both connected accounts fit at the 236 x 160 minimum. Below the readable content height, accounts scroll instead of compressing the circles or their text. Narrow transparent margins expose the edge; native vibrancy and native shadow are disabled so no flat window surrounds the object. The History window keeps its established dimensions and information layout.

## Screen-edge reveal

The meter lives flush against the right edge of the tray's display, 12 px below the top of its work area. Its right-side outer padding is removed, while the header text stays inset from the rounded corners with an explicit line height. It starts tucked away. Reaching the rightmost 3 px of the screen, from the top through the meter's height, slides it into view. The surface translates for 320 ms inside fixed transparent native bounds; its 3D orientation and selected size do not change. No additional visible launcher is needed.

Moving away starts a 350 ms dismissal delay; returning during it or during the slide reverses the retreat. The reveal has a short grace period to cross from the edge into the card. Rotation/resizing, native context menus and keyboard navigation keep it open. The menu-bar icon and Control+Option+L remain manual reveal controls. Reduced motion makes the transition immediate.

The native process polls actual cursor coordinates every 80 ms, including while the window is hidden. Retraction passes clicks through immediately and then hides the native window, stopping renderer animation. The popover body is a native `no-drag` region so macOS delivers clicks and rotation gestures even after the stage slides offscreen and returns. Resizing grows inward while keeping the same top-right attachment; selected dimensions survive hiding and restart. Display changes re-anchor the meter, and revealing never activates another Space.

## Color

Neutral graphite surfaces keep attention on the readings. Copper (`#e8ad83`) identifies Claude loops; jade (`#83d9b8`) identifies Codex loops. Remaining percentages stay neutral unless 15% or less remains, when the affected number and arc turn coral (`#ff8271`). Cached readings use grey and retain the `Cached` label; cached state takes precedence over low-allowance coloring. Text brightness separates primary values from labels and account metadata.

## Depth and motion

`public/spatial.css` places the popover in CSS perspective. The closed chassis is 14 px deep, with four straight side planes, eight facets per rounded corner and an outward-facing back. Account contents sit directly on the shared face; while rotated, labels, percentages, loops and controls occupy shallow raised layers. Side lighting follows the actual orientation. Back-facing data and controls are hidden and removed from keyboard interaction.

`public/spatial.js` adds symmetric hover tilt around the selected orientation. Dragging the body turns pitch and yaw freely through 360 degrees; Shift-drag spins around the face axis. The header also rotates the object; the native window stays attached to its corner. Double-clicking the body or pressing Escape resets to the front. The bottom-left rotation icon has been removed. The stage remains keyboard focusable from every orientation: arrows turn it, Shift-arrows spin it, and Home/Enter/Space reset it.

A quick release uses recent drag velocity to continue spinning, with continuously decreasing speed and a final stop exactly facing forward. Slow drags and gestures held still before release keep the selected angle. A new press catches a moving object; using a control or resizing also interrupts it. Slow-drag and caught angles are remembered locally under `usage-meter-orientation-v1`; completing a fling or reopening mid-flight returns to the front.

The complete volume is projected before each rotated pose is painted, scaling its presentation only as needed to fit the existing native window. Facing forward removes the perspective translation and raised text transforms so labels render at native size. The account list preserves 3D depth while its rows fit; only an overflowing list becomes a flat scroll container. Cached labels use clear system type without embossed text shadows, and authentication failures expose Sign in alongside the retained readings. Rotation never changes the user's saved dimensions. The animation loop stops when settled. Hiding the window finishes a coast at the front and stops its frame loop. SVG loops stay sharp as they grow, using normalized arc lengths and a solid stroke at 100%. Cached readings keep neutral rings. Reduced motion disables hover, momentum and easing, while keeping deliberate drag and keyboard rotation available. There is no decorative canvas or WebGL dependency.

Automatic native sizing measures the maximum intrinsic account height on each layout line before distributing spare space, plus gaps and padding, never transformed bounds. This supports both stacked rows and the short two-column layout. Growing the sections cannot inflate the next automatic minimum. Only an explicit resize handle changes manual dimensions; perspective movement cannot resize the window. Handles sit outside the transformed chassis and use screen-coordinate deltas. `electron-main.js` persists manual dimensions alongside position in `window-state.json`; older position-only files retain automatic fitting. Footer hover and cursor reconciliation preserve account layout and the resting text plane. Context menus, account actions, refresh, history access, and update behavior remain available.

## Usage History

The dashboard shares the graphite material and controls. Raised summary tiles and panels group related data; charts sit in recessed surfaces; tracks and calendar cells use depth to retain their shape against the background. Hovered panels tilt subtly without changing layout. Typography and chart colors keep their existing information roles. The header remains a native drag region with date-range and diagnostics controls.

## Files

- `public/index.html`, `public/app.js` — popover structure, real allowance state, actions, and native sizing.
- `public/sculpture.css` — base popover layout retained from the first redesign.
- `public/spatial.css`, `public/spatial.js` — shared whole-interface depth, lighting, and input handling.
- `public/history.html`, `public/history.js`, `public/ring.js` — History structure, unchanged analytics interactions, and allowance rings.
- `public/styles.css` — shared foundational styles, with the physical surface layer applied afterward.
- `public/liquid.js` — earlier liquid-row renderer, retained from existing work but not imported.

## Site parity

The 3D surface layer is local to the two desktop windows. The marketing site and its History demo are unchanged. Their analytics and interaction code remain intentionally aligned with the app.

## Reset countdowns

Each reported allowance has a visible labeled countdown beneath its account, including weekly-only and cached readings. Hover the summary or allowance for the exact reset date and time in the Mac’s local timezone. Countdown text updates every second without rebuilding allowance nodes or restarting percentage animations; waking or showing the app recalculates from the provider timestamp. Elapsed timestamps say `reset due` until the provider supplies a new window. Missing timestamps are explicitly labeled rather than guessed. Compact rows place reset summaries below short-term usage and above account actions.

At heights up to 175 px the compact view uses 48 px rings and folds the Weekly caption into the reset summary, reserving space for both countdown lines. Taller compact views retain 56 px minimum rings. Both accounts use the side-by-side view through 240 px height.
