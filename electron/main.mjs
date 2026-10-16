// Agent Desk for macOS: runs the server inside the app and shows its page in one window.
import { app, BrowserWindow, Menu, desktopCapturer, dialog, session, shell } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';

const ROOT = path.dirname(import.meta.dirname);
let server;

// Apps opened from Finder get a bare PATH, so claude and codex in /opt/homebrew/bin would not be
// found. Ask the user's login shell for its PATH; markers skip anything their shell config prints.
function loginShellPath() {
  const mark = '__AGENT_DESK_PATH__';
  return new Promise(resolve => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], { timeout: 5000 }, (_err, stdout = '') => {
      resolve(stdout.match(new RegExp(`${mark}(.*?)${mark}`, 's'))?.[1] || process.env.PATH);
    });
  });
}

const openOutside = url => /^(https?|mailto):/.test(url) && shell.openExternal(url);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0b0c10', show: false, title: 'Agent Desk',
  });
  win.once('ready-to-show', () => win.show());
  // Links and window.open go to the default browser; only the Agent Desk page stays in the window.
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === new URL(server.url).origin) return;
    event.preventDefault();
    openOutside(url);
  });
  win.loadURL(server.url); // exactly the URL start() returns: it carries the login token
}

async function boot() {
  process.env.PATH = await loginShellPath();
  // Imported only now, because the server copies process.env for its agents when it loads.
  const { start } = await import('../server.mjs');
  const options = {
    dataDir: app.getPath('userData'),
    voiceHelper: app.isPackaged ? path.join(process.resourcesPath, 'desk-listen') : path.join(ROOT, 'native/build/desk-listen'),
  };
  server = await start({ ...options, port: 4848 }).catch(e => {
    if (e.code !== 'EADDRINUSE') throw e;
    return start({ ...options, port: 0 }); // 4848 is taken, so take any free port
  });

  // Screenshots: only Agent Desk's own page (not a browser pane) may capture the screen. On macOS 15+ the
  // system picker appears so you choose exactly what is shared; older versions get the main screen.
  const ownOrigin = new URL(server.url).origin;
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const fromApp = request.frame && !request.frame.parent && new URL(request.frame.url).origin === ownOrigin;
    if (!fromApp) return callback({});
    desktopCapturer.getSources({ types: ['screen'] }).then(([screen]) => callback({ video: screen }), () => callback({}));
  }, { useSystemPicker: true });
  // Terminals and inputs need the Edit menu for copy, paste and select all to work.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return server && createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // Mac convention: closing the window keeps the app and its agents running; the Dock icon reopens it.
  app.on('window-all-closed', () => {});
  app.on('activate', () => server && !BrowserWindow.getAllWindows().length && createWindow());
  app.on('will-quit', () => server?.close());
  app.whenReady().then(boot).catch(e => {
    dialog.showErrorBox('Agent Desk could not start', String(e?.stack || e));
    app.quit();
  });
}
