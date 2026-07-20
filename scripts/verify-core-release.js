#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  assertCoreContents,
  extractArchive,
  sha256,
  verifySignedManifest
} = require("../core-updater");

const args = process.argv.slice(2);
const valuesFor = (flag) => args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);
const valueFor = (flag) => valuesFor(flag)[0];
const archivePath = valueFor("--archive");
const manifestPath = valueFor("--manifest");
const signaturePath = valueFor("--signature");
const publicKeyPath = valueFor("--public-key");
const requiredFiles = valuesFor("--required");

if (![archivePath, manifestPath, signaturePath, publicKeyPath].every(Boolean)) {
  throw new Error("Usage: verify-core-release.js --archive <path> --manifest <path> --signature <path> --public-key <path> [--required <path>]");
}
for (const filePath of [...requiredFiles, archivePath, manifestPath, signaturePath, publicKeyPath]) {
  if (!fs.statSync(filePath).isFile() || fs.statSync(filePath).size === 0) {
    throw new Error(`Release artifact is missing or empty: ${filePath}`);
  }
}

async function main() {
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const signatureText = fs.readFileSync(signaturePath, "utf8");
  const manifest = verifySignedManifest(manifestText, signatureText, fs.readFileSync(publicKeyPath, "utf8"));
  const archive = fs.readFileSync(archivePath);
  if (sha256(archive) !== manifest.archiveSha256) throw new Error("Core archive hash does not match its signed manifest.");

  const stagingPath = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-release-"));
  try {
    await extractArchive(archivePath, stagingPath);
    const corePath = path.join(stagingPath, "core");
    fs.writeFileSync(path.join(corePath, "manifest.json"), manifestText, { mode: 0o600 });
    fs.writeFileSync(path.join(corePath, "manifest.sig"), signatureText, { mode: 0o600 });
    await assertCoreContents(corePath, manifest);
  } finally {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
