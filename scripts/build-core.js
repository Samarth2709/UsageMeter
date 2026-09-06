#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};
const packageJson = require(path.join(root, "package.json"));
const version = valueFor("--version") || packageJson.version;
const outDir = path.resolve(root, valueFor("--out") || "build/core");
const archivePath = valueFor("--archive") && path.resolve(root, valueFor("--archive"));

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Invalid Core version: ${version}`);
}

async function copy(relativePath) {
  await fsp.cp(path.join(root, relativePath), path.join(outDir, relativePath), { recursive: true });
}

async function main() {
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });
  for (const entry of ["assets", "public", "usage-history", "atomic-file.js", "electron-main.js", "server.js", "claude-web-usage.js", "usage-windows.js", "pricing.js", "package-lock.json"]) {
    await copy(entry);
  }

  const corePackage = {
    ...packageJson,
    version,
    main: "electron-main.js"
  };
  await fsp.writeFile(path.join(outDir, "package.json"), `${JSON.stringify(corePackage, null, 2)}\n`);
  await fsp.writeFile(
    path.join(outDir, "core-version.json"),
    `${JSON.stringify({ version, minShellVersion: packageJson.usageMeter.minimumShellVersion }, null, 2)}\n`
  );
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: outDir, stdio: "inherit" });
  // Package-manager command shims are symbolic links and are not needed when
  // Electron runs this Core. Removing them keeps the signed Core file set
  // strictly regular-file-only.
  await fsp.rm(path.join(outDir, "node_modules", ".bin"), { recursive: true, force: true });

  if (archivePath) {
    await fsp.mkdir(path.dirname(archivePath), { recursive: true });
    execFileSync("tar", ["-czf", archivePath, "-C", path.dirname(outDir), path.basename(outDir)], { stdio: "inherit" });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
