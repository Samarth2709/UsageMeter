# Rate Limit Tool

A small macOS menu bar app that shows:

- two Codex account usage windows
- one Claude Code usage window
- a popover from the menu bar icon
- a `Control` + `Option` + `L` shortcut to show or hide the popover

## How it works

- Codex usage comes from the local `auth.json` inside each configured `CODEX_HOME`, then calls the same authenticated usage endpoint the installed client uses.
- Claude usage comes from the installed `claude` CLI by opening `/status` in a pseudo-terminal and reading the Usage tab.

## Run it

```bash
npm install
npm start
```

The app opens as a desktop popover and also adds a menu bar icon. Click the icon or press `Control` + `Option` + `L` to show or hide it.

For the old browser/server debugging mode:

```bash
npm run server
```

Then open [http://localhost:4545](http://localhost:4545).

## Package it

```bash
npm run dist:mac
```

The packaged app artifacts are written to `dist/`.

## Logging in

- `Codex Account 1` defaults to `~/.codex`
- `Codex Account 2` defaults to `~/.rate-limit-tool/codex-account-2`
- `Claude Code` uses the machine's installed `claude` login

Use the `Open Login` button on each card to open the right login command in Terminal.
