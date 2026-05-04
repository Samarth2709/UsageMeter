# Usage Meter

A small macOS menu bar app that shows:

- saved Codex account usage windows
- one Claude Code usage window
- a popover from the menu bar icon
- a `Control` + `Option` + `L` shortcut to show or hide the popover

## How it works

- Codex usage comes from the saved `auth.json` inside each configured `CODEX_HOME`, refreshes saved tokens when needed, then calls the same authenticated usage endpoint the installed client uses.
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

Install from the generated DMG:

```bash
open dist/Usage\ Meter-0.1.0-arm64.dmg
```

For the old browser/server debugging mode:

```bash
npm run server
```

Then open [http://localhost:4545](http://localhost:4545).

## Logging in

- Codex accounts are loaded from saved identities in `~/.rate-limit-tool/accounts.json` and `~/.rate-limit-tool/codex-identities`
- On refresh, the app can discover the current `~/.codex` login and persist it as a stable identity under `~/.rate-limit-tool/codex-identities`
- Saved Codex identities use their own stored auth, so switching the active `~/.codex` login does not disconnect previously saved identities unless that saved refresh token is revoked or expired
- `Claude Code` uses the machine's installed `claude` login

Click `Connect` on a row to open the right login command in Terminal. If two saved Codex identities resolve to the same OpenAI/Codex account, the app keeps the first one connected and marks the duplicate as not connected so it can be reconnected correctly.

## Optional Timer Automation

The 5-hour timer auto-start behavior is disabled by default. To enable it while running from source:

```bash
RATE_LIMIT_TOOL_AUTOSTART_ENABLED=1 npm start
```

Without that environment variable, the app only displays limits and does not send any Codex or Claude messages.
