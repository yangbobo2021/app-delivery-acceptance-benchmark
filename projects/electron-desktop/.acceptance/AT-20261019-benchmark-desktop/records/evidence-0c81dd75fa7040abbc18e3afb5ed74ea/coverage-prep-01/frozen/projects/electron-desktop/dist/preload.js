// src/preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("notes", { list: () => import_electron.ipcRenderer.invoke("notes:list"), save: (value) => import_electron.ipcRenderer.invoke("notes:save", value), remove: (id) => import_electron.ipcRenderer.invoke("notes:delete", id) });
//# sourceMappingURL=preload.js.map
