const { CoreUpdater } = require("./core-updater");

class BootstrapUpdater extends CoreUpdater {
  constructor({ app, shell, ipcMain, publicKey, ...options }) {
    super({ publicKey, ...options });
    this.app = app;
    this.shell = shell;
    this.ipcMain = ipcMain;
    this.started = false;
    this.coreWebContentsId = null;
  }

  registerIpc() {
    this.ipcMain.handle("update:get", () => this.getState());
    this.ipcMain.handle("update:download", () => this.downloadUpdate());
    this.ipcMain.on("update:restart", () => this.restart());
    this.ipcMain.on("update:open-shell", () => this.openShellDownload());
    this.ipcMain.on("core:healthy", (event) => {
      this.reportCoreHealthy(event.sender).catch((error) => {
        console.warn(`Could not record healthy Core startup: ${error.message}`);
      });
    });
    this.on("state", (state) => {
      for (const webContents of this.webContents()) {
        webContents.send("update:state", state);
      }
    });
  }

  webContents() {
    try {
      return require("electron").webContents.getAllWebContents().filter((contents) => !contents.isDestroyed());
    } catch {
      return [];
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (!this.app.isPackaged && !process.env.USAGE_METER_UPDATE_MANIFEST_URL) return;
    this.checkForUpdate();
    this.timer = setInterval(() => this.checkForUpdate(), 6 * 60 * 60 * 1000);
  }

  registerCoreWebContents(webContents) {
    if (!webContents || webContents.isDestroyed?.()) return;
    this.coreWebContentsId = webContents.id;
  }

  unregisterCoreWebContents(webContents) {
    if (webContents?.id === this.coreWebContentsId) this.coreWebContentsId = null;
  }

  async reportCoreHealthy(webContents) {
    if (!webContents || webContents.isDestroyed?.() || webContents.id !== this.coreWebContentsId) return false;
    await this.reportHealthy();
    return true;
  }

  restart() {
    if (this.state.status !== "downloaded") return;
    this.app.relaunch();
    this.app.exit(0);
  }

  openShellDownload() {
    return this.shell.openExternal(this.shellDownloadUrl);
  }
}

module.exports = { BootstrapUpdater };
