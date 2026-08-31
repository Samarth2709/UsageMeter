const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function temporaryPath(filePath) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
}

function syncDirectorySync(directoryPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, "r");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await fsp.open(directoryPath, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function atomicWriteFileSync(filePath, data, { mode = 0o600, directoryMode = 0o700 } = {}) {
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, { recursive: true, mode: directoryMode });
  const tempPath = temporaryPath(filePath);
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, "wx", mode);
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, mode);
    syncDirectorySync(directoryPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

async function atomicWriteFile(filePath, data, { mode = 0o600, directoryMode = 0o700 } = {}) {
  const directoryPath = path.dirname(filePath);
  await fsp.mkdir(directoryPath, { recursive: true, mode: directoryMode });
  const tempPath = temporaryPath(filePath);
  let handle;
  try {
    handle = await fsp.open(tempPath, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tempPath, filePath);
    await fsp.chmod(filePath, mode);
    await syncDirectory(directoryPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function atomicWriteJsonSync(filePath, value, options = {}) {
  const { pretty = true, ...fileOptions } = options;
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, fileOptions);
}

function atomicWriteJson(filePath, value, options = {}) {
  const { pretty = true, ...fileOptions } = options;
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, fileOptions);
}

module.exports = {
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJson,
  atomicWriteJsonSync
};
