# Releasing

As of 2026-07-18, this repository has source version **0.2.5** but its newest Git tag/release is **v0.2.3**. Publishing a release is an external action; do it only after the source, package metadata, and generated artifacts have been reviewed.

## Preflight

```bash
git status --short --branch
git log -1 --oneline
npm ci
npm test
git diff --check
node -p "require('./package.json').version"
```

Confirm that the package version is the intended release version, `main` is the desired commit, and the working tree contains no unrelated changes.

## Build and smoke-test

```bash
npm run clean
npm run dist:mac
open dist/UsageMeter-arm64.dmg
```

Install the resulting app in `/Applications`, open it, and check:

1. The app bundle reports the intended version and uses the Usage Meter icon.
2. The menu-bar icon and `Control` + `Option` + `L` open the popover.
3. Codex and Claude refresh paths show real data or an honest error state.
4. Usage History opens, Diagnostics lists sources, and the static site demo remains functional.
5. The first packaged launch enables the macOS login item. Confirm it can still be disabled in System Settings.

Do not launch a disposable build from `dist/` merely to test Login Items: it can register a temporary app path. Test the copy installed in `/Applications`.

## Publish

After explicit approval, create and push a version tag, then attach the DMG and ZIP to a GitHub release:

```bash
git tag -a v<version> -m "Usage Meter <version>"
git push origin main v<version>
gh release create v<version> \
  dist/UsageMeter-arm64.dmg \
  "dist/Usage Meter-<version>-arm64-mac.zip" \
  --title "Usage Meter <version>" \
  --generate-notes
```

Replace `<version>` with the exact `package.json` version. Verify that the stable artifact name is `UsageMeter-arm64.dmg`; the README's download link depends on it.

## Website deployment

The GitHub Actions workflow deploys `site/` to Vercel production on pushes to `main` that touch `site/**` or `.github/workflows/deploy-site.yml`.

- It requires the repository secret `VERCEL_TOKEN`.
- Without that secret, the workflow intentionally exits successfully without deploying.
- `site/.vercel/` is ignored local linkage metadata; keep it private and uncommitted.

If a release changes the dashboard demo, publish the source/site change first and then verify the production website. A version-only GitHub release does not redeploy the site.

## Post-release verification

```bash
gh release view v<version>
curl -I -L https://github.com/Samarth2709/UsageMeter/releases/latest/download/UsageMeter-arm64.dmg
```

Confirm the release assets, redirect target, and installed app version. Leave `dist/` out of Git; it may be removed with `npm run clean` after assets have been uploaded and independently verified.
