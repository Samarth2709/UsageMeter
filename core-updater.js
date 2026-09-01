const crypto = require("crypto");
const { EventEmitter } = require("events");
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { atomicWriteJson } = require("./atomic-file");

const execFileAsync = promisify(execFile);
const CORE_STATE_FILE = "current.json";
const CORE_VERSION_FILE = "core-version.json";
const CORE_MANIFEST_FILE = "manifest.json";
const CORE_SIGNATURE_FILE = "manifest.sig";
const CORE_CONTROL_FILES = new Set([CORE_MANIFEST_FILE, CORE_SIGNATURE_FILE]);
const UPDATE_FETCH_TIMEOUT_MS = 30_000;
const UPDATE_TEXT_LIMIT_BYTES = 2 * 1024 * 1024;
const UPDATE_ARCHIVE_LIMIT_BYTES = 256 * 1024 * 1024;
const REQUIRED_CORE_FILES = [
  "electron-main.js",
  "server.js",
  "usage-windows.js",
  "public/index.html",
  "public/app.js",
  "node_modules/express/package.json"
];

function compareVersions(a, b) {
  const left = String(a || "").replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || "").replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isSafeVersion(version) {
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version);
}

function assertSafeRelativePath(entry) {
  if (typeof entry !== "string" || !entry || entry.includes("\\") || path.posix.isAbsolute(entry)) {
    throw new Error("Update archive contains an unsafe path.");
  }

  const normalized = path.posix.normalize(entry);
  if (normalized === ".." || normalized.startsWith("../") || !normalized.startsWith("core/")) {
    throw new Error("Update archive must contain only a top-level core directory.");
  }
}

function assertSafeCorePath(entry) {
  if (typeof entry !== "string" || !entry || entry.includes("\\") || path.posix.isAbsolute(entry)) {
    throw new Error("Core manifest contains an unsafe file path.");
  }
  const normalized = path.posix.normalize(entry);
  if (normalized !== entry || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Core manifest contains an unsafe file path.");
  }
  if (CORE_CONTROL_FILES.has(entry)) {
    throw new Error("Core manifest must not include its control files.");
  }
}

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error("Update archive is empty.");
  }
  for (const entry of entries) assertSafeRelativePath(entry);
  return true;
}

function parseArchiveListing(listing) {
  const entries = [];
  for (const line of String(listing || "").split("\n")) {
    if (!line.trim()) continue;
    if (!/^[\-d]/.test(line)) {
      throw new Error("Update archive contains a non-regular file.");
    }
    const match = line.match(/\s(?:\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2}\s+\d{1,2})\s+[^\s]+\s+(.+)$/);
    if (!match) {
      throw new Error("Could not validate update archive entries.");
    }
    entries.push(match[1]);
  }
  return entries;
}

function validateManifest(manifest, { shellVersion, expectedArchiveOrigin } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Update manifest is not an object.");
  }

  const { version, minShellVersion, archiveUrl, archiveSha256, files } = manifest;
  if (!isSafeVersion(version) || !isSafeVersion(minShellVersion)) {
    throw new Error("Update manifest has an invalid version.");
  }
  if (typeof archiveUrl !== "string" || !archiveUrl) {
    throw new Error("Update manifest has no archive URL.");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(archiveSha256 || ""))) {
    throw new Error("Update manifest has an invalid archive hash.");
  }
  if (!files || typeof files !== "object" || Array.isArray(files) || !Object.keys(files).length) {
    throw new Error("Update manifest has no Core file hashes.");
  }
  const filePaths = Object.keys(files);
  if (filePaths.join("\n") !== [...filePaths].sort().join("\n")) {
    throw new Error("Update manifest Core file hashes must be sorted.");
  }
  for (const relativePath of filePaths) {
    assertSafeCorePath(relativePath);
    if (!/^[a-f0-9]{64}$/i.test(String(files[relativePath] || ""))) {
      throw new Error("Update manifest has an invalid Core file hash.");
    }
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(archiveUrl);
  } catch {
    throw new Error("Update manifest has an invalid archive URL.");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("Update archive URL must use HTTP(S).");
  }
  if (expectedArchiveOrigin && parsedUrl.origin !== expectedArchiveOrigin) {
    throw new Error("Update archive URL has an unexpected origin.");
  }
  if (shellVersion && compareVersions(shellVersion, minShellVersion) < 0) {
    const error = new Error("This update needs a newer Usage Meter shell.");
    error.code = "SHELL_REQUIRED";
    error.minShellVersion = minShellVersion;
    throw error;
  }
  return manifest;
}

