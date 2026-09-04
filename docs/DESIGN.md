# Design

Usage Meter is a compact 3D instrument. The frame, account panels, tracks, and controls have physical depth. Every visible element identifies an account, communicates allowance, explains state, or performs an action. Standalone sculptures and the decorative slash have been removed.

## Purpose and hierarchy

| Element | Purpose and treatment |
| --- | --- |
| Account panel | One raised surface groups one account. Connected rows are 76 px tall for compact scanning. |
| Provider and identity | The first line answers which account. The service is prominent; identity is smaller, with ellipsis and a full tooltip. |
| Window label | Placed beside its percentage so 5-hour and weekly values cannot be confused. |
| Percentage | The largest type (20 px) gives the exact remaining allowance. Tabular numerals keep updates steady. |
| Recessed track | Its filled width is the exact remaining share, providing a quick comparison independently of the number. A weekly-only allowance spans its row. |
| Reset details | Appear beside the relevant data on hover or keyboard focus, with the full reset time in a tooltip. |
| Refresh and History | Raised controls stay visible in the footer. Their depth indicates a pressable action. |
| Status and updates | Appear only when useful. Cached and failure states remain explicit. |
| Chassis and lighting | A back plane, bevels, shallow perspective, and shared light make the entire interface a physical object. They add no content or extra controls. |
| Resize grip | The lower-right grip and edge cursors expose manual resizing; the grip also accepts arrow keys in 8 px steps. |

The default outer width is **276 px**. Two accounts use **236 px** of height; three use **318 px**. The user can drag any edge or corner, between **236–520 px** wide and **160–620 px** tall, constrained to the screen. A selected size persists across refresh, hide/show and restart. Additional content scrolls inside it. Narrow transparent margins expose the edge; native vibrancy and native shadow are disabled so no flat window surrounds the object. The History window keeps its established dimensions and information layout.

## Screen-edge reveal

The meter lives flush against the right edge of the tray's display, 12 px below the top of its work area. Its right-side outer padding is removed, while the header text stays inset from the rounded corners with an explicit line height. It starts tucked away. Reaching the rightmost 3 px of the screen, from the top through the meter's height, slides it into view. The surface translates for 320 ms inside fixed transparent native bounds; its 3D orientation and selected size do not change. No additional visible launcher is needed.

Moving away starts a 350 ms dismissal delay; returning during it or during the slide reverses the retreat. The reveal has a short grace period to cross from the edge into the card. Rotation/resizing, native context menus and keyboard navigation keep it open. The menu-bar icon and Control+Option+L remain manual reveal controls. Reduced motion makes the transition immediate.

The native process polls actual cursor coordinates every 80 ms, including while the window is hidden. Retraction passes clicks through immediately and then hides the native window, stopping renderer animation. Resizing grows inward while keeping the same top-right attachment; selected dimensions survive hiding and restart. Display changes re-anchor the meter, and revealing never activates another Space.

## Color

Neutral graphite surfaces keep attention on the readings. Copper (`#e8ad83`) identifies Claude tracks; jade (`#83d9b8`) identifies Codex tracks. Remaining percentages stay neutral unless 15% or less remains, when the affected number and track turn coral (`#ff8271`). Cached readings use grey and retain the `Cached` label; cached state takes precedence over low-allowance coloring. Text brightness separates primary values from labels and account metadata.

## Depth and motion

`public/spatial.css` places the popover in CSS perspective. The closed chassis is 14 px deep, with four straight side planes, eight facets per rounded corner and an outward-facing back. Account panels sit above an inset base; labels, percentages, and controls occupy shallow raised layers; the allowance tracks are recessed channels. Side lighting follows the actual orientation. Back-facing data and controls are hidden and removed from keyboard interaction.

`public/spatial.js` adds symmetric hover tilt around the selected orientation. Dragging the body turns pitch and yaw freely through 360 degrees; Shift-drag spins around the face axis. The header also rotates the object; the native window stays attached to its corner. Double-clicking the body or pressing Escape resets to the front. The bottom-left rotation icon has been removed. The stage remains keyboard focusable from every orientation: arrows turn it, Shift-arrows spin it, and Home/Enter/Space reset it.

A quick release uses recent drag velocity to continue spinning, with continuously decreasing speed and a final stop exactly facing forward. Slow drags and gestures held still before release keep the selected angle. A new press catches a moving object; using a control or resizing also interrupts it. Slow-drag and caught angles are remembered locally under `usage-meter-orientation-v1`; completing a fling or reopening mid-flight returns to the front.

The complete volume is projected before each pose is painted, scaling its presentation only as needed to fit the existing native window. Rotation never changes the user's saved dimensions. The animation loop stops when settled. Hiding the window finishes a coast at the front and stops its frame loop. CSS animates liquid highlights inside live allowance fills without changing their exact widths. Cached bars remain still and hidden windows pause the animation. Reduced motion disables hover, flow, momentum and easing, while keeping deliberate drag and keyboard rotation available. There is no decorative canvas or WebGL dependency.

Automatic native sizing uses layout heights, gaps, and padding, never transformed bounds. Only an explicit resize handle changes manual dimensions; perspective movement cannot resize the window. Handles sit outside the transformed chassis and use screen-coordinate deltas. `electron-main.js` persists manual dimensions alongside position in `window-state.json`; older position-only files retain automatic fitting. Context menus, account actions, refresh, history access, and update behavior remain available.

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
