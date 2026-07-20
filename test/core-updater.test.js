const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CORE_STATE_FILE,
  CoreUpdater,
  assertCoreContents,
  compareVersions,
  sha256,
  validateArchiveEntries,
  verifySignedManifest
} = require("../core-updater");
const { BootstrapUpdater } = require("../bootstrap-updater");
const { describeUpdate } = require("../public/update-state");

const keys = crypto.generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });

function fixtureRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "usage-meter-core-"));
}

function signedManifest(manifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  return {
    text,
    signature: `${crypto.sign(null, Buffer.from(text), privateKey).toString("base64")}\n`
  };
}

async function writeCore(root, version) {
  const core = path.join(root, "core");
  await fs.mkdir(path.join(core, "public"), { recursive: true });
  await fs.mkdir(path.join(core, "node_modules", "express"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(core, "electron-main.js"), "module.exports = {};\n"),
    fs.writeFile(path.join(core, "server.js"), "module.exports = {};\n"),
    fs.writeFile(path.join(core, "usage-windows.js"), "module.exports = {};\n"),
    fs.writeFile(path.join(core, "public", "index.html"), "<!doctype html>\n"),
    fs.writeFile(path.join(core, "public", "app.js"), "\n"),
    fs.writeFile(path.join(core, "node_modules", "express", "package.json"), "{}\n"),
    fs.writeFile(path.join(core, "core-version.json"), `${JSON.stringify({ version })}\n`)
  ]);
  return core;
}

async function copyCore(source, destination) {
  await fs.cp(source, destination, { recursive: true });
}

async function coreFileHashes(corePath, relativePath = "", files = {}) {
  const directoryPath = path.join(corePath, relativePath);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childPath = path.join(corePath, childRelativePath);
    if (entry.isDirectory()) {
      await coreFileHashes(corePath, childRelativePath, files);
    } else if (entry.isFile()) {
      files[childRelativePath] = sha256(await fs.readFile(childPath));
    }
  }
  return files;
}

