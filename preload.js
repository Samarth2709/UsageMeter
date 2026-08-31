const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rateLimitAPI", {
  getState: () => ipcRenderer.invoke("rate-limit:get-state"),
  getSnapshot: () => ipcRenderer.invoke("rate-limit:get-snapshot"),
  saveConfig: (config) => ipcRenderer.invoke("rate-limit:save-config", config),
  openLogin: (accountId) => ipcRenderer.invoke("rate-limit:open-login", accountId),
  removeAccount: (accountId) => ipcRenderer.invoke("rate-limit:remove-account", accountId),
  refresh: () => ipcRenderer.invoke("rate-limit:refresh"),
  toggle: () => ipcRenderer.invoke("rate-limit:toggle"),
  moveToTopRight: () => ipcRenderer.send("rate-limit:move-top-right"),
  openHistory: () => ipcRenderer.send("usage-history:open"),
  getUsageHistory: (options) => ipcRenderer.invoke("usage-history:get", options),
  repairUsageHistory: (options) => ipcRenderer.invoke("usage-history:repair", options),
  onUsageHistoryUpdated: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on("usage-history:updated", listener);
    return () => ipcRenderer.removeListener("usage-history:updated", listener);
  },
  pickFolder: () => ipcRenderer.invoke("usage-history:pick-folder"),
  setExpandedView: (expanded, rowCount, contentHeight) => ipcRenderer.send("rate-limit:set-expanded-view", expanded, rowCount, contentHeight),
  onSnapshot: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on("rate-limit:snapshot", listener);
    return () => ipcRenderer.removeListener("rate-limit:snapshot", listener);
  },
  getUpdate: () => ipcRenderer.invoke("update:get"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  restartUpdate: () => ipcRenderer.send("update:restart"),
  openShellUpdate: () => ipcRenderer.send("update:open-shell"),
  reportCoreHealthy: () => ipcRenderer.send("core:healthy"),
  onUpdateState: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  }
});
