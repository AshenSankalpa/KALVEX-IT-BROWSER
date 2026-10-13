'use strict';

// Auto-update via electron-updater, using GitHub Releases as the feed (the
// owner/repo comes from the "publish" block in package.json, which
// electron-builder writes into the installed app as resources/app-update.yml).
//
// Designed for a cash register, so it never acts on its own:
//   - nothing downloads until the cashier taps "Download"
//   - nothing restarts until the cashier taps "Restart & install"
//   - "Later" leaves the downloaded update to install the next time the app is
//     quit normally (autoInstallOnAppQuit)
//   - a failed AUTOMATIC check (offline, no release published) is only logged —
//     no pop-up; a failed MANUAL check says what went wrong
//
// States: idle | checking | available | downloading | downloaded |
//         not-available | error | disabled

const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');

const STARTUP_CHECK_DELAY_MS = 45 * 1000;          // let the POS page and hardware check settle first
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // counters can run for days without a restart
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;     // offline at startup shouldn't wait 6h for the next try
const MAX_RETRIES = 4;

function isNoReleaseError(message) {
  return /404|Cannot find latest|latest\.yml|No published versions|HttpError: 404/i.test(message);
}

function isNetworkError(message) {
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|net::|getaddrinfo|socket hang up|timed out|timeout/i.test(message);
}

function friendlyError(message) {
  if (isNoReleaseError(message)) return 'No update has been published yet.';
  if (isNetworkError(message)) return 'Could not reach the update server. Check the internet connection.';
  if (/sha512|checksum|signature|verif/i.test(message)) return 'The downloaded update failed verification and was discarded.';
  return 'The update check failed.';
}

