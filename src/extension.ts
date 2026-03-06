import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";

type LaravelRoute = {
  method?: string;
  methods?: string[]; // some Laravel versions use methods
  uri?: string;
  name?: string;
  action?: string; // "App\Http\Controllers\XController@method" OR "Closure"
  middleware?: string[] | string;
  domain?: string | null;
};

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand(
    "laravelRouteViewer.showRoutes",
    async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showErrorMessage("Open a workspace folder first.");
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        "laravelRouteViewer.routes",
        "Laravel Routes",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      );

      // set panel icon (theme aware)
      const lightIconUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "media", "icon-light.svg"),
      );
      const darkIconUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "media", "icon-dark.svg"),
      );

      // if you only have a single icon (icon.svg), you can use the same for both:
      const singleIconUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg"),
      );

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
            } catch (e: any) {
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
                vscode.window.showWarningMessage(
                  `Could not resolve action: ${action}`,
                );
              }
            } catch (e: any) {
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
      } catch (e: any) {
        panel.webview.postMessage({
          type: "error",
          message: e?.message ?? String(e),
        });
      }
    },
  );

  context.subscriptions.push(cmd);
}

export function deactivate() {}

async function pickWorkspaceFolder(): Promise<
  vscode.WorkspaceFolder | undefined
> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }

  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: f.name,
      description: f.uri.fsPath,
      folder: f,
    })),
    { placeHolder: "Select Laravel project folder" },
  );
  return pick?.folder;
}

