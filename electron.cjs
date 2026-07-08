const { app, BrowserWindow, desktopCapturer, session } = require('electron');
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
let captureWindow;
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

  serverProc = spawn('/opt/homebrew/bin/npx', ['tsx', 'server.ts'], {
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

// Always-on window that runs the real-time screen-capture pipeline. It loads /_capture
// (served by the backend), which grabs a live screen MediaStream via getDisplayMedia and
// POSTs JPEG frames to /api/screen-ingest.
//
// CRITICAL: it must genuinely RENDER, or Chromium throttles the <video> element that
// drives the capture — a `show:false` window delivers video frames seconds late (stale
// drawImage), which is exactly the multi-second latency we're chasing. So we show it but
// park it far off-screen and make it non-interactive: the user never sees it, but the
// compositor keeps the video pipeline running at full rate.
function createCaptureWindow() {
  captureWindow = new BrowserWindow({
    x: -4000, y: -4000,
    width: 320,
    height: 240,
    show: true,
    skipTaskbar: true,
    focusable: false,
    minimizable: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,   // keep timers + compositing at full rate off-screen
    },
  });
  captureWindow.setIgnoreMouseEvents(true);
  captureWindow.on('closed', () => { captureWindow = null; });
  captureWindow.loadURL('http://localhost:3001/_capture');
}

function killBackend() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
  if (viteProc) { viteProc.kill(); viteProc = null; }
  if (captureWindow) { captureWindow.close(); captureWindow = null; }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    // Auto-grant getDisplayMedia to the primary screen — no OS picker dialog. This is
    // what lets the hidden capture window pull a live screen stream unattended.
    // (Requires macOS Screen-Recording permission for the app; if that's denied the
    // request rejects and the server falls back to the screencapture slideshow.)
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: false });
      }).catch(() => callback({}));
    }, { useSystemPicker: false });

    spawnBackend();
    console.log('[electron] waiting for server and vite...');
    try {
      await Promise.all([waitForPort(3001), waitForPort(5173)]);
      console.log('[electron] both ports ready — waiting for React...');
      await new Promise(r => setTimeout(r, 2500));
      console.log('[electron] launching window');
      createWindow();
      createCaptureWindow();
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
