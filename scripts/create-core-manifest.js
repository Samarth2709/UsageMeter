#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};
const version = valueFor("--version");
const minShellVersion = valueFor("--min-shell-version");
const archivePath = valueFor("--archive");
const archiveUrl = valueFor("--archive-url");
const corePath = valueFor("--core");
const outputPath = valueFor("--out");

if (![version, minShellVersion, archivePath, archiveUrl, corePath, outputPath].every(Boolean)) {
  throw new Error("Usage: create-core-manifest.js --version <version> --min-shell-version <version> --archive <path> --archive-url <url> --core <directory> --out <path>");
}
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d+\.\d+\.\d+$/.test(minShellVersion)) {
  throw new Error("Core and minimum shell versions must be semver triples.");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function collectCoreFiles(rootPath, relativePath = "", files = {}) {
  const directoryPath = path.join(rootPath, relativePath);
  const directoryStats = fs.lstatSync(directoryPath);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error("Core contains an unsafe directory.");
  }

  const entries = fs.readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childPath = path.join(rootPath, childRelativePath);
    const childStats = fs.lstatSync(childPath);
    if (childStats.isSymbolicLink()) throw new Error("Core contains a symbolic link.");
    if (childStats.isDirectory()) {
      collectCoreFiles(rootPath, childRelativePath, files);
    } else if (childStats.isFile()) {
      files[childRelativePath] = hashFile(childPath);
    } else {
      throw new Error("Core contains a non-regular file.");
    }
  }
  return files;
}

const files = Object.fromEntries(Object.entries(collectCoreFiles(path.resolve(corePath))).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));

const manifest = {
  version,
  minShellVersion,
  archiveUrl,
  archiveSha256: crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex"),
  files
};
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