function verifySignedManifest(manifestText, signatureText, publicKey, options = {}) {
  const signature = Buffer.from(String(signatureText || "").trim(), "base64");
  if (!signature.length || !crypto.verify(null, Buffer.from(manifestText), publicKey, signature)) {
    throw new Error("Update manifest signature is invalid.");
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("Update manifest is not valid JSON.");
  }
  return validateManifest(manifest, options);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await atomicWriteJson(filePath, value);
}

function normalizeInstallState(raw) {
  const safeVersion = (value) => isSafeVersion(value) ? value : null;
  const activeVersion = safeVersion(raw?.activeVersion);
  const previousVersion = safeVersion(raw?.previousVersion);
  const pendingVersion = safeVersion(raw?.pendingVersion);
  const pendingLaunches = Number.isSafeInteger(raw?.pendingLaunches) && raw.pendingLaunches >= 0
    ? raw.pendingLaunches
    : 0;
  return {
    activeVersion,
    previousVersion: previousVersion === activeVersion ? null : previousVersion,
    pendingVersion: pendingVersion === activeVersion ? pendingVersion : null,
    pendingLaunches: pendingVersion === activeVersion ? pendingLaunches : 0,
    healthyVersion: safeVersion(raw?.healthyVersion)
  };
}

async function readResponseBytes(response, limitBytes, tooLargeMessage) {
  if (!response.body) throw new Error("Update response had no body.");
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > limitBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(tooLargeMessage);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, received);
}

async function assertCoreFiles(corePath, expectedVersion) {
  for (const relativePath of REQUIRED_CORE_FILES) {
    await fs.access(path.join(corePath, relativePath));
  }
  const metadata = await readJson(path.join(corePath, CORE_VERSION_FILE));
  if (!metadata || metadata.version !== expectedVersion) {
    throw new Error("Installed Core version metadata does not match the update.");
  }
  return metadata;
}

async function listCoreFiles(corePath, relativePath = "", files = {}) {
  const directoryPath = path.join(corePath, relativePath);
  const directoryStats = await fs.lstat(directoryPath);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error("Installed Core contains an unsafe directory.");
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childPath = path.join(corePath, childRelativePath);
    const childStats = await fs.lstat(childPath);
    if (childStats.isSymbolicLink()) {
      throw new Error("Installed Core contains a symbolic link.");
    }
    if (childStats.isDirectory()) {
      await listCoreFiles(corePath, childRelativePath, files);
      continue;
    }
    if (!childStats.isFile()) {
      throw new Error("Installed Core contains a non-regular file.");
    }
    if (!CORE_CONTROL_FILES.has(childRelativePath)) {
      assertSafeCorePath(childRelativePath);
      files[childRelativePath] = sha256(await fs.readFile(childPath));
    }
  }
  return files;
}

async function assertCoreContents(corePath, manifest) {
  const expectedFiles = manifest.files;
  const actualFiles = await listCoreFiles(corePath);
  const expectedPaths = Object.keys(expectedFiles);
  const actualPaths = Object.keys(actualFiles).sort();
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((entry, index) => entry !== expectedPaths[index])) {
    throw new Error("Installed Core files do not match its signed manifest.");
  }
  for (const relativePath of expectedPaths) {
    if (actualFiles[relativePath] !== expectedFiles[relativePath].toLowerCase()) {
      throw new Error("Installed Core file failed its integrity check.");
    }
  }
  return assertCoreFiles(corePath, manifest.version);
}

