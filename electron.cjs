const { app, BrowserWindow, desktopCapturer, session } = require('electron');
const { spawn, execFile } = require('child_process');
const http = require('http');
const path = require('path');

// ── Auto-sync pipeline ───────────────────────────────────────────────────────
// Poll the dev branch and hard-sync this checkout to it, so pushed commits go live
// on this machine with no manual `git pull` + restart. The backend runs under
// `tsx watch` (see spawnBackend), so a synced server.ts change auto-restarts the
// server; Vite HMR + a window reload pick up frontend changes.
const SYNC_BRANCH = process.env.CRUCIBLE_SYNC_BRANCH || 'claude/remote-brain-capture-latency-yeas6j';
const SYNC_INTERVAL_MS = 15000;
const SYNC_ENABLED = process.env.CRUCIBLE_AUTOSYNC !== '0';
let syncing = false;

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

  // `tsx watch` restarts the server automatically whenever server.ts (or anything it
  // imports) changes on disk — which is how a git auto-sync pull goes live with no
  // manual restart.
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

// Run a git command in the repo dir; resolves { code, out } (never rejects).
function git(args) {
  return new Promise((resolve) => {
    execFile('/usr/bin/git', args, {
      cwd: __dirname,
      env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
    }, (err, stdout) => resolve({ code: err ? (err.code || 1) : 0, out: (stdout || '').trim() }));
  });
}

// One auto-sync tick: fetch the branch, and if the remote is ahead, hard-reset this
// checkout to it. `tsx watch` restarts the server on the resulting file changes; we
// reload the windows so the frontend + capture page pick up any changes too.
async function autoSyncTick() {
  if (syncing) return;
  syncing = true;
  try {
    const fetched = await git(['fetch', 'origin', SYNC_BRANCH, '--quiet']);
    if (fetched.code !== 0) return;
    const local = (await git(['rev-parse', 'HEAD'])).out;
    const remote = (await git(['rev-parse', `origin/${SYNC_BRANCH}`])).out;
    if (!local || !remote || local === remote) return;
    console.log(`[autosync] ${local.slice(0, 7)} → ${remote.slice(0, 7)} — syncing branch ${SYNC_BRANCH}`);
    const reset = await git(['reset', '--hard', `origin/${SYNC_BRANCH}`]);
    if (reset.code !== 0) { console.error('[autosync] reset failed:', reset.out); return; }
    console.log('[autosync] synced; tsx watch will restart the server');
    // Give tsx watch a moment to restart the backend, then refresh the windows so any
    // frontend/capture-page changes go live too.
    setTimeout(() => {
      if (mainWindow) mainWindow.webContents.reloadIgnoringCache();
      if (captureWindow) captureWindow.webContents.reloadIgnoringCache();
    }, 2500);
  } finally {
    syncing = false;
  }
}

async function startAutoSync() {
  if (!SYNC_ENABLED) { console.log('[autosync] disabled (CRUCIBLE_AUTOSYNC=0)'); return; }
  // Make sure we're actually on the sync branch before tracking it.
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out;
  if (branch !== SYNC_BRANCH) {
    console.log(`[autosync] switching ${branch} → ${SYNC_BRANCH}`);
    await git(['fetch', 'origin', SYNC_BRANCH, '--quiet']);
    const co = await git(['checkout', SYNC_BRANCH]);
    if (co.code !== 0) await git(['checkout', '-B', SYNC_BRANCH, `origin/${SYNC_BRANCH}`]);
  }
  console.log(`[autosync] watching origin/${SYNC_BRANCH} every ${SYNC_INTERVAL_MS / 1000}s`);
  setInterval(autoSyncTick, SYNC_INTERVAL_MS);
  autoSyncTick();
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

// Hidden, always-on window that runs the real-time screen-capture pipeline. It loads
// /_capture (served by the backend), which grabs a live screen MediaStream via
// getDisplayMedia and POSTs JPEG frames to /api/screen-ingest.
//
// backgroundThrottling:false keeps its timers running at full rate while hidden. (An
// earlier attempt to render it off-screen with show:true made latency *worse* — an
// off-screen window's compositing/rVFC cadence is throttled harder than a plain
// hidden window's timers, so we stick with show:false + a fixed-rate capture timer.)
function createCaptureWindow() {
  captureWindow = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
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
      startAutoSync();   // begin polling the branch for pushed commits
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
