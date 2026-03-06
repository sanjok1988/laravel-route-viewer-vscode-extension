"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
function activate(context) {
    const cmd = vscode.commands.registerCommand("laravelRouteViewer.showRoutes", async () => {
        const folder = await pickWorkspaceFolder();
        if (!folder) {
            vscode.window.showErrorMessage("Open a workspace folder first.");
            return;
        }
        const panel = vscode.window.createWebviewPanel("laravelRouteViewer.routes", "Laravel Routes", vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        // set panel icon (theme aware)
        const lightIconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "icon-light.svg"));
        const darkIconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "icon-dark.svg"));
        // if you only have a single icon (icon.svg), you can use the same for both:
        const singleIconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg"));
        // Set theme-specific icon
        panel.iconPath = {
            light: lightIconUri, // URIs created with webview.asWebviewUri
            dark: darkIconUri,
        };
        // Or if using a single icon file:
        panel.iconPath = singleIconUri;
        panel.webview.html = getHtml(panel.webview, context.extensionUri);
        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (!msg || typeof msg !== "object") {
                return;
            }
            switch (msg.type) {
                case "refresh": {
                    try {
                        const routes = await fetchRoutes(folder);
                        panel.webview.postMessage({ type: "routes", routes });
                    }
                    catch (e) {
                        panel.webview.postMessage({
                            type: "error",
                            message: e?.message ?? String(e),
                        });
                    }
                    break;
                }
                case "openAction": {
                    const action = String(msg.action ?? "");
                    try {
                        const opened = await openAction(folder, action);
                        if (!opened) {
                            vscode.window.showWarningMessage(`Could not resolve action: ${action}`);
                        }
                    }
                    catch (e) {
                        vscode.window.showErrorMessage(e?.message ?? String(e));
                    }
                    break;
                }
            }
        });
        // initial load
        panel.webview.postMessage({
            type: "loading",
            message: "Loading routes…",
        });
        try {
            const routes = await fetchRoutes(folder);
            panel.webview.postMessage({ type: "routes", routes });
        }
        catch (e) {
            panel.webview.postMessage({
                type: "error",
                message: e?.message ?? String(e),
            });
        }
    });
    context.subscriptions.push(cmd);
}
function deactivate() { }
async function pickWorkspaceFolder() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0];
    }
    const pick = await vscode.window.showQuickPick(folders.map((f) => ({
        label: f.name,
        description: f.uri.fsPath,
        folder: f,
    })), { placeHolder: "Select Laravel project folder" });
    return pick?.folder;
}
async function fetchRoutes(folder) {
    const cfg = vscode.workspace.getConfiguration("laravelRouteViewer", folder.uri);
    const phpPath = cfg.get("phpPath", "php");
    const artisanRel = cfg.get("artisanPath", "artisan");
    const cwd = folder.uri.fsPath;
    const artisanPath = path.isAbsolute(artisanRel)
        ? artisanRel
        : path.join(cwd, artisanRel);
    if (!fs.existsSync(artisanPath)) {
        throw new Error(`artisan not found at: ${artisanPath}`);
    }
    // Use spawn (safer than exec for large output)
    const args = [artisanPath, "route:list", "--json"];
    const { code, stdout, stderr } = await spawnCapture(phpPath, args, cwd);
    if (code !== 0) {
        throw new Error(`route:list failed (exit ${code}). ${stderr || stdout}`.trim());
    }
    // Some Laravel versions might write warnings to stderr; prefer stdout for JSON.
    const text = stdout.trim();
    if (!text) {
        throw new Error(`No output from route:list. stderr: ${stderr}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        // Sometimes JSON is mixed with extra lines; try to salvage last JSON object/array
        const start = text.indexOf("[");
        const end = text.lastIndexOf("]");
        if (start >= 0 && end > start) {
            parsed = JSON.parse(text.slice(start, end + 1));
        }
        else {
            throw new Error("Failed to parse JSON from `php artisan route:list --json` output.");
        }
    }
    const routes = Array.isArray(parsed)
        ? parsed
        : (parsed?.routes ?? []);
    return normalizeRoutes(routes);
}
function normalizeRoutes(routes) {
    return routes.map((r) => {
        const methods = Array.isArray(r.methods)
            ? r.methods
            : typeof r.method === "string"
                ? r.method.split("|")
                : [];
        const middleware = Array.isArray(r.middleware)
            ? r.middleware
            : typeof r.middleware === "string"
                ? r.middleware
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                : [];
        return {
            ...r,
            methods,
            middleware,
            method: methods.join("|"),
        };
    });
}
function spawnCapture(cmd, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(cmd, args, {
            cwd,
            shell: process.platform === "win32",
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", (err) => reject(err));
        child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
}
/**
 * Best-effort: open Controller file at method, for actions like:
 *   App\Http\Controllers\FooController@bar
 *   FooController@bar
 */
async function openAction(folder, action) {
    if (!action || action.toLowerCase() === "closure") {
        return false;
    }
    const at = action.indexOf("@");
    if (at < 0) {
        return false;
    }
    const classPart = action.slice(0, at).trim();
    const methodPart = action.slice(at + 1).trim();
    if (!classPart) {
        return false;
    }
    const classPath = classToPath(folder.uri.fsPath, classPart);
    if (!classPath || !fs.existsSync(classPath)) {
        return false;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(classPath));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    // Try to find "function methodName" in file
    const text = doc.getText();
    const re = new RegExp(`function\\s+${escapeRegExp(methodPart)}\\s*\\(`);
    const m = re.exec(text);
    if (m && m.index >= 0) {
        const pos = doc.positionAt(m.index);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
    return true;
}
function classToPath(workspaceRoot, className) {
    // If already looks like a path, skip.
    if (className.includes("/") || className.includes("\\")) {
        return undefined;
    }
    // Normalize leading "\" for fully-qualified classes
    const fqcn = className.replace(/^\\+/, "");
    // Typical Laravel app namespace mapping:
    // App\Something => app/Something.php
    if (fqcn.startsWith("App\\")) {
        const rel = fqcn.replace(/^App\\/, "app\\") + ".php";
        return path.join(workspaceRoot, rel.split("\\").join(path.sep));
    }
    // As a fallback, try app/ + class segments
    const rel = "app\\" + fqcn + ".php";
    return path.join(workspaceRoot, rel.split("\\").join(path.sep));
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function getHtml(webview, _extensionUri) {
    const nonce = String(Date.now());
    // CSP: keep it simple, inline styles ok; scripts only with nonce
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Laravel Routes</title>
  <style>
    :root{
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-button-background);
      --accentFg: var(--vscode-button-foreground);
      --inputBg: var(--vscode-input-background);
      --inputFg: var(--vscode-input-foreground);
      --inputBorder: var(--vscode-input-border);
      --rowHover: var(--vscode-list-hoverBackground);
      --badgeBg: color-mix(in srgb, var(--accent) 25%, transparent);
    }
    body{
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
    }
    header{
      position: sticky;
      top: 0;
      background: color-mix(in srgb, var(--bg) 92%, transparent);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      padding: 12px 14px;
      display: flex;
      gap: 10px;
      align-items: center;
      z-index: 10;
    }
    .title{
      font-weight: 600;
      margin-right: 8px;
      white-space: nowrap;
    }
    input[type="text"]{
      flex: 1;
      background: var(--inputBg);
      color: var(--inputFg);
      border: 1px solid var(--inputBorder, var(--border));
      border-radius: 8px;
      padding: 8px 10px;
      outline: none;
    }
    button{
      background: var(--accent);
      color: var(--accentFg);
      border: none;
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
    }
    button.secondary{
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    main{ padding: 10px 14px 18px; }
    .meta{ color: var(--muted); margin: 8px 0 10px; display:flex; gap:12px; flex-wrap: wrap;}
    .badge{
      display:inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--badgeBg);
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
      color: var(--fg);
      font-size: 12px;
    }
    table{
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    thead th{
      text-align: left;
      font-size: 12px;
      letter-spacing: .02em;
      color: var(--muted);
      background: color-mix(in srgb, var(--bg) 90%, transparent);
      border-bottom: 1px solid var(--border);
      padding: 10px 10px;
      position: sticky;
      top: 56px; /* header height approx */
      z-index: 5;
    }
    tbody td{
      padding: 10px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      vertical-align: top;
      font-family: var(--vscode-editor-font-family);
      font-size: 12.5px;
    }
    tbody tr:hover{ background: var(--rowHover); }
    tbody tr.clickable{ cursor: pointer; }
    .mono{ font-family: var(--vscode-editor-font-family); }
    .muted{ color: var(--muted); }
    .pill{
      display:inline-block;
      padding: 2px 7px;
      border: 1px solid var(--border);
      border-radius: 999px;
      margin-right: 6px;
      margin-bottom: 4px;
      font-size: 12px;
      color: var(--muted);
    }
    .status{
      padding: 10px 0;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <header>
    <div class="title">Laravel Routes</div>
    <input id="q" type="text" placeholder="Search: uri, name, method, action, middleware…" />
    <button id="refresh">Refresh</button>
  </header>

  <main>
    <div class="meta">
      <span class="badge" id="count">0 routes</span>
      <span class="badge" id="filtered">0 shown</span>
      <span class="badge" id="hint">Click a row to open controller action (best effort)</span>
    </div>

    <div id="status" class="status"></div>

    <table>
      <thead>
        <tr>
          <th style="width: 140px;">Method</th>
          <th>URI</th>
          <th style="width: 220px;">Name</th>
          <th style="width: 420px;">Action</th>
          <th>Middleware</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    /** @type {any[]} */
    let routes = [];
    let filtered = [];

    const $q = document.getElementById('q');
    const $rows = document.getElementById('rows');
    const $status = document.getElementById('status');
    const $count = document.getElementById('count');
    const $filtered = document.getElementById('filtered');

    function setStatus(text){ $status.textContent = text || ''; }
    function setCounts(){
      $count.textContent = routes.length + ' routes';
      $filtered.textContent = filtered.length + ' shown';
    }

    function norm(s){ return (s ?? '').toString().toLowerCase(); }

    function render(){
      $rows.innerHTML = '';
      setCounts();

      if (filtered.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="5" class="muted">No routes found.</td>';
        $rows.appendChild(tr);
        return;
      }

      for (const r of filtered) {
        const tr = document.createElement('tr');
        const action = (r.action ?? '').toString();
        const isClickable = action.includes('@') && action.toLowerCase() !== 'closure';
        if (isClickable) tr.classList.add('clickable');

        const methods = (r.method || (Array.isArray(r.methods) ? r.methods.join('|') : '') || '').toString();
        const uri = (r.uri ?? '').toString();
        const name = (r.name ?? '').toString();
        const mw = Array.isArray(r.middleware) ? r.middleware : (typeof r.middleware === 'string' ? r.middleware.split(',').map(s=>s.trim()).filter(Boolean) : []);

        tr.innerHTML = \`
          <td class="mono">\${escapeHtml(methods)}</td>
          <td class="mono">\${escapeHtml(uri)}</td>
          <td class="mono">\${name ? escapeHtml(name) : '<span class="muted">—</span>'}</td>
          <td class="mono">\${action ? escapeHtml(action) : '<span class="muted">—</span>'}</td>
          <td>\${mw.length ? mw.map(x => '<span class="pill">'+escapeHtml(x)+'</span>').join('') : '<span class="muted">—</span>'}</td>
        \`;

        if (isClickable) {
          tr.addEventListener('click', () => {
            vscode.postMessage({ type: 'openAction', action });
          });
        }

        $rows.appendChild(tr);
      }
    }

    function escapeHtml(s){
      return (s ?? '').toString()
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'","&#039;");
    }

    function applyFilter(){
      const q = norm($q.value).trim();
      if (!q) {
        filtered = routes.slice();
        render();
        return;
      }
      filtered = routes.filter(r => {
        const hay = [
          r.method, r.uri, r.name, r.action,
          Array.isArray(r.middleware) ? r.middleware.join(' ') : r.middleware
        ].map(norm).join(' | ');
        return hay.includes(q);
      });
      render();
    }

    function debounce(fn, ms){
      let t;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
      };
    }

    $q.addEventListener('input', debounce(applyFilter, 120));
    document.getElementById('refresh').addEventListener('click', () => {
      setStatus('Refreshing…');
      vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'loading') {
        setStatus(msg.message || 'Loading…');
        return;
      }

      if (msg.type === 'error') {
        setStatus('Error: ' + (msg.message || 'Unknown error'));
        routes = [];
        filtered = [];
        render();
        return;
      }

      if (msg.type === 'routes') {
        routes = Array.isArray(msg.routes) ? msg.routes : [];
        filtered = routes.slice();
        setStatus('');
        applyFilter();
      }
    });
  </script>
</body>
</html>`;
}
//# sourceMappingURL=extension.js.map