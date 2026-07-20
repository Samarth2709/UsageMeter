#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};
const manifestPath = valueFor("--manifest");
const keyPath = valueFor("--private-key");
const signaturePath = valueFor("--signature");

if (!manifestPath || !keyPath || !signaturePath) {
  throw new Error("Usage: sign-core-manifest.js --manifest <path> --private-key <path> --signature <path>");
}

const signature = crypto.sign(null, fs.readFileSync(manifestPath), fs.readFileSync(keyPath));
fs.writeFileSync(signaturePath, `${signature.toString("base64")}\n`, { mode: 0o600 });
