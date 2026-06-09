/**
 * Electron main process entry.
 *
 * Per PRD NF6 (renderer hardening): contextIsolation true,
 * nodeIntegration false, sandbox true. Renderer talks to main only
 * through the typed IPC bus in src/main/ipc/bus.ts.
 *
 * Per PRD F10.1 / F10.2: single internal IPC channel for control
 * verbs; pty.data lives on its own channel.
 */

// `ELECTRON_DISABLE_SECURITY_WARNINGS=true` is set by the npm `dev`
// script so the renderer console isn't dominated by the "Insecure CSP"
// warning while we use 'unsafe-eval' for Vite HMR. The packaged prod
// build runs without the env var and uses the tight CSP from installCsp().
import { app, BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';

import { registerControlBus } from './ipc/bus.js';
import { initDatabase, closeDatabase } from './database/index.js';
import { getSessionManager } from './services/sessionManager.js';
import { addProject } from './services/projectStore.js';
import { startNotifier } from './services/notifier.js';
import { warmAllConnections, dropAllConnections } from './services/fs/registry.js';

/**
 * Per PRD NF6: tight CSP in production. In dev we relax it just
 * enough to let Vite's HMR + inline scripts work (`'unsafe-eval'`,
 * `'unsafe-inline'`, `ws:` for the HMR WebSocket). The dev branch
 * also silences the loud "Electron Security Warning" in the console.
 */
function installCsp(): void {
  // `frame-src` is permissive (http/https) because the in-app browser
  // tab is an iframe whose src is whatever URL the user clicked from
  // the terminal — typical case is a local dev server at
  // http://localhost:5180, but any http(s) origin should work. The
  // iframe itself is sandboxed (see EditorPane), and the renderer is
  // isolated (contextIsolation + sandbox), so we're not handing the
  // page any host privilege beyond a normal browser tab.
  const dev =
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* ws://localhost:* data:; " +
    "img-src 'self' data: http://localhost:*; " +
    "font-src 'self' data:; " +
    "frame-src http: https: data:;";
  const prod =
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "font-src 'self'; " +
    "connect-src 'self' https://api.anthropic.com; " +
    "frame-src http: https: data:;";
  const policy = is.dev ? dev : prod;
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let mainWindow: BrowserWindow | null = null;
/** Session ids that the boot reconcile swept; the auto-resume hook
 *  reads this once the renderer is loaded. Populated in whenReady. */
let reconciledSessionIds: string[] = [];

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0b0d', // matches --bg in design mockups
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,            // NF6
      contextIsolation: true,   // NF6
      nodeIntegration: false,   // NF6
      webSecurity: true,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
    // NOTE: auto-opening DevTools here was triggering a renderer
    // reload (WebSocket drop + second mount) on some Electron
    // versions. Press Cmd+Opt+I in the window to open them
    // manually if you need them.
  });

  // After the renderer is fully loaded and subscribed to events,
  // resume sessions that were live before the last shutdown. This
  // is the "default resume" behaviour — sessions don't tombstone
  // across an app restart; they pick back up automatically.
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void getSessionManager()
        .autoResumeRecent()
        .catch((err) => console.warn('[baton] autoResumeRecent failed:', err));
    }, 800);
  });
  void reconciledSessionIds; // kept for diagnostics; no longer scopes auto-resume

  // BATON_DEBUG_RESPAWN=<sessionId> → after first render, fire a
  // respawn on that session and log the outcome. Used to test the
  // remote-spawn path end-to-end without manual clicks.
  const debugRespawn = process.env['BATON_DEBUG_RESPAWN'];
  if (debugRespawn) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          console.log(`[BATON_DEBUG_RESPAWN] respawning ${debugRespawn}…`);
          const s = await getSessionManager().respawn(debugRespawn);
          console.log(`[BATON_DEBUG_RESPAWN] ok: ${s.id} status=${s.status} branch=${s.branch}`);
        } catch (err) {
          console.error('[BATON_DEBUG_RESPAWN] FAILED:', err);
        }
      }, 2000);
    });
  }

  // BATON_TEST=1 → after first render, auto-add the project at
  // BATON_TEST_PATH (default = repo root) and spawn a Claude Code
  // session in it. Used to verify the full flow end-to-end without
  // a human at the keyboard. Strictly dev-only.
  if (process.env['BATON_TEST'] === '1') {
    const target = process.env['BATON_TEST_PATH'] ?? process.cwd();
    const sessions = Number(process.env['BATON_TEST_SESSIONS'] ?? '1');
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const p = addProject(target);
          console.log(`[BATON_TEST] addProject ok: id=${p.id} path=${p.path}`);
          for (let i = 0; i < sessions; i++) {
            const s = await getSessionManager().spawn({
              projectId: p.id,
              backendId: 'claude-code',
              cwd: p.path,
            });
            console.log(`[BATON_TEST] spawn ${i + 1}/${sessions} ok: session=${s.id}`);
          }
        } catch (err) {
          console.error('[BATON_TEST] failed:', err);
        }
      }, 1500);
    });
  }

  // Forward renderer console + crashes to the main process stdout
  // so they're visible in the `npm run dev` terminal. Without this
  // the renderer can silently fail and look like a blank window.
  mainWindow.webContents.on('console-message', (...args: unknown[]) => {
    // Cross-version safe: Electron 28+ uses (event,level,message,line,src);
    // newer drafts use a single event object.
    const a = args as [unknown, number?, string?, number?, string?];
    const level = a[1] ?? -1;
    const message = a[2] ?? '';
    const line = a[3] ?? 0;
    const src = a[4] ?? '';
    const lvlName = ['debug', 'info', 'warn', 'error'][level] ?? 'log';
    console.log(`[renderer ${lvlName}] ${message} (${src}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] render-process-gone:', details);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load: ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on(
    'preload-error',
    (_e, preloadPath, error) => {
      console.error(`[preload] error in ${preloadPath}:`, error);
    }
  );

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Best-effort hand-off to the OS browser. Swallow rejection —
    // e.g. an unhandled scheme on macOS produces "No application in
    // the Launch Services database matches the input criteria" and
    // we don't want that as an unhandled promise rejection.
    void shell.openExternal(details.url).catch((err) => {
      console.warn('[baton] openExternal failed:', details.url, err);
    });
    return { action: 'deny' };
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (is.dev && rendererUrl) {
    // Wait until Vite is actually accepting connections before
    // loading. Avoids the ERR_CONNECTION_REFUSED race on cold boot
    // (and the spurious "second page render" my earlier retry caused).
    void waitForUrl(rendererUrl).then(() => mainWindow?.loadURL(rendererUrl));
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

async function waitForUrl(url: string, maxMs = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok || res.status === 404) return; // 404 also means it's listening
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.baton.app');

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Production-only CSP. In dev, leave the renderer without a CSP
  // header so Vite's WebSocket HMR isn't disturbed.
  if (!is.dev) installCsp();

  // Initialise SQLite — F2.4 / F12.3 / NF4 (crash recovery substrate).
  initDatabase();

  // Sessions from previous runs are still flagged as `running` in
  // SQLite — mark them as ended so the radar doesn't lie on reopen.
  // (PRD F2.4 restore must never leave stale live-status rows.)
  // Remember which ids were swept so we can auto-resume them after
  // the renderer is subscribed to events.
  reconciledSessionIds = getSessionManager().reconcileStaleSessions();

  // Wire the control-channel IPC bus before the window opens so the
  // renderer can call ping/meta/session.list immediately on mount.
  registerControlBus();

  // Notifier subscribes to AppEvents and turns needs-input/errored
  // transitions into native macOS notifications + dock badge. (PRD F9)
  startNotifier();

  // Warm any saved SSH connections so the dropdown badges show
  // real status the first time the user opens AddProjectDialog.
  warmAllConnections();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  closeDatabase();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  getSessionManager().killAll();
  dropAllConnections();
  closeDatabase();
});
