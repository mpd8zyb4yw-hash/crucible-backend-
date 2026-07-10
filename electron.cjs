const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

// ── Dedicated data location — do NOT share with other crucible builds ────────
// Default userData would be ~/Library/Application Support/crucible, which every
// crucible build on this machine collides on. Pin a unique name + path so this
// app owns its cookies/cache/storage exclusively.
app.setName('crucible-local');
app.setPath('userData', path.join(app.getPath('appData'), 'crucible-local'));

let mainWindow;
let serverProc;
let viteProc;

function waitForPort(port, retries = 40, delay = 1000) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`http://localhost:${port}`, (res) => {
        resolve();
      }).on('error', () => {
        if (n <= 0) return reject(new Error(`Port ${port} never ready`));
        setTimeout(() => attempt(n - 1), delay);
      });
    };
    attempt(retries);
  });
}

function spawnBackend() {
  const cwd = path.join(__dirname);

  const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''), FORCE_COLOR: '0' };

  // `tsx watch` so a `git pull` of new server code is picked up without a manual restart.
  // Safe: every runtime write goes to `.crucible/` (a dot-dir tsx-watch ignores), so the
  // server's own file writes never trigger a reload loop.
  serverProc = spawn('/opt/homebrew/bin/npx', ['tsx', 'watch', 'server.ts'], {
    cwd,
    shell: false,
    env,
  });
  serverProc.stdout.on('data', d => console.log('[server]', d.toString().trim()));
  serverProc.stdout.on('error', () => {});
  serverProc.stderr.on('data', d => console.error('[server:err]', d.toString().trim()));

  viteProc = spawn('/opt/homebrew/bin/npx', ['vite'], {
    cwd,
    shell: false,
    env,
  });
  viteProc.stdout.on('data', d => console.log('[vite]', d.toString().trim()));
  viteProc.stdout.on('error', () => {});
  viteProc.stderr.on('data', d => console.error('[vite:err]', d.toString().trim()));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#09090b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL('http://localhost:5173');
}

function killBackend() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
  if (viteProc) { viteProc.kill(); viteProc = null; }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    spawnBackend();
    console.log('[electron] waiting for server and vite...');
    try {
      await Promise.all([waitForPort(3001), waitForPort(5173)]);
      console.log('[electron] both ports ready — waiting for React...');
      await new Promise(r => setTimeout(r, 2500));
      console.log('[electron] launching window');
      createWindow();
    } catch (err) {
      console.error('[electron] startup failed:', err.message);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    killBackend();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', killBackend);

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
}
