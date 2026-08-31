# Releasing

Desktop-runtime pushes to `main` are released by `.github/workflows/release-desktop.yml`. Site-only and documentation-only pushes do not create a desktop release; `site/**` still deploys to Vercel through its own workflow.

## What users receive

Each desktop release publishes these public GitHub Release assets:

- `UsageMeter-arm64.dmg` and the matching ZIP for first installs and bootstrap/Electron upgrades.
- `UsageMeter-core-<version>.tar.gz`, `UsageMeter-core-manifest.json`, and `UsageMeter-core-manifest.sig` for verified in-app Core updates.

The fixed shell embeds `update-public-key.pem`. It accepts a Core only when the manifest signature, archive SHA-256, archive paths, Core metadata, minimum shell version, and signed SHA-256 map of every Core file all match. It repeats that exact file check on each later launch, rejecting modified, missing, extra, or symlinked files. The downloaded Core is staged under `~/.rate-limit-tool/cores/`, then made active with an atomic pointer write. The user explicitly chooses **Restart now**; rollback protection clears only after the registered popover renderer completes initialization and reports healthy through fixed preload IPC.

## Automation prerequisites

The repository needs these Action settings/secrets:

- `VERCEL_TOKEN` for website deployment.
- `USAGE_METER_CORE_SIGNING_PRIVATE_KEY_B64`, an Ed25519 PKCS#8 private key encoded as base64. Its matching public key is committed as `update-public-key.pem`.
- GitHub Actions **Read and write permissions** for repository contents, or equivalent workflow token permissions, so the workflow can push its patch-version commit, tag, and release.

Never commit or print the private key. Replacing the key is a shell change: publish a new DMG containing the new public key before signing Core releases with the new private key.

## Normal desktop release flow

For a push that changes a packaged runtime path, the workflow:

1. Serializes desktop releases and coalesces queued runtime pushes: a queued run exits when its source commit is already contained in the latest published release.
2. Installs dependencies, runs `npm test`, builds the unsigned Apple Silicon shell DMG/ZIP and Core archive, signs the manifest, and verifies every asset before changing Git history.
3. Builds and verifies the prepared patch version, then commits that version and atomically pushes the release commit and tag together only after every asset check passes.
4. Uploads every asset to a draft release, checks the release asset list, and only then publishes it. A rerun or manual workflow dispatch rebuilds and completes a tagged draft/missing release at the same version instead of bumping again.

Routine changes to `electron-main.js`, `server.js`, `usage-history/`, `public/`, or other listed runtime inputs become Core updates. A change to the fixed shell or its packaging inputs (`bootstrap.js`, `bootstrap-updater.js`, `core-updater.js`, `atomic-file.js`, `preload.js`, the public key, package manifests, or the DMG build script) also publishes a DMG and automatically raises `package.json`’s `usageMeter.minimumShellVersion` to that release version, so older shells open the DMG path instead of loading an incompatible Core.

## Local packaging and verification

```bash
npm ci
npm test
npm run dist:mac
open dist/UsageMeter-arm64.dmg
```

Install the resulting app in `/Applications`, then check the menu bar, `Control` + `Option` + `L`, live refresh, Usage History, and launch-at-login. The current package is ad-hoc signed and not notarized, so Gatekeeper may still block a downloaded build. A fully trusted installation requires an Apple Developer ID certificate plus notarization credentials in the release environment; until those are configured, follow the website’s documented quarantine-clear instructions.

To test the updater without GitHub, point the three `USAGE_METER_UPDATE_*` URLs at a local fixture release and use a generated test Ed25519 key. The test suite covers signing, exact installed-Core file checks, hash failures, archive safety, concurrent download serialization, activation, retention, rollback, renderer-health authorization, IPC labels, and a local archive update path.

## Post-release verification

```bash
gh release view v<version>
curl -I -L https://github.com/Samarth2709/UsageMeter/releases/latest/download/UsageMeter-arm64.dmg
curl -I -L https://github.com/Samarth2709/UsageMeter/releases/latest/download/UsageMeter-core-manifest.json
```

Confirm both stable URLs redirect to the new public release. Manually install the first shell with the updater once, then verify that a later compatible runtime release shows **Update available**, downloads, and opens at the new Core version after **Restart now**.

## Website deployment

The Vercel workflow runs for `site/**` changes. It does not need or inspect the Core signing secret. The marketing Download links use GitHub’s `releases/latest/download/UsageMeter-arm64.dmg` URL, so they always resolve to the newest published desktop release.
