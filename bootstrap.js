const os = require("os");
const path = require("path");
const { app, ipcMain, shell, dialog } = require("electron");
const { BootstrapUpdater } = require("./bootstrap-updater");

const updateRepo = process.env.USAGE_METER_UPDATE_REPO || "Samarth2709/UsageMeter";
const releaseBaseUrl = `https://github.com/${updateRepo}/releases/latest/download`;
const shellVersion = app.getVersion();
const staticShellPath = __dirname;
const fallbackCorePath = app.isPackaged ? path.join(process.resourcesPath, "core", "bundled") : __dirname;
const publicKey = require("fs").readFileSync(path.join(staticShellPath, "update-public-key.pem"), "utf8");
const updater = new BootstrapUpdater({
  app,
  shell,
  ipcMain,
  dataDir: path.join(os.homedir(), ".rate-limit-tool"),
  fallbackCorePath,
  shellVersion,
  publicKey,
  manifestUrl: process.env.USAGE_METER_UPDATE_MANIFEST_URL || `${releaseBaseUrl}/UsageMeter-core-manifest.json`,
  signatureUrl: process.env.USAGE_METER_UPDATE_SIGNATURE_URL || `${releaseBaseUrl}/UsageMeter-core-manifest.sig`,
  shellDownloadUrl: process.env.USAGE_METER_SHELL_DOWNLOAD_URL || `${releaseBaseUrl}/UsageMeter-arm64.dmg`
});

global.usageMeterCoreUpdater = updater;
global.__usageMeterBootstrapPreloadPath = path.join(staticShellPath, "preload.js");
global.__usageMeterShellVersion = shellVersion;
global.__usageMeterRegisterCoreWebContents = (webContents) => updater.registerCoreWebContents(webContents);
global.__usageMeterUnregisterCoreWebContents = (webContents) => updater.unregisterCoreWebContents(webContents);
updater.registerIpc();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
global.__usageMeterSingleInstanceLockAcquired = gotSingleInstanceLock;

if (!gotSingleInstanceLock) {
  app.quit();
} else (async () => {
  try {
    const corePath = await updater.selectCore();
    if (app.isPackaged) {
      const metadata = await require("./core-updater").assertCoreFiles(
        corePath,
        require(path.join(corePath, "core-version.json")).version
      );
      global.__usageMeterCoreVersion = metadata.version;
    } else {
      global.__usageMeterCoreVersion = shellVersion;
    }
    require(path.join(corePath, "electron-main.js"));
  } catch (error) {
    console.error("Usage Meter could not start a verified Core:", error);
    app.whenReady().then(() => {
      dialog.showErrorBox("Usage Meter could not start", "The installed Core could not be verified. Reinstall the latest Usage Meter DMG.");
      app.quit();
    });
  }
})();
