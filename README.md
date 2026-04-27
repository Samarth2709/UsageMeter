# Usage Meter

A small macOS menu bar app that shows:

- two Codex account usage windows
- one Claude Code usage window
- a popover from the menu bar icon
- a `Control` + `Option` + `L` shortcut to show or hide the popover

## How it works

- Codex usage comes from the local `auth.json` inside each configured `CODEX_HOME`, then calls the same authenticated usage endpoint the installed client uses.
- Claude usage comes from the installed `claude` CLI by opening `/status` in a pseudo-terminal and reading the Usage tab.

## Run it

Run the desktop widget from source:

```bash
npm install
npm start
```

The app opens as a small desktop popover and adds a menu bar icon. Click the menu bar icon or press `Control` + `Option` + `L` to show or hide it.

The widget starts in a waiting state. Click the refresh icon in the top-right corner to load the latest limits. After that, the app refreshes once per minute.

## Run the Packaged App

Build the macOS app:

```bash
npm run dist:mac
```

Open the generated app from:

```bash
open dist/mac-arm64/Usage\ Meter.app
```

Or install from the generated DMG:

```bash
open dist/Usage\ Meter-0.1.0-arm64.dmg
```

For the old browser/server debugging mode:

```bash
npm run server
```

Then open [http://localhost:4545](http://localhost:4545).

## Logging in

- `Codex Account 1` defaults to `~/.codex`
- `Codex Account 2` defaults to `~/.rate-limit-tool/codex-account-2`
- `Claude Code` uses the machine's installed `claude` login

Click `Connect` on a row to open the right login command in Terminal. For the second Codex account, make sure the browser login is completed with the other OpenAI/Codex account. If both Codex slots log in to the same account, the app keeps the first one connected and marks the second one as not connected so it can be reconnected correctly.

## Optional Timer Automation

The 5-hour timer auto-start behavior is disabled by default. To enable it while running from source:

```bash
RATE_LIMIT_TOOL_AUTOSTART_ENABLED=1 npm start
```

Without that environment variable, the app only displays limits and does not send any Codex or Claude messages.