async function fetchRoutes(
  folder: vscode.WorkspaceFolder,
): Promise<LaravelRoute[]> {
  const cfg = vscode.workspace.getConfiguration(
    "laravelRouteViewer",
    folder.uri,
  );
  const phpPath = cfg.get<string>("phpPath", "php");
  const artisanRel = cfg.get<string>("artisanPath", "artisan");

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
    throw new Error(
      `route:list failed (exit ${code}). ${stderr || stdout}`.trim(),
    );
  }

  // Some Laravel versions might write warnings to stderr; prefer stdout for JSON.
  const text = stdout.trim();
  if (!text) {
    throw new Error(`No output from route:list. stderr: ${stderr}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Sometimes JSON is mixed with extra lines; try to salvage last JSON object/array
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
      parsed = JSON.parse(text.slice(start, end + 1));
    } else {
      throw new Error(
        "Failed to parse JSON from `php artisan route:list --json` output.",
      );
    }
  }

  const routes: LaravelRoute[] = Array.isArray(parsed)
    ? parsed
    : (parsed?.routes ?? []);
  return normalizeRoutes(routes);
}

function normalizeRoutes(routes: LaravelRoute[]): LaravelRoute[] {
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

function spawnCapture(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
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
async function openAction(
  folder: vscode.WorkspaceFolder,
  action: string,
): Promise<boolean> {
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

  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(classPath),
  );
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  // Try to find "function methodName" in file
  const text = doc.getText();
  const re = new RegExp(`function\\s+${escapeRegExp(methodPart)}\\s*\\(`);
  const m = re.exec(text);
  if (m && m.index >= 0) {
    const pos = doc.positionAt(m.index);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(
      new vscode.Range(pos, pos),
      vscode.TextEditorRevealType.InCenter,
    );
  }
  return true;
}

function classToPath(
  workspaceRoot: string,
  className: string,
): string | undefined {
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getHtml(webview: vscode.Webview, _extensionUri: vscode.Uri): string {
  const nonce = String(Date.now());

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
      --border: color-mix(in srgb, var(--vscode-panel-border) 75%, transparent);
      --accent: var(--vscode-button-background);
      --accentFg: var(--vscode-button-foreground);
      --inputBg: var(--vscode-input-background);
      --inputFg: var(--vscode-input-foreground);
      --inputBorder: var(--vscode-input-border);
      --rowHover: var(--vscode-list-hoverBackground);
      --cardBg: color-mix(in srgb, var(--bg) 94%, white 2%);
      --headerBg: color-mix(in srgb, var(--bg) 86%, transparent);
      --soft: color-mix(in srgb, var(--fg) 8%, transparent);
      --shadow: 0 10px 30px rgba(0,0,0,.14);

      --get: #22c55e;
      --post: #3b82f6;
      --put: #f59e0b;
      --patch: #fb923c;
      --delete: #ef4444;
      --options: #a855f7;
      --head: #6b7280;
      --defaultMethod: #64748b;
    }

    * { box-sizing: border-box; }

    body{
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--accent) 10%, transparent), transparent 28%),
        var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
      padding: 0;
    }

    header{
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      background: var(--headerBg);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      margin-bottom: 10px;
    }

    .brand{
      display: flex;
      flex-direction: column;
      min-width: 170px;
    }

    .title{
      font-size: 15px;
      font-weight: 700;
      letter-spacing: .2px;
    }

    .subtitle{
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
    }

    .searchWrap{
      flex: 1;
      position: relative;
    }

    input[type="text"]{
      width: 100%;
      background: color-mix(in srgb, var(--inputBg) 92%, white 2%);
      color: var(--inputFg);
      border: 1px solid color-mix(in srgb, var(--inputBorder, var(--border)) 70%, transparent);
      border-radius: 12px;
      padding: 11px 14px;
      outline: none;
      transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
    }

    input[type="text"]:focus{
      border-color: color-mix(in srgb, var(--accent) 65%, white 10%);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }

    button{
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--accent) 92%, white 10%),
        var(--accent)
      );
      color: var(--accentFg);
      border: none;
      border-radius: 12px;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 600;
      transition: transform .15s ease, opacity .15s ease, box-shadow .18s ease;
      box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 22%, transparent);
    }

    button:hover{
      transform: translateY(-1px);
      opacity: .96;
    }

    button:active{
      transform: translateY(0);
    }

    main{
      padding: 16px;
    }

    .meta{
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }

    .badge{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border));
      color: var(--fg);
      font-size: 12px;
      font-weight: 500;
    }

    .status{
      color: var(--muted);
      margin: 6px 2px 14px;
      min-height: 18px;
      font-size: 12px;
    }

    .tableWrap{
      background: var(--cardBg);
      border: 1px solid var(--border);
      border-radius: 18px;
      overflow: hidden;
      box-shadow: var(--shadow);
    }

    table{
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
    }

    thead th{
      text-align: left;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--muted);
      background: color-mix(in srgb, var(--bg) 90%, transparent);
      border-bottom: 1px solid var(--border);
      padding: 14px 12px;
      position: sticky;
      top: 70px;
      z-index: 5;
    }

    tbody td{
      padding: 14px 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
      vertical-align: top;
      font-size: 12.5px;
      line-height: 1.45;
    }

    tbody tr{
      transition: background .15s ease, transform .15s ease;
    }

    tbody tr:hover{
      background: color-mix(in srgb, var(--rowHover) 72%, transparent);
    }

    tbody tr.clickable{
      cursor: pointer;
    }

    tbody tr.clickable:hover{
      background: color-mix(in srgb, var(--accent) 8%, var(--rowHover));
    }

    tbody tr:last-child td{
      border-bottom: none;
    }

    .mono{
      font-family: var(--vscode-editor-font-family);
    }

    .muted{
      color: var(--muted);
    }

    .methodGroup{
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .methodPill{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 56px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .04em;
      text-transform: uppercase;
      border: 1px solid transparent;
      color: white;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.12);
    }

    .method-get{
      background: color-mix(in srgb, var(--get) 82%, black 6%);
      border-color: color-mix(in srgb, var(--get) 55%, white 10%);
    }

    .method-post{
      background: color-mix(in srgb, var(--post) 82%, black 6%);
      border-color: color-mix(in srgb, var(--post) 55%, white 10%);
    }

    .method-put{
      background: color-mix(in srgb, var(--put) 85%, black 6%);
      border-color: color-mix(in srgb, var(--put) 55%, white 10%);
      color: #1f1300;
    }

    .method-patch{
      background: color-mix(in srgb, var(--patch) 88%, black 4%);
      border-color: color-mix(in srgb, var(--patch) 55%, white 10%);
      color: #231200;
    }

    .method-delete{
      background: color-mix(in srgb, var(--delete) 84%, black 7%);
      border-color: color-mix(in srgb, var(--delete) 55%, white 10%);
    }

    .method-options{
      background: color-mix(in srgb, var(--options) 84%, black 6%);
      border-color: color-mix(in srgb, var(--options) 55%, white 10%);
    }

    .method-head{
      background: color-mix(in srgb, var(--head) 84%, black 6%);
      border-color: color-mix(in srgb, var(--head) 55%, white 10%);
    }

    .method-default{
      background: color-mix(in srgb, var(--defaultMethod) 84%, black 6%);
      border-color: color-mix(in srgb, var(--defaultMethod) 55%, white 10%);
    }

    .routeName{
      font-weight: 600;
      color: color-mix(in srgb, var(--fg) 94%, white 4%);
    }

    .actionText{
      color: color-mix(in srgb, var(--fg) 92%, white 2%);
    }

    .pill{
      display:inline-flex;
      align-items:center;
      padding: 4px 8px;
      border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      border-radius: 999px;
      margin-right: 6px;
      margin-bottom: 6px;
      font-size: 11px;
      color: var(--muted);
      background: color-mix(in srgb, var(--soft) 80%, transparent);
    }

    .empty{
      padding: 26px 12px;
      text-align: center;
      color: var(--muted);
    }

    .uriText{
      font-weight: 600;
      color: color-mix(in srgb, var(--fg) 96%, white 2%);
    }

    @media (max-width: 900px){
      thead th:nth-child(3),
      tbody td:nth-child(3){
        display: none;
      }
    }

    @media (max-width: 700px){
      header{
        flex-wrap: wrap;
      }

      .brand{
        width: 100%;
      }

      thead th:nth-child(5),
      tbody td:nth-child(5){
        display: none;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="title">Laravel Routes</div>
      <div class="subtitle">Browse, search, and open route actions</div>
    </div>

    <div class="searchWrap">
      <input id="q" type="text" placeholder="Search routes by URI, name, method, action, middleware..." />
    </div>

    <button id="refresh">Refresh</button>
  </header>

  <main>
    <div class="meta">
      <span class="badge" id="count">0 routes</span>
      <span class="badge" id="filtered">0 shown</span>
      <span class="badge" id="hint">Click a route row to open its controller action</span>
    </div>

    <div id="status" class="status"></div>

    <div class="tableWrap">
      <table>
        <thead>
          <tr>
            <th style="width: 150px;">Method</th>
            <th>URI</th>
            <th style="width: 220px;">Name</th>
            <th style="width: 420px;">Action</th>
            <th>Middleware</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    let routes = [];
    let filtered = [];

    const $q = document.getElementById('q');
    const $rows = document.getElementById('rows');
    const $status = document.getElementById('status');
    const $count = document.getElementById('count');
    const $filtered = document.getElementById('filtered');

    function setStatus(text){
      $status.textContent = text || '';
    }

    function setCounts(){
      $count.textContent = routes.length + ' routes';
      $filtered.textContent = filtered.length + ' shown';
    }

    function norm(s){
      return (s ?? '').toString().toLowerCase();
    }

    function escapeHtml(s){
      return (s ?? '').toString()
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'","&#039;");
    }

    function getMethodClass(method){
      const m = norm(method);
      if (m === 'get') return 'method-get';
      if (m === 'post') return 'method-post';
      if (m === 'put') return 'method-put';
      if (m === 'patch') return 'method-patch';
      if (m === 'delete') return 'method-delete';
      if (m === 'options') return 'method-options';
      if (m === 'head') return 'method-head';
      return 'method-default';
    }

    function renderMethods(methodValue){
      const methods = (methodValue || '')
        .toString()
        .split('|')
        .map(s => s.trim())
        .filter(Boolean);

      if (!methods.length) {
        return '<span class="muted">—</span>';
      }

      return '<div class="methodGroup">' + methods.map(method => {
        return '<span class="methodPill ' + getMethodClass(method) + '">' + escapeHtml(method) + '</span>';
      }).join('') + '</div>';
    }

    function render(){
      $rows.innerHTML = '';
      setCounts();

      if (filtered.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="5" class="empty">No routes found.</td>';
        $rows.appendChild(tr);
        return;
      }

      for (const r of filtered) {
        const tr = document.createElement('tr');
        const action = (r.action ?? '').toString();
        const isClickable = action.includes('@') && action.toLowerCase() !== 'closure';

        if (isClickable) {
          tr.classList.add('clickable');
        }

        const methods = (r.method || (Array.isArray(r.methods) ? r.methods.join('|') : '') || '').toString();
        const uri = (r.uri ?? '').toString();
        const name = (r.name ?? '').toString();
        const mw = Array.isArray(r.middleware)
          ? r.middleware
          : (typeof r.middleware === 'string'
              ? r.middleware.split(',').map(s => s.trim()).filter(Boolean)
              : []);

        tr.innerHTML = \`
          <td>\${renderMethods(methods)}</td>
          <td class="mono uriText">\${escapeHtml(uri)}</td>
          <td class="mono">\${name ? '<span class="routeName">' + escapeHtml(name) + '</span>' : '<span class="muted">—</span>'}</td>
          <td class="mono actionText">\${action ? escapeHtml(action) : '<span class="muted">—</span>'}</td>
          <td>\${mw.length ? mw.map(x => '<span class="pill">' + escapeHtml(x) + '</span>').join('') : '<span class="muted">—</span>'}</td>
        \`;

        if (isClickable) {
          tr.addEventListener('click', () => {
            vscode.postMessage({ type: 'openAction', action });
          });
        }

        $rows.appendChild(tr);
      }
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
          r.method,
          Array.isArray(r.methods) ? r.methods.join(' ') : '',
          r.uri,
          r.name,
          r.action,
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
      setStatus('Refreshing...');
      vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'loading') {
        setStatus(msg.message || 'Loading...');
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
