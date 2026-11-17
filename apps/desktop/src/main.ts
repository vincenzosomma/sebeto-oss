/**
 * Sebeto desktop shell (Electron). Runs sebeto-core in a utilityProcess (same Node code as the
 * Docker image) and opens the UI it serves in a locked-down window.
 * See docs/14 Deployment Modes.md and docs/15 Architecture Review.md (items 1 and 5).
 *
 * Native modules: `npm run dist -w @sebeto/desktop` packages a staged copy of the app whose
 * better-sqlite3 is rebuilt for Electron automatically (see scripts/stage.mjs). Only `npm run dev`
 * from the source tree needs `npm run rebuild-native -w @sebeto/desktop` first.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, utilityProcess, type UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_CHANNEL, loadThemeSource, parseThemeSource, saveThemeSource, themeArg, windowBackground } from './theme.js';

const APP_ID = 'app.sebeto.desktop';
const READY_TIMEOUT_MS = 30_000;

app.setName('Sebeto');
app.setAppUserModelId(APP_ID);

interface CoreHandle {
  proc: UtilityProcess;
  port: number;
  token: string;
}

let core: CoreHandle | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;

function coreEntry(): string {
  // @sebeto/core only exports "." (dist/index.js); main.js sits next to it.
  const indexPath = fileURLToPath(import.meta.resolve('@sebeto/core'));
  return join(dirname(indexPath), 'main.js');
}

function uiDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'ui');
  return resolve(app.getAppPath(), '..', '..', 'packages', 'ui', 'dist');
}

function iconPath(): string | undefined {
  // build/icon.ico + build/icon.png come from design/brand/sebeto-app-icon.svg (scripts/make-icons.mjs);
  // they sit next to package.json both in the source tree and inside the packaged app.asar.
  const p = join(app.getAppPath(), 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  return existsSync(p) ? p : undefined;
}

/** Same default as sebeto-core (~/.sebeto/workspace); SEBETO_WORKSPACE overrides it (e.g. for tests). */
function workspaceDir(): string {
  const fromEnv = process.env['SEBETO_WORKSPACE']?.trim();
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.sebeto', 'workspace');
}

function startCore(): Promise<CoreHandle> {
  const token = randomBytes(32).toString('hex');
  const workspace = workspaceDir();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, {
    SEBETO_HOST: '127.0.0.1',
    SEBETO_PORT: '0',
    SEBETO_TOKEN: token,
    SEBETO_WORKSPACE: workspace,
    SEBETO_UI_DIR: uiDir(),
    NODE_ENV: app.isPackaged ? 'production' : 'development',
  });

  const proc = utilityProcess.fork(coreEntry(), [], { env, stdio: 'pipe', serviceName: 'sebeto-core' });
  const stderrTail: string[] = [];
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    process.stderr.write(text);
    stderrTail.push(text);
    while (stderrTail.length > 20) stderrTail.shift();
  });
  proc.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));

  return new Promise<CoreHandle>((resolvePromise, reject) => {
    let settled = false;
    // The core's own error messages are written for people; the stderr tail only helps for crashes.
    const fail = (message: string, withTail = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      const tail = stderrTail.join('').trim().split('\n').slice(-8).join('\n');
      reject(new Error(tail && withTail ? `${message}\n\n${tail}` : message));
    };
    const timer = setTimeout(() => fail('Sebeto took too long to start.'), READY_TIMEOUT_MS);
    proc.on('message', (msg: { type?: string; port?: number; token?: string; message?: string }) => {
      if (msg?.type === 'ready' && typeof msg.port === 'number' && !settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ proc, port: msg.port, token });
      } else if (msg?.type === 'error') {
        fail(msg.message ?? 'Sebeto failed to start.', !msg.message);
      }
    });
    proc.on('exit', (code) => {
      if (!settled) fail(`Sebeto stopped unexpectedly (exit code ${code}).`);
      else if (!quitting) {
        dialog.showErrorBox('Sebeto stopped', `The Sebeto engine stopped unexpectedly (exit code ${code}). Please restart the app.`);
        app.quit();
      }
    });
  });
}

function createWindow(handle: CoreHandle): BrowserWindow {
  const origin = `http://127.0.0.1:${handle.port}`;
  const icon = iconPath();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Sebeto',
    show: false,
    autoHideMenuBar: true,
    // Same colour as the page background of the theme in use, so there is no white flash.
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      // preload.cjs exposes only window.sebetoDesktop (theme); the saved choice rides on argv.
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      additionalArguments: [themeArg(parseThemeSource(nativeTheme.themeSource) ?? 'system')],
    },
  });

  const openExternal = (url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') void shell.openExternal(url);
    } catch {
      /* ignore malformed URLs */
    }
  };
  const isOwnOrigin = (url: string) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  win.webContents.on('will-navigate', (event, url) => {
    if (!isOwnOrigin(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isOwnOrigin(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // Theme switch from the UI (v0.6 §N): only our own page, only 'light' | 'dark' | 'system'.
  const onTheme = (event: Electron.IpcMainEvent, value: unknown) => {
    if (event.sender !== win.webContents || !isOwnOrigin(event.senderFrame?.url ?? '')) return;
    const source = parseThemeSource(value);
    if (!source || nativeTheme.themeSource === source) return;
    nativeTheme.themeSource = source;
    saveThemeSource(app.getPath('userData'), source);
  };
  ipcMain.on(THEME_CHANNEL, onTheme);
  const onNativeTheme = () => {
    if (!win.isDestroyed()) win.setBackgroundColor(windowBackground(nativeTheme.shouldUseDarkColors));
  };
  nativeTheme.on('updated', onNativeTheme);
  win.on('closed', () => {
    ipcMain.removeListener(THEME_CHANNEL, onTheme);
    nativeTheme.removeListener('updated', onNativeTheme);
  });

  win.once('ready-to-show', () => win.show());
  void win.loadURL(`${origin}/?token=${handle.token}`);
  return win;
}

function stopCore(): void {
  if (!core) return;
  const { proc } = core;
  core = undefined;
  try {
    proc.postMessage({ type: 'shutdown' });
  } catch {
    /* already gone */
  }
  setTimeout(() => proc.kill(), 3000).unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = loadThemeSource(app.getPath('userData'));
    try {
      core = await startCore();
    } catch (err) {
      dialog.showErrorBox('Sebeto could not start', `${(err as Error).message}\n\nIf this keeps happening, reinstall Sebeto or report the problem.`);
      app.quit();
      return;
    }
    mainWindow = createWindow(core);
    mainWindow.on('closed', () => (mainWindow = undefined));
    app.on('activate', () => {
      if (!mainWindow && core) mainWindow = createWindow(core);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopCore();
  });
}