async function listArchiveEntries(archivePath) {
  const { stdout } = await execFileAsync("/usr/bin/tar", ["-tvzf", archivePath], { maxBuffer: 16 * 1024 * 1024 });
  return validateArchiveEntries(parseArchiveListing(stdout));
}

async function extractArchive(archivePath, destination) {
  await listArchiveEntries(archivePath);
  await execFileAsync("/usr/bin/tar", ["-xzf", archivePath, "-C", destination], { maxBuffer: 16 * 1024 * 1024 });
}

async function removePath(target) {
  await fs.rm(target, { recursive: true, force: true });
}

class CoreUpdater extends EventEmitter {
  constructor({
    dataDir,
    fallbackCorePath,
    shellVersion,
    publicKey,
    manifestUrl,
    signatureUrl,
    shellDownloadUrl,
    fetchImpl = global.fetch,
    retain = 2
  }) {
    super();
    this.dataDir = dataDir;
    this.coresDir = path.join(dataDir, "cores");
    this.statePath = path.join(this.coresDir, CORE_STATE_FILE);
    this.fallbackCorePath = fallbackCorePath;
    this.shellVersion = shellVersion;
    this.publicKey = publicKey;
    this.manifestUrl = manifestUrl;
    this.signatureUrl = signatureUrl;
    this.shellDownloadUrl = shellDownloadUrl;
    this.fetchImpl = fetchImpl;
    this.retain = retain;
    this.state = { status: "idle", available: false };
    this.installState = null;
    this.runningVersion = null;
    this.downloadPromise = null;
  }

  getState() {
    return { ...this.state };
  }

  setState(next) {
    this.state = { ...this.state, ...next };
    this.emit("state", this.getState());
    return this.state;
  }

  async loadInstallState() {
    if (this.installState) return this.installState;
    this.installState = normalizeInstallState((await readJson(this.statePath, null)) || {
      activeVersion: null,
      previousVersion: null,
      pendingVersion: null,
      pendingLaunches: 0,
      healthyVersion: null
    });
    return this.installState;
  }

  async saveInstallState() {
    await writeJsonAtomic(this.statePath, this.installState);
  }

  corePath(version) {
    return path.join(this.coresDir, version);
  }

  async verifyInstalledCore(version) {
    if (!isSafeVersion(version)) throw new Error("Installed Core has an unsafe version.");
    const corePath = this.corePath(version);
    const [manifestText, signatureText] = await Promise.all([
      fs.readFile(path.join(corePath, CORE_MANIFEST_FILE), "utf8"),
      fs.readFile(path.join(corePath, CORE_SIGNATURE_FILE), "utf8")
    ]);
    const manifest = verifySignedManifest(manifestText, signatureText, this.publicKey, {
      shellVersion: this.shellVersion
    });
    if (manifest.version !== version) throw new Error("Installed Core version does not match its manifest.");
    await assertCoreContents(corePath, manifest);
    return corePath;
  }

  async selectCore() {
    const state = await this.loadInstallState();
    const bundledVersion = (
      await readJson(path.join(this.fallbackCorePath, CORE_VERSION_FILE), {})
    ).version || this.shellVersion;
    const resetBelowBundledCore = () => {
      if (!state.activeVersion || compareVersions(state.activeVersion, bundledVersion) >= 0) {
        return false;
      }
      state.activeVersion = null;
      state.previousVersion = null;
      state.pendingVersion = null;
      state.pendingLaunches = 0;
      state.healthyVersion = null;
      return true;
    };
    if (resetBelowBundledCore()) {
      await this.saveInstallState();
    }
    if (state.pendingVersion && state.pendingVersion === state.activeVersion) {
      if (state.pendingLaunches >= 1) {
        state.activeVersion = state.previousVersion || null;
        state.pendingVersion = null;
        state.pendingLaunches = 0;
        await this.saveInstallState();
      } else {
        state.pendingLaunches += 1;
        await this.saveInstallState();
      }
    }
    if (resetBelowBundledCore()) {
      await this.saveInstallState();
    }

    if (state.activeVersion) {
      try {
        const corePath = await this.verifyInstalledCore(state.activeVersion);
        this.runningVersion = state.activeVersion;
        return corePath;
      } catch (error) {
        console.warn(`Ignoring invalid installed Core ${state.activeVersion}: ${error.message}`);
        const previousVersion = state.previousVersion;
        state.activeVersion = null;
        state.previousVersion = null;
        state.pendingVersion = null;
        state.pendingLaunches = 0;
        state.healthyVersion = null;
        if (previousVersion && compareVersions(previousVersion, bundledVersion) >= 0) {
          try {
            const corePath = await this.verifyInstalledCore(previousVersion);
            state.activeVersion = previousVersion;
            state.healthyVersion = previousVersion;
            await this.saveInstallState();
            this.runningVersion = previousVersion;
            return corePath;
          } catch (previousError) {
            console.warn(`Ignoring invalid previous Core ${previousVersion}: ${previousError.message}`);
          }
        }
        await this.saveInstallState();
      }
    }
    this.runningVersion = bundledVersion;
    return this.fallbackCorePath;
  }

