// src/main.ts
var import_electron = require("electron");
var import_node_path2 = require("node:path");

// src/store.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_crypto = require("node:crypto");
var Store = class {
  notes;
  path;
  constructor(dir) {
    (0, import_node_fs.mkdirSync)(dir, { recursive: true });
    this.path = (0, import_node_path.join)(dir, "notes.json");
    this.notes = (0, import_node_fs.existsSync)(this.path) ? JSON.parse((0, import_node_fs.readFileSync)(this.path, "utf8")) : [];
  }
  list() {
    const snapshot = this.notes.map((n) => ({ ...n }));
    return snapshot;
  }
  validID(id) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid ID");
  }
  persist(next) {
    (0, import_node_fs.writeFileSync)(this.path + ".tmp", JSON.stringify(next));
    (0, import_node_fs.renameSync)(this.path + ".tmp", this.path);
    this.notes = next;
  }
  save(value) {
    if (!value || typeof value.title !== "string" || typeof value.body !== "string") throw new Error("Invalid note");
    const title = value.title.trim();
    if (!title || Array.from(title).length > 80 || Array.from(value.body).length > 1e4) throw new Error("Invalid note length");
    let id = value.id;
    if (id !== null && id !== void 0) {
      this.validID(id);
      if (!this.notes.some((n) => n.id === id)) throw new Error("Unknown note");
    } else id = (0, import_node_crypto.randomUUID)();
    const result = { id, title, body: value.body };
    const next = this.notes.filter((n) => n.id !== id);
    next.push(result);
    this.persist(next);
    return result;
  }
  remove(id) {
    this.validID(id);
    if (!this.notes.some((n) => n.id === id)) throw new Error("Unknown note");
    const selected = this.notes.find((n) => n.id === id);
    this.persist(this.notes.filter((n) => n.title !== selected.title));
  }
};

// src/main.ts
var arg = process.argv.indexOf("--user-data-dir");
if (arg >= 0 && process.argv[arg + 1]) import_electron.app.setPath("userData", process.argv[arg + 1]);
import_electron.app.whenReady().then(() => {
  const store = new Store(import_electron.app.getPath("userData"));
  import_electron.ipcMain.handle("notes:list", () => store.list());
  import_electron.ipcMain.handle("notes:save", (_event, value) => store.save(value));
  import_electron.ipcMain.handle("notes:delete", (_event, id) => store.remove(id));
  const window = new import_electron.BrowserWindow({ width: 850, height: 650, webPreferences: { preload: (0, import_node_path2.join)(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.loadFile((0, import_node_path2.join)(__dirname, "index.html"));
});
import_electron.app.on("window-all-closed", () => import_electron.app.quit());
//# sourceMappingURL=main.js.map