async function coreManifest({ version, archiveUrl, archive, corePath, minShellVersion = "0.2.6" }) {
  return {
    version,
    minShellVersion,
    archiveUrl,
    archiveSha256: sha256(archive),
    files: Object.fromEntries(Object.entries(await coreFileHashes(corePath)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
  };
}

async function archiveCore(root, corePath, version) {
  const source = path.join(root, `archive-${version}`);
  await fs.mkdir(source, { recursive: true });
  await copyCore(corePath, path.join(source, "core"));
  const archive = path.join(root, `core-${version}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", source, "core"]);
  return fs.readFile(archive);
}

async function installSignedCore(updater, root, sourceCore, version) {
  const archive = await archiveCore(root, sourceCore, version);
  const manifest = await coreManifest({
    version,
    archiveUrl: `https://updates.example/${version}.tar.gz`,
    archive,
    corePath: sourceCore
  });
  const signed = signedManifest(manifest);
  const destination = updater.corePath(version);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await copyCore(sourceCore, destination);
  await fs.writeFile(path.join(destination, "manifest.json"), signed.text);
  await fs.writeFile(path.join(destination, "manifest.sig"), signed.signature);
  return { archive, manifest, signed, destination };
}

function fetchFrom(values) {
  return async (url) => {
    const value = values.get(url);
    if (value === undefined) return new Response("Not found", { status: 404 });
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
}

async function updaterFixture(root, { shellVersion = "0.2.6", fallbackVersion = "0.2.6", fetchImpl } = {}) {
  const fallbackRoot = path.join(root, "fallback");
  const fallbackCorePath = await writeCore(fallbackRoot, fallbackVersion);
  return new CoreUpdater({
    dataDir: path.join(root, "data"),
    fallbackCorePath,
    shellVersion,
    publicKey,
    manifestUrl: "https://updates.example/UsageMeter-core-manifest.json",
    signatureUrl: "https://updates.example/UsageMeter-core-manifest.sig",
    shellDownloadUrl: "https://updates.example/UsageMeter-arm64.dmg",
    fetchImpl
  });
}

test("signed manifests reject altered bytes and too-new shells", () => {
  const manifest = {
    version: "0.2.7",
    minShellVersion: "0.2.6",
    archiveUrl: "https://updates.example/UsageMeter-core-0.2.7.tar.gz",
    archiveSha256: "a".repeat(64),
    files: { "electron-main.js": "b".repeat(64) }
  };
  const signed = signedManifest(manifest);
  assert.equal(verifySignedManifest(signed.text, signed.signature, publicKey, { shellVersion: "0.2.6" }).version, "0.2.7");
  assert.throws(() => verifySignedManifest(`${signed.text} `, signed.signature, publicKey), /signature/i);
  assert.throws(
    () => verifySignedManifest(signed.text, signed.signature, publicKey, { shellVersion: "0.2.5" }),
    (error) => error.code === "SHELL_REQUIRED"
  );
});

test("release manifest scripts produce a verifiable artifact", async () => {
  const root = await fixtureRoot();
  try {
    const archivePath = path.join(root, "core.tar.gz");
    const manifestPath = path.join(root, "manifest.json");
    const signaturePath = path.join(root, "manifest.sig");
    const keyPath = path.join(root, "signing-key.pem");
    const corePath = await writeCore(root, "0.2.7");
    await fs.writeFile(archivePath, "fixture archive");
    await fs.writeFile(keyPath, privateKey);
    execFileSync(process.execPath, [
      "scripts/create-core-manifest.js",
      "--version", "0.2.7",
      "--min-shell-version", "0.2.6",
      "--archive", archivePath,
      "--archive-url", "https://updates.example/UsageMeter-core-0.2.7.tar.gz",
      "--core", corePath,
      "--out", manifestPath
    ], { cwd: path.resolve(__dirname, "..") });
    execFileSync(process.execPath, [
      "scripts/sign-core-manifest.js",
      "--manifest", manifestPath,
      "--private-key", keyPath,
      "--signature", signaturePath
    ], { cwd: path.resolve(__dirname, "..") });
    const verified = verifySignedManifest(
      await fs.readFile(manifestPath, "utf8"),
      await fs.readFile(signaturePath, "utf8"),
      publicKey,
      { shellVersion: "0.2.6", expectedArchiveOrigin: "https://updates.example" }
    );
    assert.equal(verified.archiveSha256, sha256(Buffer.from("fixture archive")));
    assert.equal(verified.files["electron-main.js"], sha256(await fs.readFile(path.join(corePath, "electron-main.js"))));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("archive validation rejects traversal, absolute paths, and links", () => {
  assert.equal(validateArchiveEntries(["core/", "core/public/index.html"]), true);
  assert.throws(() => validateArchiveEntries(["../core/electron-main.js"]), /archive/i);
  assert.throws(() => validateArchiveEntries(["/core/electron-main.js"]), /unsafe/i);
  assert.throws(() => validateArchiveEntries(["core\\electron-main.js"]), /unsafe/i);
});

test("downloaded Core activates atomically and survives a healthy restart", async () => {
  const root = await fixtureRoot();
  try {
    const sourceCore = await writeCore(path.join(root, "source"), "0.2.7");
    const archive = await archiveCore(root, sourceCore, "0.2.7");
    const manifest = await coreManifest({
      version: "0.2.7",
      archiveUrl: "https://updates.example/UsageMeter-core-0.2.7.tar.gz",
      archive,
      corePath: sourceCore
    });
    const signed = signedManifest(manifest);
    const fetchImpl = fetchFrom(new Map([
      ["https://updates.example/UsageMeter-core-manifest.json", signed.text],
      ["https://updates.example/UsageMeter-core-manifest.sig", signed.signature],
      [manifest.archiveUrl, archive]
    ]));
    const updater = await updaterFixture(root, { fetchImpl });

    await updater.checkForUpdate();
    assert.equal(updater.getState().status, "available");
    await updater.downloadUpdate();
    assert.equal(updater.getState().status, "downloaded");
    const pointer = JSON.parse(await fs.readFile(path.join(root, "data", "cores", CORE_STATE_FILE), "utf8"));
    assert.equal(pointer.activeVersion, "0.2.7");
    assert.equal(pointer.pendingVersion, "0.2.7");

    const restarted = await updaterFixture(root, { fetchImpl });
    assert.match(await restarted.selectCore(), /0\.2\.7$/);
    await restarted.reportHealthy();
    const healthyRestart = await updaterFixture(root, { fetchImpl });
    assert.match(await healthyRestart.selectCore(), /0\.2\.7$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a hash failure leaves the active Core untouched", async () => {
  const root = await fixtureRoot();
  try {
    const sourceCore = await writeCore(path.join(root, "source"), "0.2.7");
    const archive = await archiveCore(root, sourceCore, "0.2.7");
    const manifest = await coreManifest({
      version: "0.2.7",
      archiveUrl: "https://updates.example/UsageMeter-core-0.2.7.tar.gz",
      archive,
      corePath: sourceCore
    });
    manifest.archiveSha256 = "0".repeat(64);
    const signed = signedManifest(manifest);
    const fetchImpl = fetchFrom(new Map([
      ["https://updates.example/UsageMeter-core-manifest.json", signed.text],
      ["https://updates.example/UsageMeter-core-manifest.sig", signed.signature],
      [manifest.archiveUrl, archive]
    ]));
    const updater = await updaterFixture(root, { fetchImpl });
    await updater.checkForUpdate();
    await assert.rejects(() => updater.downloadUpdate(), /integrity/i);
    assert.equal(updater.getState().status, "failed");
    assert.match(await updater.selectCore(), /fallback[\\/]core$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a Core that never reports healthy rolls back on the next launch", async () => {
  const root = await fixtureRoot();
  try {
    const first = await updaterFixture(root);
    const sourceA = await writeCore(path.join(root, "source-a"), "0.2.6");
    const sourceB = await writeCore(path.join(root, "source-b"), "0.2.7");
    for (const [version, source] of [["0.2.6", sourceA], ["0.2.7", sourceB]]) {
      const archive = await archiveCore(root, source, version);
      const manifest = await coreManifest({
        version,
        archiveUrl: `https://updates.example/${version}.tar.gz`,
        archive,
        corePath: source
      });
      const signed = signedManifest(manifest);
      const destination = first.corePath(version);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await copyCore(source, destination);
      await fs.writeFile(path.join(destination, "manifest.json"), signed.text);
      await fs.writeFile(path.join(destination, "manifest.sig"), signed.signature);
    }
    first.installState = {
      activeVersion: "0.2.7",
      previousVersion: "0.2.6",
      pendingVersion: "0.2.7",
      pendingLaunches: 0,
      healthyVersion: "0.2.6"
    };
    await first.saveInstallState();
    assert.match(await first.selectCore(), /0\.2\.7$/);

    const afterFailedLaunch = await updaterFixture(root);
    assert.match(await afterFailedLaunch.selectCore(), /0\.2\.6$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Core retention keeps only active and previous versions", async () => {
  const root = await fixtureRoot();
  try {
    const updater = await updaterFixture(root);
    await fs.mkdir(updater.coresDir, { recursive: true });
    for (const version of ["0.2.6", "0.2.7", "0.2.8"]) {
      await fs.mkdir(updater.corePath(version));
    }
    updater.installState = { activeVersion: "0.2.8", previousVersion: "0.2.7" };
    await updater.retainCores();
    const versions = (await fs.readdir(updater.coresDir)).filter((name) => /^\d/.test(name)).sort();
    assert.deepEqual(versions, ["0.2.7", "0.2.8"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("installed Core verification rejects altered, extra, and symlinked files", async () => {
  const root = await fixtureRoot();
  try {
    const updater = await updaterFixture(root);
    const sourceCore = await writeCore(path.join(root, "source"), "0.2.7");
    const { manifest, destination } = await installSignedCore(updater, root, sourceCore, "0.2.7");
    await assertCoreContents(destination, manifest);

    await fs.appendFile(path.join(destination, "electron-main.js"), "// changed\n");
    await assert.rejects(() => assertCoreContents(destination, manifest), /integrity/i);
    await fs.rm(path.join(destination, "electron-main.js"));
    await fs.copyFile(path.join(sourceCore, "electron-main.js"), path.join(destination, "electron-main.js"));

    await fs.writeFile(path.join(destination, "injected.js"), "module.exports = 'unexpected';\n");
    await assert.rejects(() => assertCoreContents(destination, manifest), /files do not match/i);
    await fs.rm(path.join(destination, "injected.js"));

    await fs.symlink(path.join(destination, "electron-main.js"), path.join(destination, "linked-main.js"));
    await assert.rejects(() => assertCoreContents(destination, manifest), /symbolic link/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("corrupt active and previous Cores reset state and expose the newest update", async () => {
  const root = await fixtureRoot();
  try {
    const sourceA = await writeCore(path.join(root, "source-a"), "0.2.7");
    const sourceB = await writeCore(path.join(root, "source-b"), "0.2.8");
    const sourceC = await writeCore(path.join(root, "source-c"), "0.2.9");
    const archiveC = await archiveCore(root, sourceC, "0.2.9");
    const manifestC = await coreManifest({
      version: "0.2.9",
      archiveUrl: "https://updates.example/0.2.9.tar.gz",
      archive: archiveC,
      corePath: sourceC
    });
    const signedC = signedManifest(manifestC);
    const fetchImpl = fetchFrom(new Map([
      ["https://updates.example/UsageMeter-core-manifest.json", signedC.text],
      ["https://updates.example/UsageMeter-core-manifest.sig", signedC.signature],
      [manifestC.archiveUrl, archiveC]
    ]));
    const initial = await updaterFixture(root, { fetchImpl });
    const installedA = await installSignedCore(initial, root, sourceA, "0.2.7");
    const installedB = await installSignedCore(initial, root, sourceB, "0.2.8");
    await fs.appendFile(path.join(installedA.destination, "electron-main.js"), "// corrupt\n");
    await fs.appendFile(path.join(installedB.destination, "electron-main.js"), "// corrupt\n");
    initial.installState = {
      activeVersion: "0.2.8",
      previousVersion: "0.2.7",
      pendingVersion: "0.2.8",
      pendingLaunches: 0,
      healthyVersion: "0.2.7"
    };
    await initial.saveInstallState();

    const restarted = await updaterFixture(root, { fetchImpl });
    assert.match(await restarted.selectCore(), /fallback[\\/]core$/);
    const pointer = JSON.parse(await fs.readFile(path.join(root, "data", "cores", CORE_STATE_FILE), "utf8"));
    assert.deepEqual(pointer, {
      activeVersion: null,
      previousVersion: null,
      pendingVersion: null,
      pendingLaunches: 0,
      healthyVersion: null
    });
    await restarted.checkForUpdate();
    assert.equal(restarted.getState().status, "available");
    assert.equal(restarted.getState().version, "0.2.9");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("duplicate downloads share one activation and preserve Restart now", async () => {
  const root = await fixtureRoot();
  try {
    const sourceCore = await writeCore(path.join(root, "source"), "0.2.7");
    const archive = await archiveCore(root, sourceCore, "0.2.7");
    const manifest = await coreManifest({
      version: "0.2.7",
      archiveUrl: "https://updates.example/0.2.7.tar.gz",
      archive,
      corePath: sourceCore
    });
    const signed = signedManifest(manifest);
    const updater = await updaterFixture(root, {
      fetchImpl: fetchFrom(new Map([
        ["https://updates.example/UsageMeter-core-manifest.json", signed.text],
        ["https://updates.example/UsageMeter-core-manifest.sig", signed.signature],
        [manifest.archiveUrl, archive]
      ]))
    });
    await updater.checkForUpdate();
    const firstDownload = updater.downloadUpdate();
    const secondDownload = updater.downloadUpdate();
    assert.equal(firstDownload, secondDownload);
    await firstDownload;
    const pointer = JSON.parse(await fs.readFile(path.join(root, "data", "cores", CORE_STATE_FILE), "utf8"));
    assert.equal(pointer.activeVersion, "0.2.7");
    assert.equal(pointer.previousVersion, null);
    await updater.checkForUpdate();
    assert.equal(updater.getState().status, "downloaded");
    assert.equal(updater.getState().version, "0.2.7");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("only the registered Core popover can acknowledge healthy renderer startup", async () => {
  const root = await fixtureRoot();
  try {
    const ipcMain = { handle() {}, on() {} };
    const updater = new BootstrapUpdater({
      app: {},
      shell: {},
      ipcMain,
      dataDir: path.join(root, "data"),
      fallbackCorePath: await writeCore(path.join(root, "fallback"), "0.2.6"),
      shellVersion: "0.2.6",
      publicKey,
      manifestUrl: "https://updates.example/manifest.json",
      signatureUrl: "https://updates.example/manifest.sig",
      shellDownloadUrl: "https://updates.example/UsageMeter-arm64.dmg",
      fetchImpl: fetchFrom(new Map())
    });
    updater.installState = {
      activeVersion: "0.2.7",
      previousVersion: "0.2.6",
      pendingVersion: "0.2.7",
      pendingLaunches: 1,
      healthyVersion: "0.2.6"
    };
    updater.runningVersion = "0.2.7";
    updater.registerCoreWebContents({ id: 41, isDestroyed: () => false });
    assert.equal(await updater.reportCoreHealthy({ id: 42, isDestroyed: () => false }), false);
    assert.equal(updater.installState.pendingVersion, "0.2.7");
    assert.equal(await updater.reportCoreHealthy({ id: 41, isDestroyed: () => false }), true);
    assert.equal(updater.installState.pendingVersion, null);

    const [electronMain, preload, renderer] = await Promise.all([
      fs.readFile(path.resolve(__dirname, "..", "electron-main.js"), "utf8"),
      fs.readFile(path.resolve(__dirname, "..", "preload.js"), "utf8"),
      fs.readFile(path.resolve(__dirname, "..", "public", "app.js"), "utf8")
    ]);
    assert.doesNotMatch(electronMain, /did-finish-load[\s\S]*reportHealthy/);
    assert.match(preload, /reportCoreHealthy/);
    assert.match(renderer, /reportCoreHealthy/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("desktop release workflow validates artifacts before atomically pushing a release", async () => {
  const workflow = await fs.readFile(path.resolve(__dirname, "..", ".github", "workflows", "release-desktop.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /git push --atomic origin HEAD:main/);
  assert.match(workflow, /gh release create .*--draft/);
  assert.ok(workflow.indexOf("Build, sign, and verify release assets") < workflow.indexOf("Commit and atomically tag the verified release"));
});

test("renderer update labels cover every IPC state", () => {
  assert.equal(describeUpdate({ status: "available", version: "0.2.7" }).label, "Update available");
  assert.equal(describeUpdate({ status: "downloading", progress: 38 }).label, "Downloading 38%");
  assert.equal(describeUpdate({ status: "downloaded" }).label, "Restart now");
  assert.equal(describeUpdate({ status: "failed" }).label, "Retry update");
  assert.equal(describeUpdate({ status: "shell-required" }).label, "Get new app");
});

test("version comparison accepts release-style values", () => {
  assert.equal(compareVersions("v0.2.7", "0.2.6"), 1);
  assert.equal(compareVersions("0.2.7", "0.2.7"), 0);
});