  async reportHealthy() {
    const state = await this.loadInstallState();
    if (this.runningVersion && state.activeVersion === this.runningVersion) {
      state.healthyVersion = this.runningVersion;
      state.pendingVersion = null;
      state.pendingLaunches = 0;
      await this.saveInstallState();
    }
  }

  async fetchText(url) {
    if (typeof this.fetchImpl !== "function") throw new Error("Updates are unavailable in this environment.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: "application/json, text/plain", "User-Agent": "UsageMeter" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Update request failed (${response.status}).`);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > UPDATE_TEXT_LIMIT_BYTES) {
        throw new Error("Update metadata is too large.");
      }
      return (await readResponseBytes(
        response,
        UPDATE_TEXT_LIMIT_BYTES,
        "Update metadata is too large."
      )).toString("utf8");
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("Update request timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchManifest() {
    const [manifestText, signatureText] = await Promise.all([
      this.fetchText(this.manifestUrl),
      this.fetchText(this.signatureUrl)
    ]);
    const expectedArchiveOrigin = new URL(this.manifestUrl).origin;
    const manifest = verifySignedManifest(manifestText, signatureText, this.publicKey, {
      shellVersion: this.shellVersion,
      expectedArchiveOrigin
    });
    return { manifest, manifestText, signatureText };
  }

  async checkForUpdate() {
    if (this.state.status === "downloaded") return this.getState();
    try {
      const { manifest, manifestText, signatureText } = await this.fetchManifest();
      const state = await this.loadInstallState();
      const runningVersion = this.runningVersion || (await readJson(path.join(this.fallbackCorePath, CORE_VERSION_FILE), {})).version || "0.0.0";
      if (compareVersions(manifest.version, runningVersion) <= 0) {
        this.setState({ status: "idle", available: false, version: null, error: null });
        return this.getState();
      }
      this.setState({
        status: "available",
        available: true,
        version: manifest.version,
        manifest,
        manifestText,
        signatureText,
        error: null
      });
      return this.getState();
    } catch (error) {
      if (error.code === "SHELL_REQUIRED") {
        this.setState({
          status: "shell-required",
          available: true,
          version: null,
          minShellVersion: error.minShellVersion,
          shellDownloadUrl: this.shellDownloadUrl,
          error: null
        });
      }
      return this.getState();
    }
  }

  downloadUpdate() {
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = this.downloadUpdateImpl().finally(() => {
      this.downloadPromise = null;
    });
    return this.downloadPromise;
  }

  async downloadUpdateImpl() {
    const current = this.getState();
    if (current.status === "shell-required") return current;
    if (!current.manifest || !current.manifestText || !current.signatureText) {
      await this.checkForUpdate();
    }
    const update = this.getState();
    if (!update.manifest) throw new Error("No verified update is available.");

    const { manifest, manifestText, signatureText } = update;
    const stagingRoot = path.join(this.coresDir, ".staging");
    const stagingDir = path.join(stagingRoot, `${manifest.version}-${Date.now()}`);
    const archivePath = path.join(stagingDir, "core.tar.gz");
    const extractedRoot = path.join(stagingDir, "extracted");
    this.setState({ status: "downloading", available: true, progress: 0, error: null });

    try {
      await fs.mkdir(extractedRoot, { recursive: true });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
      const digest = crypto.createHash("sha256");
      let archiveHandle;
      try {
        const response = await this.fetchImpl(manifest.archiveUrl, {
          headers: { Accept: "application/octet-stream", "User-Agent": "UsageMeter" },
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Update download failed (${response.status}).`);
        const total = Number(response.headers.get("content-length")) || null;
        if (total && total > UPDATE_ARCHIVE_LIMIT_BYTES) {
          throw new Error("Update archive is too large.");
        }
        let received = 0;
        if (!response.body) throw new Error("Update download had no body.");
        archiveHandle = await fs.open(archivePath, "wx", 0o600);
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > UPDATE_ARCHIVE_LIMIT_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error("Update archive is too large.");
          }
          digest.update(value);
          await archiveHandle.write(value);
          if (total) this.setState({ progress: Math.min(99, Math.round((received / total) * 100)) });
        }
        await archiveHandle.sync();
        await archiveHandle.close();
        archiveHandle = null;
      } catch (error) {
        if (error?.name === "AbortError") throw new Error("Update download timed out.");
        throw error;
      } finally {
        clearTimeout(timeout);
        await archiveHandle?.close().catch(() => {});
      }
      if (digest.digest("hex") !== manifest.archiveSha256.toLowerCase()) {
        throw new Error("Downloaded update failed its integrity check.");
      }
      await extractArchive(archivePath, extractedRoot);
      const extractedCore = path.join(extractedRoot, "core");
      await fs.writeFile(path.join(extractedCore, CORE_MANIFEST_FILE), manifestText, { mode: 0o600 });
      await fs.writeFile(path.join(extractedCore, CORE_SIGNATURE_FILE), signatureText, { mode: 0o600 });
      await assertCoreContents(extractedCore, manifest);
      await this.activateCore(extractedCore, manifest.version);
      this.setState({ status: "downloaded", available: true, version: manifest.version, progress: 100, error: null });
      return this.getState();
    } catch (error) {
      this.setState({ status: "failed", available: true, error: error.message, progress: null });
      throw error;
    } finally {
      await removePath(stagingDir);
    }
  }

  async activateCore(stagedCorePath, version) {
    const state = await this.loadInstallState();
    const destination = this.corePath(version);
    await fs.mkdir(this.coresDir, { recursive: true });
    await removePath(destination);
    await fs.rename(stagedCorePath, destination);
    state.previousVersion = state.activeVersion === version ? state.previousVersion : state.activeVersion || state.previousVersion || null;
    state.activeVersion = version;
    state.pendingVersion = version;
    state.pendingLaunches = 0;
    await this.saveInstallState();
    try {
      await this.retainCores();
    } catch (error) {
      console.warn(`Could not remove older Cores: ${error.message}`);
    }
  }

  async retainCores() {
    const state = await this.loadInstallState();
    const preserve = new Set([state.activeVersion, state.previousVersion].filter(Boolean));
    const entries = await fs.readdir(this.coresDir, { withFileTypes: true });
    const candidates = entries.filter((entry) => entry.isDirectory() && isSafeVersion(entry.name));
    const removable = candidates.filter((entry) => !preserve.has(entry.name));
    removable.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of removable.slice(Math.max(0, this.retain - preserve.size))) {
      await removePath(path.join(this.coresDir, entry.name));
    }
  }
}

module.exports = {
  CORE_MANIFEST_FILE,
  CORE_SIGNATURE_FILE,
  CORE_STATE_FILE,
  CORE_VERSION_FILE,
  CoreUpdater,
  assertCoreContents,
  assertCoreFiles,
  compareVersions,
  extractArchive,
  sha256,
  validateArchiveEntries,
  validateManifest,
  verifySignedManifest,
  normalizeInstallState,
  writeJsonAtomic
};
