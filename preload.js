const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rateLimitAPI", {
  getState: () => ipcRenderer.invoke("rate-limit:get-state"),
  getSnapshot: () => ipcRenderer.invoke("rate-limit:get-snapshot"),
  saveConfig: (config) => ipcRenderer.invoke("rate-limit:save-config", config),
  openLogin: (accountId) => ipcRenderer.invoke("rate-limit:open-login", accountId),
  refresh: () => ipcRenderer.invoke("rate-limit:refresh"),
  toggle: () => ipcRenderer.invoke("rate-limit:toggle"),
  onSnapshot: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on("rate-limit:snapshot", listener);
    return () => ipcRenderer.removeListener("rate-limit:snapshot", listener);
  }
});