// Options:
//   getWindow()    returns the window to show notices in
//   forceActive    TESTS ONLY — lets an unpackaged run use the updater
//   feed           TESTS ONLY — overrides the update feed (e.g. a local server)
function createUpdater({ getWindow, forceActive = false, feed = null } = {}) {
  const log = {
    info: (m) => console.log('[Updater]', m),
    warn: (m) => console.warn('[Updater]', m),
    error: (m) => console.error('[Updater]', m),
    debug: () => {}
  };

  let state = {
    status: 'idle',
    currentVersion: app.getVersion(),
    version: null,
    percent: 0,
    error: null,
    note: null,
    checkedAt: null
  };
  let manualCheck = false;
  let announcedVersion = null;
  let lastProgressBroadcast = 0;
  let startupTimer = null;
  let periodicTimer = null;
  let retryTimer = null;
  let retries = 0;
  let started = false;

  const isActive = () => app.isPackaged || forceActive;

  autoUpdater.logger = log;
  autoUpdater.autoDownload = false;        // the cashier decides
  autoUpdater.autoInstallOnAppQuit = true; // "Later" => installs on the next normal quit
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  if (forceActive) autoUpdater.forceDevUpdateConfig = true;
  if (feed) autoUpdater.setFeedURL(feed);

  // ---- notices -----------------------------------------------------------
  // Rendered inside the POS page (a native Windows toast is unreliable over a
  // kiosk full-screen window). Text/labels go through JSON.stringify and
  // textContent, so nothing from the feed can inject markup. Buttons call only
  // the fixed bridge methods below.
  function showToast({ text, level = 'info', actions = [], autoHideMs = 0 }) {
    const win = getWindow && getWindow();
    if (!win || win.isDestroyed()) return;
    const background = { info: '#1d3557', ok: '#1b5e20', warn: '#7a4b00' }[level] || '#1d3557';
    const script = `
      (function () {
        var id = '__update_toast__';
        var old = document.getElementById(id);
        if (old) old.remove();
        if (!document.body) return;
        var el = document.createElement('div');
        el.id = id;
        el.setAttribute('role', 'status');
        el.style.cssText = 'position:fixed;left:16px;bottom:96px;max-width:380px;padding:12px 14px;' +
          'border-radius:10px;font:13px/1.4 system-ui,sans-serif;color:#fff;background:' + ${JSON.stringify(background)} + ';' +
          'box-shadow:0 2px 12px rgba(0,0,0,.4);z-index:2147483645;';
        var msg = document.createElement('div');
        msg.textContent = ${JSON.stringify(text)};
        el.appendChild(msg);
        var actions = ${JSON.stringify(actions)};
        if (actions.length) {
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
          actions.forEach(function (a) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = a.label;
            b.style.cssText = 'min-height:36px;padding:6px 14px;border:0;border-radius:6px;font:600 13px system-ui,sans-serif;cursor:pointer;' +
              (a.primary ? 'background:#fff;color:#111;' : 'background:rgba(255,255,255,.18);color:#fff;');
            b.addEventListener('click', function () {
              el.remove();
              var api = window.electronAPI;
              if (!api) return;
              if (a.action === 'download' && api.downloadUpdate) api.downloadUpdate();
              else if (a.action === 'install' && api.installUpdate) api.installUpdate();
            });
            row.appendChild(b);
          });
          el.appendChild(row);
        }
        document.body.appendChild(el);
        var hideAfter = ${Number(autoHideMs) || 0};
        if (hideAfter > 0) setTimeout(function () { if (el.parentNode) el.remove(); }, hideAfter);
      })();
      true;
    `;
    win.webContents.executeJavaScript(script).catch((err) => log.error(`could not show notice: ${err.message}`));
  }

  function broadcast() {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update-status', { ...state });
  }

  function setState(patch) {
    state = { ...state, ...patch };
    broadcast();
  }

  // ---- updater events ----------------------------------------------------
  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking', error: null, note: null });
    if (manualCheck) showToast({ text: 'Checking for updates…', autoHideMs: 15000 });
  });

  autoUpdater.on('update-available', (info) => {
    retries = 0;
    setState({ status: 'available', version: info.version, percent: 0, checkedAt: new Date().toISOString() });
    // Announce once per version (periodic checks stay quiet), but always for a manual check.
    if (manualCheck || announcedVersion !== info.version) {
      announcedVersion = info.version;
      showToast({
        text: `Update available: v${info.version} (this app is v${state.currentVersion}).`,
        actions: [
          { label: 'Download', action: 'download', primary: true },
          { label: 'Later', action: 'dismiss' }
        ]
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    retries = 0;
    setState({ status: 'not-available', checkedAt: new Date().toISOString() });
    if (manualCheck) {
      showToast({ text: `You're up to date (v${state.currentVersion}).`, level: 'ok', autoHideMs: 8000 });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent || 0);
    const now = Date.now();
    if (percent === state.percent || now - lastProgressBroadcast < 700) return;
    lastProgressBroadcast = now;
    setState({ status: 'downloading', percent });
    showToast({ text: `Downloading update v${state.version}… ${percent}%` });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'downloaded', version: info.version, percent: 100 });
    showToast({
      level: 'ok',
      text: `Update v${info.version} is ready. Finish any open sale, then restart to install. It will otherwise install the next time the app is closed.`,
      actions: [
        { label: 'Restart & install', action: 'install', primary: true },
        { label: 'Later', action: 'dismiss' }
      ]
    });
  });

  autoUpdater.on('error', (err) => {
    const raw = String((err && err.message) || err || 'unknown error');

    // No release published yet is a normal state, not a failure.
    if (isNoReleaseError(raw) && state.status !== 'downloading') {
      setState({ status: 'not-available', error: null, note: 'no-release-published', checkedAt: new Date().toISOString() });
      log.info('no published release found yet');
      if (manualCheck) showToast({ text: 'No update has been published yet.', autoHideMs: 8000 });
      return;
    }

    const wasDownloading = state.status === 'downloading';
    setState({ status: wasDownloading ? 'available' : 'error', error: friendlyError(raw) });
    log.warn(`${wasDownloading ? 'download' : 'check'} failed: ${raw.split('\n')[0]}`);

    if (manualCheck || wasDownloading) {
      showToast({ level: 'warn', text: `${friendlyError(raw)}${wasDownloading ? ' The download was stopped; you can try again.' : ''}`, autoHideMs: 12000 });
    } else if (isNetworkError(raw)) {
      scheduleRetry();
    }
  });

  // ---- actions -----------------------------------------------------------
  async function checkForUpdates({ manual = false } = {}) {
    manualCheck = manual;

    if (!isActive()) {
      setState({ status: 'disabled', note: 'not-packaged' });
      if (manual) showToast({ text: 'Updates are only available in the installed app.', autoHideMs: 8000 });
      return { ...state };
    }
    if (state.status === 'checking' || state.status === 'downloading') return { ...state };
    if (state.status === 'downloaded') {
      if (manual) {
        showToast({
          level: 'ok',
          text: `Update v${state.version} is already downloaded. Restart to install it.`,
          actions: [
            { label: 'Restart & install', action: 'install', primary: true },
            { label: 'Later', action: 'dismiss' }
          ]
        });
      }
      return { ...state };
    }

    try {
      await autoUpdater.checkForUpdates(); // outcome arrives through the events above
    } catch (err) {
      // already reported by the 'error' event
    }
    return { ...state };
  }

  async function downloadUpdate() {
    if (state.status !== 'available') return { ...state };
    setState({ status: 'downloading', percent: 0 });
    showToast({ text: `Downloading update v${state.version}…` });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      // already reported by the 'error' event
    }
    return { ...state };
  }

  // Silent install + relaunch. Only ever acts on an update that has been
  // downloaded AND hash-verified by electron-updater.
  function installUpdate() {
    if (state.status !== 'downloaded') return { success: false, error: 'There is no downloaded update to install.' };
    log.info(`installing v${state.version} and restarting`);
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { success: true };
  }

  function scheduleRetry() {
    if (retryTimer || retries >= MAX_RETRIES) return;
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      checkForUpdates({ manual: false });
    }, RETRY_AFTER_FAILURE_MS);
    if (retryTimer.unref) retryTimer.unref();
  }

  // ---- wiring ------------------------------------------------------------
  function start() {
    if (started) return;
    started = true;

    ipcMain.handle('update-check', () => checkForUpdates({ manual: true }));
    ipcMain.handle('update-download', () => downloadUpdate());
    ipcMain.handle('update-install', () => installUpdate());
    ipcMain.handle('update-get-state', () => ({ ...state }));

    if (!isActive()) {
      log.info('running unpackaged — automatic update checks are off');
      return;
    }
    startupTimer = setTimeout(() => checkForUpdates({ manual: false }), STARTUP_CHECK_DELAY_MS);
    periodicTimer = setInterval(() => checkForUpdates({ manual: false }), PERIODIC_CHECK_INTERVAL_MS);
    if (startupTimer.unref) startupTimer.unref();
    if (periodicTimer.unref) periodicTimer.unref();
  }

  function dispose() {
    clearTimeout(startupTimer);
    clearInterval(periodicTimer);
    clearTimeout(retryTimer);
    autoUpdater.removeAllListeners();
    for (const channel of ['update-check', 'update-download', 'update-install', 'update-get-state']) {
      try { ipcMain.removeHandler(channel); } catch (err) { /* not registered */ }
    }
  }

  return { start, dispose, checkForUpdates, downloadUpdate, installUpdate, getState: () => ({ ...state }) };
}

module.exports = { createUpdater, friendlyError, isNoReleaseError, isNetworkError };
