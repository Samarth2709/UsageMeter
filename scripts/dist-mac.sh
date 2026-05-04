#!/usr/bin/env bash
set -euo pipefail

project_root=$(pwd)
build_output=$(mktemp -d /tmp/usage-meter-build.XXXXXX)
app_path="$build_output/mac-arm64/Usage Meter.app"
entitlements_path="$project_root/node_modules/app-builder-lib/templates/entitlements.mac.plist"
trap 'rm -rf "$build_output"' EXIT

npm run clean
npx electron-builder \
  --mac dir \
  --config.mac.identity=null \
  --config.directories.output="$build_output"

sleep 1
. scripts/clear-macos-xattrs.sh "$app_path"
sign_app() {
  codesign \
    --force \
    --deep \
    --timestamp \
    --options runtime \
    --entitlements "$entitlements_path" \
    --sign - \
    "$app_path"
}

if ! sign_app; then
  sleep 1
  . scripts/clear-macos-xattrs.sh "$app_path"
  sign_app
fi

npx electron-builder \
  --mac dmg zip \
  --prepackaged "$app_path" \
  --config.mac.identity=null \
  --config.directories.output="$build_output"

mkdir -p "$project_root/dist"
find "$build_output" -maxdepth 1 -type f \( -name "*.dmg" -o -name "*.zip" -o -name "*.blockmap" -o -name "*.yaml" \) \
  -exec cp {} "$project_root/dist/" \;
