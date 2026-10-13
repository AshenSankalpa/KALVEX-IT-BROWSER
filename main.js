const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const Store = require('electron-store');

const POS_URL = 'https://virelpos.kalvexit.com';

let mainWindow;
let hardwareStartupCheckDone = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    kiosk: true,              // Kiosk Full Screen Mode
    frame: false,             // custom (in-page) title bar; drive it via minimizeWindow/maximizeWindow/closeWindow
    backgroundColor: '#090d16', // matches the POS dark theme so there's no white flash before the page paints
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadURL(POS_URL);

  // Web App එකෙන් window.print() කැඳවූ විටද Cashier Silent Print ක්‍රියාත්මක වීම
  mainWindow.webContents.on('did-finish-load', () => {
    // First load only (this event fires again on every reload/navigation):
    // verify the printers saved in the hardware config are still there. Runs
    // after the page loads so the notification toast has somewhere to render.
    if (!hardwareStartupCheckDone) {
      hardwareStartupCheckDone = true;
      runStartupHardwareCheck();
    }

    // The trailing `true;` keeps the script's completion value a primitive —
    // without it the completion value is the assigned Function itself, which
    // Electron cannot structured-clone back across the IPC boundary and throws
    // "An object could not be cloned" as an unhandled rejection on this promise.
    mainWindow.webContents.executeJavaScript(`
      window.print = function() {
        if (window.electronAPI) {
          window.electronAPI.printReceipt({ silent: true });
        }
      };
      true;
    `).catch((err) => {
      console.error('Failed to inject window.print override:', err);
    });

    // Edge-reveal touch controls (Minimize / Close): this app loads a REMOTE
    // page with no local header component to add buttons to, and kiosk mode
    // strips all native OS window chrome, so this is injected directly onto
    // the loaded page rather than built into its own UI. Hidden by default —
    // a small pull-tab in the top-right corner opens a sliding drawer on tap,
    // hover (mouse/testing), or a swipe-down gesture starting in that corner.
    // Re-injected on every did-finish-load, guarded by id so a reload doesn't
    // stack duplicates; may not survive a pure client-side (SPA pushState)
    // route change if the frontend ever wipes document.body.
    mainWindow.webContents.insertCSS(`
      #__kiosk_edge_trigger__ {
        position: fixed;
        top: 0;
        right: 24px;
        width: 64px;
        height: 14px;
        background: rgba(0, 0, 0, 0.25);
        border-radius: 0 0 10px 10px;
        z-index: 2147483647;
        cursor: pointer;
        transition: opacity 0.2s ease;
      }
      #__kiosk_edge_trigger__:hover { opacity: 0.6; }
      #__kiosk_drawer__ {
        position: fixed;
        top: 0;
        right: 12px;
        transform: translateY(-120%);
        transition: transform 0.25s ease;
        z-index: 2147483646;
        display: flex;
        gap: 10px;
        padding: 14px 12px 10px;
        background: rgba(30, 30, 30, 0.92);
        border-radius: 0 0 14px 14px;
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.4);
      }
      #__kiosk_drawer__.open { transform: translateY(0); }
    `).catch((err) => {
      console.error('Failed to inject kiosk drawer CSS:', err);
    });

    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (document.getElementById('__kiosk_edge_trigger__')) return;

        var CORNER_ZONE_WIDTH = 140;  // px from the right edge that arms swipe tracking
        var CORNER_ZONE_HEIGHT = 30;  // px from the top edge that arms swipe tracking
        var SWIPE_THRESHOLD = 35;     // px of downward drag before the drawer opens

        var trigger = document.createElement('div');
        trigger.id = '__kiosk_edge_trigger__';
        trigger.setAttribute('aria-label', 'Window controls');

        var drawer = document.createElement('div');
        drawer.id = '__kiosk_drawer__';

        function openDrawer() { drawer.classList.add('open'); }
        function closeDrawer() { drawer.classList.remove('open'); }
        function toggleDrawer() { drawer.classList.toggle('open'); }

        function makeButton(label, bg, ariaLabel, onTap) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = label;
          btn.setAttribute('aria-label', ariaLabel);
          btn.style.cssText = [
            'width:52px', 'height:52px', 'border-radius:50%', 'border:none',
            'background:' + bg, 'color:#fff', 'font-size:20px',
            'font-family:sans-serif', 'line-height:1',
            'box-shadow:0 2px 6px rgba(0,0,0,0.35)', 'cursor:pointer'
          ].join(';');
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            onTap();
          });
          return btn;
        }

        var updateBtn = makeButton('\\u21BB', '#2d6a4f', 'Check for updates', function () {
          if (window.electronAPI && window.electronAPI.checkForUpdates) {
            window.electronAPI.checkForUpdates();
          }
          closeDrawer();
        });

        var minimizeBtn = makeButton('\\u2212', '#444444', 'Minimize', function () {
          if (window.electronAPI && window.electronAPI.minimizeWindow) {
            window.electronAPI.minimizeWindow();
          }
          closeDrawer();
        });

        var closeBtn = makeButton('\\u2715', '#c0392b', 'Close application', function () {
          if (window.confirm('Close the POS application?')) {
            if (window.electronAPI && window.electronAPI.closeWindow) {
              window.electronAPI.closeWindow();
            }
          }
          closeDrawer();
        });

        drawer.appendChild(updateBtn);
        drawer.appendChild(minimizeBtn);
        drawer.appendChild(closeBtn);
        document.body.appendChild(trigger);
        document.body.appendChild(drawer);

        trigger.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleDrawer();
        });

        // Desktop/mouse convenience (no effect on touch, which has no hover)
        trigger.addEventListener('mouseenter', openDrawer);
        drawer.addEventListener('mouseleave', function () {
          setTimeout(function () {
            if (!trigger.matches(':hover') && !drawer.matches(':hover')) closeDrawer();
          }, 300);
        });

        // Swipe-down-from-top-right-corner gesture
        var touchStartY = null;
        var tracking = false;

        document.addEventListener('touchstart', function (e) {
          if (!e.touches || !e.touches.length) return;
          var t = e.touches[0];
          if (t.clientY <= CORNER_ZONE_HEIGHT && t.clientX >= window.innerWidth - CORNER_ZONE_WIDTH) {
            touchStartY = t.clientY;
            tracking = true;
          }
        }, { passive: true });

        document.addEventListener('touchmove', function (e) {
          if (!tracking || !e.touches || !e.touches.length) return;
          var t = e.touches[0];
          if (t.clientY - touchStartY > SWIPE_THRESHOLD) {
            openDrawer();
            tracking = false;
          }
        }, { passive: true });

        document.addEventListener('touchend', function () {
          tracking = false;
        }, { passive: true });

        // Tap/click anywhere outside the drawer closes it again
        document.addEventListener('click', function (e) {
          if (drawer.classList.contains('open') && e.target !== trigger && !drawer.contains(e.target)) {
            closeDrawer();
          }
        }, true);
      })();
      true;
    `).catch((err) => {
      console.error('Failed to inject kiosk drawer controls:', err);
    });
  });

  // Keyboard Shortcuts (Window Controls & Navigation)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // 1. Escape හෝ F11: Kiosk Mode එකෙන් අයින් වී සාමාන්‍ය Window එකක් වීම (Window Controls පෙනේ)
    if (input.key === 'Escape' || input.key === 'F11') {
      const isKiosk = mainWindow.isKiosk();
      mainWindow.setKiosk(!isKiosk);
      event.preventDefault();
    }

    // 2. Ctrl + M: කෙලින්ම Taskbar එකට Minimize කර Windows Desktop එකට යාම
    if (input.control && input.key.toLowerCase() === 'm') {
      mainWindow.minimize();
      event.preventDefault();
    }

    // 3. Ctrl + Q: App එක සම්පූර්ණයෙන්ම Close කර Quit වීම
    if (input.control && input.key.toLowerCase() === 'q') {
      app.quit();
      event.preventDefault();
    }

    // 4. Ctrl + Shift + P: Windows Native Print Dialog එක බැලීමට
    if (input.control && input.shift && input.key.toLowerCase() === 'p') {
      mainWindow.webContents.print({ silent: false });
      event.preventDefault();
    }
  });
}

// System Printers ලැයිස්තුව ලබාගැනීම (dynamic discovery: name, displayName, isDefault, status)
ipcMain.handle('get-system-printers', async () => {
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) return [];
    const printers = await win.webContents.getPrintersAsync();
    // Coerce to plain primitives so the IPC reply is always structured-clone-safe,
    // regardless of what shape a given OS/driver's printer descriptor comes back as.
    return printers.map(p => ({
      name: String(p.name || ''),
      displayName: String(p.displayName || p.name || ''),
      isDefault: Boolean(p.isDefault),
      status: Number(p.status || 0)
    }));
  } catch (err) {
    console.error('get-system-printers error:', err);
    return [];
  }
});

// Quick diagnostic: just the printer names Windows currently sees, for
// startup logging (frontend or terminal) — get-system-printers above
// already covers this with richer per-printer detail (displayName,
// isDefault, status); this is a thinner, simpler companion for a quick
// startup log line rather than a UI printer picker.
ipcMain.handle('get-available-printers', async () => {
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) return [];
    const printers = await win.webContents.getPrintersAsync();
    return printers.map((p) => String(p.name || ''));
  } catch (err) {
    console.error('get-available-printers error:', err);
    return [];
  }
});

// ============================================================
// CASH DRAWER KICK (open-cash-drawer)
// ============================================================
//
// Combined drawer-kick buffer covering the three common standards, so one
// job attempts to trigger whichever pin/protocol the connected drawer
// actually uses:
//   - ESC p 0 (Pin 2): Epson, Xprinter, Rongta, and most generic clones
//   - ESC p 1 (Pin 5): Star Micronics and alternates wired to the other pin
//   - DLE DC4 (real-time pulse): the ESC/POS "real-time" drawer command
// NOTE: if the target printer's driver isn't in genuine RAW-passthrough
// mode, none of these variants will behave as commands — the printer will
// instead render them as literal (garbled) text, same as any other raw byte
// sequence sent this way. Widening this buffer doesn't fix that; the fix
// for garbled text output is on the Windows printer-configuration side
// (Printer Properties > Advanced > Print Processor should be RAW, or the
// printer should be installed via a "Generic / Text Only"-style driver).
const CASH_DRAWER_KICK_BYTES = Buffer.from([
  0x1b, 0x70, 0x00, 0x19, 0xfa, // Pin 2
  0x1b, 0x70, 0x01, 0x19, 0xfa, // Pin 5
  0x10, 0x14, 0x01, 0x00, 0x05  // DLE real-time pulse
]);

// ---- Raw transport -----------------------------------------------------
//
// This deliberately does NOT go through webContents.print(). Chromium
// rasterizes whatever it's given into a page image before the driver sees it,
// so ESC/POS bytes sent that way would be rendered as text, not executed.
//
// Raw jobs go to the Windows print spooler directly with datatype "RAW"
// (OpenPrinter / StartDocPrinter / WritePrinter), which hands the bytes to the
// printer untouched. Unlike the `copy /b \\localhost\<name>` trick this
// replaces, it needs no printer sharing. No native Node module either: a
// small C# helper is compiled by PowerShell (Add-Type) once, cached as a DLL
// in the app's data folder, and later jobs just load it. The DLL name carries
// a hash of the source, so a changed helper can never load a stale DLL.
// Requires Windows PowerShell with Add-Type allowed (it isn't under
// Constrained Language Mode / some AppLocker setups — the error says so).
const RAW_PRINTER_CS = `
using System;
using System.Runtime.InteropServices;
public static class RawPrinterIO {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFOW di);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)] static extern bool WritePrinter(IntPtr h, IntPtr bytes, int count, out int written);

  // Returns "" on success, otherwise a short description of what failed.
  public static string Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "OpenPrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")";
    try {
      DOCINFOW di = new DOCINFOW(); di.pDocName = "POS raw job"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return "StartDocPrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")";
      try {
        if (!StartPagePrinter(h)) return "StartPagePrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")";
        try {
          IntPtr p = Marshal.AllocCoTaskMem(data.Length);
          try {
            Marshal.Copy(data, 0, p, data.Length);
            int written;
            if (!WritePrinter(h, p, data.Length, out written)) return "WritePrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")";
            if (written != data.Length) return "WritePrinter wrote " + written + " of " + data.Length + " bytes";
            return "";
          } finally { Marshal.FreeCoTaskMem(p); }
        } finally { EndPagePrinter(h); }
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
`;
const RAW_PRINTER_CS_HASH = crypto.createHash('sha1').update(RAW_PRINTER_CS).digest('hex').slice(0, 10);
const RAW_JOB_TIMEOUT_MS = 20000; // per job, once the helper is running
const MAX_RAW_BYTES = 2 * 1024 * 1024;

// A long-lived helper: PowerShell starts and loads the helper DLL ONCE, then
// reads one JSON job per line from stdin ({"id","printer","file"}) and answers
// one JSON line per job ({"id","ok"} or {"id","error"}). Spawning PowerShell
// per job cost 1-6 s, which is far too slow for a drawer kick on every cash
// sale; a warm helper answers in milliseconds.
//
// Jobs are parsed as JSON data (ConvertFrom-Json), never spliced into script
// text, so a printer name can't inject PowerShell. stdin/stdout use explicit
// BOM-less UTF-8 streams instead of the console code page, so non-ASCII
// printer names and error text survive the round trip.
function buildRawWorkerScript() {
  return `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true
try {
  $src = @'
${RAW_PRINTER_CS}
'@
  if (-not (Test-Path -LiteralPath $env:RAW_DLL)) {
    $tmp = $env:RAW_DLL + '.' + $PID + '.tmp'
    Add-Type -TypeDefinition $src -OutputAssembly $tmp
    try { Move-Item -LiteralPath $tmp -Destination $env:RAW_DLL -ErrorAction Stop }
    catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
  }
  Add-Type -Path $env:RAW_DLL
} catch {
  $out.WriteLine((@{ ready = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  exit 3
}
$out.WriteLine('{"ready":true}')
while ($true) {
  $line = $in.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $job = $line | ConvertFrom-Json
    $id = $job.id
    $bytes = [System.IO.File]::ReadAllBytes([string]$job.file)
    $err = [RawPrinterIO]::Send([string]$job.printer, $bytes)
    if ($err) { $reply = @{ id = $id; error = $err } } else { $reply = @{ id = $id; ok = $true } }
  } catch {
    $reply = @{ id = $id; error = $_.Exception.Message }
  }
  $out.WriteLine(($reply | ConvertTo-Json -Compress))
}
`;
}

function getRawHelperDllPath() {
  let dir;
  try {
    dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    dir = os.tmpdir();
  }
  return path.join(dir, `raw-printer-io-${RAW_PRINTER_CS_HASH}.dll`);
}

// ---- helper process lifecycle ----
// One helper at a time. If it dies it is dropped and the next job (or the
// prewarm) starts a fresh one; a job that times out kills it, since a wedged
// helper would otherwise stall every job queued behind it.
let rawWorker = null;

function spawnRawWorker() {
  const encodedScript = Buffer.from(buildRawWorkerScript(), 'utf16le').toString('base64');
  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript],
    { windowsHide: true, env: { ...process.env, RAW_DLL: getRawHelperDllPath() } }
  );

  const worker = { proc, pending: new Map(), nextId: 1, buffer: '', dead: false };
  let readySettled = false;
  worker.ready = new Promise((resolve, reject) => {
    worker.markReady = () => { if (!readySettled) { readySettled = true; resolve(); } };
    worker.markFailed = (message) => { if (!readySettled) { readySettled = true; reject(new Error(message)); } };
  });
  worker.ready.catch(() => {}); // the prewarm doesn't await it; failures are reported where they matter

  const startupTimer = setTimeout(() => {
    worker.markFailed('print helper did not start within 30s');
    try { proc.kill(); } catch (err) { /* already gone */ }
  }, 30000);

  const shutDown = (reason) => {
    if (worker.dead) return;
    worker.dead = true;
    clearTimeout(startupTimer);
    if (rawWorker === worker) rawWorker = null;
    worker.markFailed(reason);
    for (const job of worker.pending.values()) {
      clearTimeout(job.timer);
      job.resolve({ success: false, error: reason });
    }
    worker.pending.clear();
  };

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    worker.buffer += chunk;
    let newline;
    while ((newline = worker.buffer.indexOf('\n')) >= 0) {
      const line = worker.buffer.slice(0, newline).trim();
      worker.buffer = worker.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (err) { continue; }
      if (message.ready === true) {
        clearTimeout(startupTimer);
        worker.markReady();
      } else if (message.ready === false) {
        worker.markFailed(`print helper failed to load: ${message.error || 'unknown error'}`);
      } else if (message.id !== undefined && worker.pending.has(message.id)) {
        const job = worker.pending.get(message.id);
        worker.pending.delete(message.id);
        clearTimeout(job.timer);
        job.resolve(message.ok ? { success: true } : { success: false, error: String(message.error || 'unknown error') });
      }
    }
  });
  proc.stderr.on('data', () => {}); // drain so the helper can never block on a full pipe
  proc.stdin.on('error', () => {}); // EPIPE once the helper dies — the exit handler reports it
  proc.on('error', (err) => shutDown(`could not start PowerShell: ${err.message}`));
  proc.on('exit', (code) => shutDown(`print helper exited (code ${code})`));
  return worker;
}

async function getRawWorker() {
  if (!rawWorker || rawWorker.dead) rawWorker = spawnRawWorker();
  const worker = rawWorker;
  await worker.ready;
  return worker;
}

// Start the helper in the background shortly after launch so the first real
// drawer kick / raw print doesn't pay for PowerShell's cold start.
function prewarmRawWorker() {
  if (process.platform !== 'win32') return;
  getRawWorker().catch((err) => {
    console.warn('[Raw] print helper prewarm failed (it will be retried on first use):', err.message);
  });
}

app.on('will-quit', () => {
  if (rawWorker && !rawWorker.dead) {
    try { rawWorker.proc.kill(); } catch (err) { /* already gone */ }
  }
});

// Sends bytes to an already-resolved Windows printer queue. Never rejects.
// Resolves { success: true, bytes } or { success: false, error }.
async function sendRawToPrinter(printerName, bytes) {
  const tempFile = path.join(
    os.tmpdir(),
    `rawjob_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`
  );
  try {
    fs.writeFileSync(tempFile, bytes);
  } catch (err) {
    return { success: false, error: `could not stage the raw job: ${err.message}` };
  }

  try {
    let worker;
    try {
      worker = await getRawWorker();
    } catch (err) {
      return { success: false, error: err.message };
    }

    const result = await new Promise((resolve) => {
      const id = worker.nextId++;
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        resolve({ success: false, error: `timed out after ${RAW_JOB_TIMEOUT_MS / 1000}s` });
        try { worker.proc.kill(); } catch (err) { /* already gone */ }
      }, RAW_JOB_TIMEOUT_MS);
      worker.pending.set(id, { resolve, timer });
      worker.proc.stdin.write(JSON.stringify({ id, printer: printerName, file: tempFile }) + '\n');
    });
    return result.success ? { success: true, bytes: bytes.length } : result;
  } finally {
    fs.unlink(tempFile, () => {}); // best-effort cleanup
  }
}

// ---- Cash drawer -------------------------------------------------------

async function kickCashDrawer(payload) {
  // A bare string is taken as the printer name — without this, a caller
  // passing 'KitchenPrinter' would be ignored and silently kick the cashier.
  const requestedDeviceName =
    (typeof payload === 'string' && payload.trim()) ||
    (payload && (payload.deviceName || payload.printerName)) ||
    DEFAULT_DEVICE_NAMES.cashier;

  // Same exact-match resolution as every other print channel — no fallback
  // to a different printer if CashierPrinter is offline/misconfigured.
  const { matched: deviceName, available } = await resolvePrinterName(requestedDeviceName);
  if (!deviceName) {
    const error = `Target printer "${requestedDeviceName}" not found or offline. Cash drawer kick rejected to prevent misrouting. Available: ${available.join(', ') || '(none detected)'}`;
    console.error(`open-cash-drawer: ${error}`);
    return { success: false, error };
  }

  const result = await sendRawToPrinter(deviceName, CASH_DRAWER_KICK_BYTES);
  if (!result.success) {
    const error = `Cash drawer kick failed on "${deviceName}": ${result.error}`;
    console.error(`open-cash-drawer: ${error}`);
    return { success: false, error };
  }
  return { success: true };
}

ipcMain.handle('open-cash-drawer', (event, payload) => kickCashDrawer(payload));

// ---- print-raw-silent --------------------------------------------------
//
// window.electronAPI.printRawSilent(data) — send raw bytes (ESC/POS) to a
// station printer with no dialog and no rendering. `data` may be:
//   - bytes: Uint8Array / ArrayBuffer / Buffer, or a number array (0-255)
//   - a string: latin1 (1 char = 1 byte) unless { encoding } says otherwise;
//     a string with characters above 0xFF is rejected rather than truncated
//   - an object: { data | bytes | buffer | raw | commands, encoding?,
//       printerName | deviceName | printer | targetPrinter | name | device?,
//       type? ('cashier' | 'kitchen' | 'kot' | 'bot' | 'bar' | 'barcode') }
// or positional: (bytes, printerName).
// Printer rules match every other channel: an explicit name wins, else a
// known station `type`, else (nothing given at all) the cashier printer; an
// unknown type or an uninstalled printer FAILS instead of guessing.
const RAW_ENCODINGS = new Set(['base64', 'hex', 'latin1', 'binary', 'utf8', 'utf-8', 'ascii']);
const RAW_DATA_KEYS = ['data', 'bytes', 'buffer', 'raw', 'commands'];
const RAW_PRINTER_NAME_KEYS = ['printerName', 'deviceName', 'printer', 'targetPrinter', 'name', 'device'];

function isJsonBuffer(value) {
  return !!value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data);
}

function toRawBuffer(value, encoding) {
  if (value === undefined || value === null) return { error: 'no data to print' };

  let buf;
  if (Buffer.isBuffer(value)) {
    buf = Buffer.from(value);
  } else if (value instanceof ArrayBuffer) {
    buf = Buffer.from(new Uint8Array(value));
  } else if (ArrayBuffer.isView(value)) {
    buf = Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  } else if (isJsonBuffer(value)) {
    return toRawBuffer(value.data);
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!Number.isInteger(value[i]) || value[i] < 0 || value[i] > 255) {
        return { error: `byte array has an invalid value at index ${i} (each must be an integer 0-255)` };
      }
    }
    buf = Buffer.from(value);
  } else if (typeof value === 'string') {
    let enc = typeof encoding === 'string' ? encoding.trim().toLowerCase() : '';
    if (enc && !RAW_ENCODINGS.has(enc)) {
      return { error: `unsupported encoding "${encoding}" (use one of: ${[...RAW_ENCODINGS].join(', ')})` };
    }
    if (!enc) {
      for (let i = 0; i < value.length; i += 1) {
        if (value.charCodeAt(i) > 255) {
          return { error: 'string contains characters above 0xFF; send bytes, or pass an encoding such as "utf8"/"base64"/"hex"' };
        }
      }
      enc = 'latin1';
    }
    if (enc === 'hex' && (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value))) {
      return { error: 'invalid hex string (needs an even number of 0-9a-f characters)' };
    }
    if (enc === 'base64' && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(value)) {
      return { error: 'invalid base64 string' };
    }
    buf = Buffer.from(value, enc);
  } else {
    return { error: `unsupported data type "${typeof value}" (send bytes, a number array, or a string)` };
  }

  if (buf.length === 0) return { error: 'no data to print (0 bytes)' };
  if (buf.length > MAX_RAW_BYTES) return { error: `raw job is ${buf.length} bytes; the limit is ${MAX_RAW_BYTES}` };
  return { buffer: buf };
}

async function printRawSilentJob(data, ...rest) {
  try {
    let value = data;
    let encoding;
    let explicitName;
    let type;

    const isOptionsObject =
      !!data && typeof data === 'object' && !Buffer.isBuffer(data) && !ArrayBuffer.isView(data) &&
      !(data instanceof ArrayBuffer) && !Array.isArray(data) && !isJsonBuffer(data);

    if (isOptionsObject) {
      const dataKey = RAW_DATA_KEYS.find((k) => data[k] !== undefined);
      value = dataKey ? data[dataKey] : undefined;
      encoding = data.encoding;
      explicitName = RAW_PRINTER_NAME_KEYS.map((k) => data[k]).find((v) => v !== undefined && v !== null && v !== '');
      type = data.type || data.station;
    } else if (typeof rest[0] === 'string') {
      explicitName = rest[0];
    }

    const converted = toRawBuffer(value, encoding);
    if (converted.error) {
      const error = `print-raw-silent: ${converted.error}`;
      console.error(error);
      return { success: false, error };
    }

    const target = resolveStationTarget(explicitName, type);
    if (target.error) {
      console.error(`print-raw-silent routing failed: ${target.error}`);
      return { success: false, error: target.error };
    }

    const { matched, available } = await resolvePrinterName(target.name);
    if (!matched) {
      const error = `Target printer "${target.name}" not found or offline. Raw print rejected to prevent misrouting. Available: ${available.join(', ') || '(none detected)'}`;
      console.error(`print-raw-silent routing failed: ${error}`);
      return { success: false, error };
    }

    console.log(`[Electron Print] print-raw-silent — printer "${matched}", ${converted.buffer.length} bytes`);
    const result = await sendRawToPrinter(matched, converted.buffer);
    if (!result.success) {
      const error = `Raw print to "${matched}" failed: ${result.error}`;
      console.error(`print-raw-silent: ${error}`);
      return { success: false, error };
    }
    return { success: true, error: null, printer: matched, bytes: result.bytes };
  } catch (err) {
    console.error('print-raw-silent: unexpected error:', err);
    return { success: false, error: err.message };
  }
}

ipcMain.handle('print-raw-silent', (event, data, ...rest) => printRawSilentJob(data, ...rest));

// Kiosk toggle for touch terminals (same effect as the Escape/F11 shortcut)
ipcMain.handle('toggle-kiosk', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const next = !mainWindow.isKiosk();
  mainWindow.setKiosk(next);
  return next;
});

ipcMain.handle('is-kiosk', () => {
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isKiosk();
});

// Touch-friendly window controls (same effect as the existing Ctrl+M / Ctrl+Q shortcuts)
ipcMain.handle('minimize-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
});

// Toggles maximize/restore and returns the resulting state. No-op while in
// kiosk mode — kiosk is already full-screen, and maximize() fights with it.
ipcMain.handle('maximize-window', () => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isKiosk()) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return mainWindow.isMaximized();
});

ipcMain.handle('close-window', () => {
  app.quit();
});

// ============================================================
// LEGACY PRINT CHANNELS (kept for backward compatibility)
// ============================================================

// 1. CASHIER BILL SILENT PRINT
// NOTE: no fallback to the OS default printer on failure — this project's
// standing rule (see resolvePrinterName's comment below) is that a printer
// mismatch/failure must fail loudly rather than risk cross-printing a
// receipt onto whatever printer happens to be set as Windows default.
ipcMain.on('print-receipt', async (event, options = {}) => {
  // This channel always targets the CASHIER station (it does not read any
  // printer-name field from options) — logged explicitly so this is visible
  // on every call, not just inferred from behavior. The name comes from the
  // shared station mapping, so a saved hardware config applies here too
  // (this is the channel window.print() is routed to).
  const cashierPrinter = DEFAULT_DEVICE_NAMES.cashier;
  console.log(`[Electron Print] print-receipt (legacy, cashier station) — deviceName: ${cashierPrinter}`);
  const isSilent = options.silent !== undefined ? options.silent : true;

  // Same resolve-before-print standard as the two main handlers below — this
  // just turns a would-be generic native print failure into a clear,
  // actionable log line before we even try.
  const { matched, available } = await resolvePrinterName(cashierPrinter);
  if (!matched) {
    console.error(`print-receipt: ${cashierPrinter} not found. Available: ${available.join(', ') || '(none detected)'}`);
    return;
  }

  mainWindow.webContents.print({
    silent: isSilent,
    printBackground: true,
    deviceName: matched
  }, (success, failureReason) => {
    if (!success) {
      console.error('CashierPrinter print failed (no default-printer fallback):', failureReason);
    }
  });
});

// 2. KITCHEN KOT AUTO-PRINT
ipcMain.on('print-kot', async (event, kotHtml) => {
  const kitchenPrinter = DEFAULT_DEVICE_NAMES.kitchen;
  console.log(`[Electron Print] print-kot (legacy, kitchen station) — deviceName: ${kitchenPrinter}`);
  const { matched, available } = await resolvePrinterName(kitchenPrinter);
  if (!matched) {
    console.error(`print-kot: ${kitchenPrinter} not found. Available: ${available.join(', ') || '(none detected)'}`);
    return;
  }

  let workerWindow = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false }
  });

  workerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURI(kotHtml)}`);

  workerWindow.webContents.on('did-finish-load', () => {
    workerWindow.webContents.print({
      silent: true,
      deviceName: matched
    }, (success, errorType) => {
      if (!success) console.error('Kitchen Print Error:', errorType);
      workerWindow.close();
    });
  });
});

// 3. BARCODE STICKER LABEL AUTO-PRINT
ipcMain.on('print-barcode', async (event, barcodeHtml) => {
  const barcodePrinter = DEFAULT_DEVICE_NAMES.barcode;
  console.log(`[Electron Print] print-barcode (legacy, barcode station) — deviceName: ${barcodePrinter}`);
  const { matched, available } = await resolvePrinterName(barcodePrinter);
  if (!matched) {
    console.error(`print-barcode: ${barcodePrinter} not found. Available: ${available.join(', ') || '(none detected)'}`);
    return;
  }

  let workerWindow = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false }
  });

  workerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURI(barcodeHtml)}`);

  workerWindow.webContents.on('did-finish-load', () => {
    workerWindow.webContents.print({
      silent: true,
      deviceName: matched
    }, (success, errorType) => {
      if (!success) console.error('Barcode Print Error:', errorType);
      workerWindow.close();
    });
  });
});

// ============================================================
// NEW UNIFIED SILENT PRINT PIPELINE (print-silent-job)
// ============================================================

// Station -> Windows printer queue name. FACTORY_DEVICE_NAMES is what a fresh
// install uses. DEFAULT_DEVICE_NAMES is the LIVE mapping every print handler
// reads at call time — applyPrinterMapping() (see the hardware-config section
// below) overwrites its entries in place from the persisted config, so a
// saved selection takes effect everywhere without touching each call site.
const FACTORY_DEVICE_NAMES = Object.freeze({
  cashier: 'CashierPrinter',
  kitchen: 'KitchenPrinter',
  kot: 'KitchenPrinter',
  bot: 'BotPrinter',
  bar: 'BarPrinter',
  barcode: 'BarcodePrinter'
});
const DEFAULT_DEVICE_NAMES = { ...FACTORY_DEVICE_NAMES };

const DEFAULT_PAPER_WIDTH_MM = 80;
const DEFAULT_CONTINUOUS_HEIGHT_MICRONS = 300000; // 300mm virtual roll height
// Sized for up to two sequential print() attempts (custom pageSize, then a
// same-device retry with the driver's default page size on failure) — a
// single-attempt budget here would risk this watchdog killing the window
// mid-retry on a slow/unresponsive printer.
const PRINT_TIMEOUT_MS = 25000;

// Resolves a requested printer name against the OS's actual installed
// printers: case-insensitive, whitespace-trimmed EXACT match only.
//
// Deliberately NO partial/"contains" matching. This app routes KOT/BOT/label/
// cashier jobs to physically different printers, and the four station names
// in play here collide under substring matching — e.g. a BOT job configured
// for "Bar" would silently match a "Barcode Printer" queue the moment the
// real Bar/BOT printer is missing, misrouted, or renamed. A confident wrong
// match is worse than a failed print job with a clear error, and this project
// already has a standing rule that a printer mismatch must fail loudly rather
// than fall back/guess.
async function resolvePrinterName(requestedName) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { matched: requestedName || null, available: [] };
  }
  const printers = await mainWindow.webContents.getPrintersAsync();
  const available = printers.map((p) => p.name);
  if (!requestedName) return { matched: null, available };
  const cleanTarget = requestedName.trim().toLowerCase();
  const exact = printers.find((p) => p.name.trim().toLowerCase() === cleanTarget);
  return { matched: exact ? exact.name : null, available };
}

// Single rule for "which station's printer is this request for", shared by
// print-silent-job and print-raw-silent so they can't drift apart:
//   explicit printer name  -> used as given (still checked against the
//                             installed printers by the caller)
//   known station `type`   -> that station's printer (case/space-insensitive)
//   nothing given at all   -> the cashier printer (e.g. a generic test print)
//   a type that isn't a known station -> ERROR. It must never default to the
//   cashier: a caller that said 'kot' and got the cashier printer is exactly
//   how a kitchen ticket ends up on the wrong printer.
// Returns { name } or { error }. `type` comes from the web page, so lookup is
// by own property only ("constructor" must not resolve to a function).
function resolveStationTarget(explicitName, type) {
  if (explicitName !== undefined && explicitName !== null && explicitName !== '') {
    if (typeof explicitName !== 'string' || !explicitName.trim()) {
      return { error: 'Printer name must be a non-empty string.' };
    }
    return { name: explicitName };
  }
  const normalizedType = typeof type === 'string' ? type.trim().toLowerCase() : '';
  if (!normalizedType) return { name: DEFAULT_DEVICE_NAMES.cashier };
  if (Object.prototype.hasOwnProperty.call(DEFAULT_DEVICE_NAMES, normalizedType)) {
    return { name: DEFAULT_DEVICE_NAMES[normalizedType] };
  }
  return { error: `Unknown print type: "${type}". Known types: ${Object.keys(DEFAULT_DEVICE_NAMES).join(', ')}` };
}

// ============================================================
// PERSISTENT HARDWARE CONFIG + STARTUP HEALTH CHECK
// ============================================================
//
// What "reconnect" means here: printers are owned by the Windows spooler —
// this app never holds a connection to one, so there is nothing to
// re-establish. On startup it re-reads the saved selection, applies it to the
// live station mapping, and VERIFIES each saved printer is still installed
// and not offline/paused. If one isn't, a small toast is shown and the check
// is retried in the background (a USB printer often enumerates after the app
// starts), without ever blocking the POS. No test print is sent — that would
// waste paper on every launch.
//
// serialPorts / preferences are persisted and returned to the web app, but
// nothing here opens a serial port: there is no serial driver in this app
// (adding one means a native dependency), so there is nothing to reconnect.

const HARDWARE_STATIONS = Object.keys(FACTORY_DEVICE_NAMES);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HARDWARE_RECHECK_INTERVAL_MS = 15000;
const HARDWARE_RECHECK_MAX_ATTEMPTS = 20; // ~5 minutes, then stop polling

// Windows PrinterStatus values (Get-Printer) that mean "installed but not
// usable right now". Busy/Printing/Processing/Waiting/WarmingUp/TonerLow/etc.
// are deliberately not here — those are normal operating states.
const PRINTER_PROBLEM_STATUSES = new Set([
  'paused', 'error', 'pendingdeletion', 'paperjam', 'paperout', 'paperproblem',
  'offline', 'notavailable', 'outputbinfull', 'notoner', 'userintervention',
  'outofmemory', 'dooropen', 'serverunknown'
]);

let hardwareStore = null;
let lastHardwareStatus = null;
let lastAnnouncedSignature = '';
let hardwareRecheckTimer = null;

function initHardwareStore() {
  try {
    hardwareStore = new Store({
      name: 'hardware-config',
      clearInvalidConfig: true, // a corrupted file resets to defaults instead of throwing at startup
      defaults: { printers: {}, serialPorts: {}, preferences: {} }
    });
  } catch (err) {
    hardwareStore = null;
    console.error('[Hardware] could not open the config store — using factory defaults, nothing will be persisted:', err);
  }
}

function readHardwareConfig() {
  const empty = { printers: {}, serialPorts: {}, preferences: {} };
  if (!hardwareStore) return empty;
  try {
    return {
      printers: hardwareStore.get('printers') || {},
      serialPorts: hardwareStore.get('serialPorts') || {},
      preferences: hardwareStore.get('preferences') || {}
    };
  } catch (err) {
    console.error('[Hardware] could not read saved config — using factory defaults:', err);
    return empty;
  }
}

// station -> printer name. Unknown stations and non-string/empty/oversized
// names are dropped; null means "clear this station's saved selection".
function sanitizePrinters(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [station, name] of Object.entries(input)) {
    const key = String(station).trim().toLowerCase();
    if (!HARDWARE_STATIONS.includes(key)) continue;
    if (name === null) { out[key] = null; continue; }
    if (typeof name !== 'string') continue;
    const trimmed = name.trim();
    if (trimmed && trimmed.length <= 200) out[key] = trimmed;
  }
  return out;
}

// Free-form settings (serial ports, preferences): plain objects of
// strings/numbers/booleans only, bounded depth and size.
function sanitizePlain(input, depth = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 3) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(input).slice(0, 50)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (v && typeof v === 'object') {
      const nested = sanitizePlain(v, depth + 1);
      if (nested) out[k] = nested;
    }
  }
  return out;
}

// Overlays the saved printer selection onto the live station mapping.
function applyPrinterMapping() {
  const saved = readHardwareConfig().printers;
  const merged = { ...FACTORY_DEVICE_NAMES };
  for (const station of HARDWARE_STATIONS) {
    if (typeof saved[station] === 'string' && saved[station]) merged[station] = saved[station];
  }
  // 'kot' is an alias of 'kitchen' unless it was saved explicitly.
  if (!saved.kot && saved.kitchen) merged.kot = merged.kitchen;
  Object.assign(DEFAULT_DEVICE_NAMES, merged);
}

// One call, no user input in the command. Resolves null (never rejects) if
// PowerShell/Get-Printer is unavailable, so callers fall back to presence-only.
function queryWindowsPrinterStates() {
  const command =
    "Get-Printer | Select-Object Name,@{n='Status';e={[string]$_.PrinterStatus}},WorkOffline | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.warn('[Hardware] Get-Printer unavailable, checking presence only:', err.message);
          resolve(null);
          return;
        }
        try {
          const text = String(stdout).trim();
          const states = new Map();
          if (text) {
            const parsed = JSON.parse(text);
            for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
              if (row && typeof row.Name === 'string') {
                states.set(row.Name.trim().toLowerCase(), {
                  status: String(row.Status || ''),
                  workOffline: row.WorkOffline === true
                });
              }
            }
          }
          resolve(states);
        } catch (parseErr) {
          console.warn('[Hardware] could not parse Get-Printer output, checking presence only:', parseErr.message);
          resolve(null);
        }
      }
    );
  });
}

// Verifies every SAVED station printer. Stations with nothing saved are not
// checked — a site that never configured a bar printer shouldn't get a
// warning about it. Never throws.
async function checkHardware() {
  const saved = readHardwareConfig().printers;
  const stations = Object.keys(saved).filter((s) => typeof saved[s] === 'string' && saved[s]);
  const result = { checkedAt: new Date().toISOString(), ok: true, printers: [], problems: [], error: null };

  if (stations.length === 0) {
    lastHardwareStatus = result;
    return result;
  }

  let installed;
  try {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('main window not available');
    installed = await mainWindow.webContents.getPrintersAsync();
  } catch (err) {
    result.ok = false;
    result.error = `could not list installed printers: ${err.message}`;
    lastHardwareStatus = result;
    return result;
  }

  const installedNames = new Set(installed.map((p) => p.name.trim().toLowerCase()));
  const states = await queryWindowsPrinterStates();

  for (const station of stations) {
    const wanted = saved[station];
    const key = wanted.trim().toLowerCase();
    const entry = { station, printerName: wanted, state: 'ready', reason: null };

    if (!installedNames.has(key)) {
      entry.state = 'missing';
      entry.reason = 'not installed in Windows';
    } else if (states) {
      const s = states.get(key);
      if (s && (s.workOffline || PRINTER_PROBLEM_STATUSES.has(s.status.toLowerCase()))) {
        entry.state = 'attention';
        entry.reason = s.workOffline ? 'set to "Use Printer Offline"' : `Windows reports "${s.status}"`;
      }
    }
    result.printers.push(entry);
  }

  result.problems = result.printers.filter((e) => e.state !== 'ready');
  result.ok = result.problems.length === 0;
  lastHardwareStatus = result;
  return result;
}

function describeHardwareProblems(problems) {
  const byPrinter = new Map();
  for (const p of problems) {
    const group = byPrinter.get(p.printerName) || { stations: [], reason: p.reason };
    group.stations.push(p.station);
    byPrinter.set(p.printerName, group);
  }
  const parts = [...byPrinter.entries()].map(
    ([name, g]) => `"${name}" (${g.stations.join('/')}) — ${g.reason}`
  );
  return `Saved printer unavailable: ${parts.join('; ')}. Prints to it will be rejected until it is back; everything else keeps working.`;
}

// Subtle bottom-left toast rendered inside the POS page (a native Windows
// toast is unreliable over a kiosk full-screen window). Message text is set
// with textContent and passed through JSON.stringify, so a printer name can't
// inject markup or script.
function showHardwareToast(message, level) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const background = level === 'ok' ? '#1b5e20' : '#7a4b00';
  const script = `
    (function () {
      var id = '__hw_toast__';
      var old = document.getElementById(id);
      if (old) old.remove();
      if (!document.body) return;
      var el = document.createElement('div');
      el.id = id;
      el.setAttribute('role', 'status');
      el.textContent = ${JSON.stringify(message)};
      el.style.cssText = 'position:fixed;left:16px;bottom:16px;max-width:380px;padding:10px 14px;' +
        'border-radius:8px;font:13px/1.4 system-ui,sans-serif;color:#fff;background:' + ${JSON.stringify(background)} + ';' +
        'box-shadow:0 2px 10px rgba(0,0,0,.35);z-index:2147483645;opacity:0;transition:opacity .25s;cursor:pointer';
      el.addEventListener('click', function () { el.remove(); });
      document.body.appendChild(el);
      requestAnimationFrame(function () { el.style.opacity = '0.95'; });
      setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 300);
      }, 10000);
    })();
    true;
  `;
  mainWindow.webContents.executeJavaScript(script).catch((err) => {
    console.error('[Hardware] could not show notification:', err);
  });
}

// Notifies only when the set of problems CHANGES (or clears), so the retry
// loop doesn't re-toast the same problem every 15 seconds.
function announceHardwareStatus(status) {
  if (status.error) {
    console.warn(`[Hardware] ${status.error}`);
    return;
  }
  const signature = status.problems.map((p) => `${p.printerName}|${p.state}|${p.reason}`).sort().join(';');
  if (signature === lastAnnouncedSignature) return;
  const hadProblems = lastAnnouncedSignature !== '';
  lastAnnouncedSignature = signature;

  if (!status.ok) {
    const message = describeHardwareProblems(status.problems);
    console.warn(`[Hardware] ${message}`);
    showHardwareToast(message, 'warn');
  } else if (hadProblems) {
    console.log('[Hardware] all saved printers are available again');
    showHardwareToast('Saved printers are all available again.', 'ok');
  }
}

function stopHardwareRecheck() {
  if (hardwareRecheckTimer) {
    clearTimeout(hardwareRecheckTimer);
    hardwareRecheckTimer = null;
  }
}

// Bounded background retry while something saved is unavailable.
function scheduleHardwareRecheck() {
  if (hardwareRecheckTimer) return;
  let attempts = 0;
  const tick = async () => {
    hardwareRecheckTimer = null;
    attempts += 1;
    try {
      const status = await checkHardware();
      announceHardwareStatus(status);
      if (status.ok) return;
    } catch (err) {
      console.error('[Hardware] background re-check failed (POS continues):', err);
    }
    if (attempts >= HARDWARE_RECHECK_MAX_ATTEMPTS) {
      console.warn('[Hardware] still unavailable after repeated re-checks; no longer polling. Use check-hardware to re-test.');
      return;
    }
    hardwareRecheckTimer = setTimeout(tick, HARDWARE_RECHECK_INTERVAL_MS);
    if (hardwareRecheckTimer.unref) hardwareRecheckTimer.unref();
  };
  hardwareRecheckTimer = setTimeout(tick, HARDWARE_RECHECK_INTERVAL_MS);
  if (hardwareRecheckTimer.unref) hardwareRecheckTimer.unref();
}

async function checkAndAnnounceHardware() {
  const status = await checkHardware();
  announceHardwareStatus(status);
  if (status.ok) stopHardwareRecheck();
  else if (!status.error) scheduleHardwareRecheck();
  return status;
}

async function runStartupHardwareCheck() {
  try {
    await checkAndAnnounceHardware();
  } catch (err) {
    console.error('[Hardware] startup check failed (POS continues):', err);
  }
}

ipcMain.handle('get-hardware-config', () => ({
  ...readHardwareConfig(),
  effectivePrinters: { ...DEFAULT_DEVICE_NAMES },
  persisted: !!hardwareStore
}));

// partial = { printers?, serialPorts?, preferences? }
//   printers      merged per station; a station set to null is cleared
//   serialPorts   replaces the whole saved object
//   preferences   replaces the whole saved object
// A printer that isn't installed right now is still saved (it may simply be
// switched off) — the returned status says so.
ipcMain.handle('save-hardware-config', async (event, partial) => {
  if (!hardwareStore) {
    return { success: false, error: 'Hardware config storage is unavailable, so settings cannot be saved.' };
  }
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    return { success: false, error: 'Expected an object like { printers, serialPorts, preferences }.' };
  }
  try {
    if ('printers' in partial) {
      const next = { ...readHardwareConfig().printers };
      for (const [station, name] of Object.entries(sanitizePrinters(partial.printers))) {
        if (name === null) delete next[station];
        else next[station] = name;
      }
      hardwareStore.set('printers', next);
    }
    if ('serialPorts' in partial) {
      const serialPorts = sanitizePlain(partial.serialPorts);
      if (serialPorts) hardwareStore.set('serialPorts', serialPorts);
    }
    if ('preferences' in partial) {
      const preferences = sanitizePlain(partial.preferences);
      if (preferences) hardwareStore.set('preferences', preferences);
    }
    applyPrinterMapping();
    const status = await checkAndAnnounceHardware();
    return { success: true, config: { ...readHardwareConfig(), effectivePrinters: { ...DEFAULT_DEVICE_NAMES } }, status };
  } catch (err) {
    console.error('[Hardware] save failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('check-hardware', async () => {
  try {
    return await checkAndAnnounceHardware();
  } catch (err) {
    return { ok: false, error: err.message, printers: [], problems: [] };
  }
});

// Physical printable head is narrower than nominal paper width on thermal
// rolls — industry-standard figures (also used elsewhere in this file):
// 80mm paper -> 72mm head (576 dots @ 203dpi), 58mm paper -> 48mm head
// (384 dots @ 203dpi). An explicit non-standard width is trusted as-is, since
// that represents deliberate custom hardware, not one of these two defaults.
function getPrintableWidthMm(nominalWidthMm) {
  if (nominalWidthMm === 80) return 72;
  if (nominalWidthMm === 58) return 48;
  return nominalWidthMm;
}

function buildPrintDocument(htmlContent, nominalWidthMm, paperHeightMm) {
  const pageHeight = paperHeightMm ? `${paperHeightMm}mm` : 'auto';

  // Base reset only — the actual width containment (and the zoom that
  // compensates for any genuinely fixed-pixel content) is applied after load
  // via insertCSS/setZoomFactor in printSilentJob, same as print-receipt-silent.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {
    size: ${nominalWidthMm}mm ${pageHeight};
    margin: 0;
  }
  * { box-sizing: border-box; }
  html, body {
    width: 100%;
    margin: 0;
    padding: 0;
    font-family: monospace;
    -webkit-print-color-adjust: exact;
  }
</style>
</head>
<body>
${htmlContent}
</body>
</html>`;
}

/**
 * Renders htmlContent in a headless window and prints it silently.
 * Always resolves (never rejects) with { success, error } and guarantees
 * the temporary window is destroyed exactly once.
 */
async function printSilentJob({ type, htmlContent, settings = {} } = {}) {
  const paperWidthMm = settings.paperWidthMm || DEFAULT_PAPER_WIDTH_MM;
  const paperHeightMm = settings.paperHeightMm || null;
  const printableWidthMm = getPrintableWidthMm(paperWidthMm);

  const widthMicrons = printableWidthMm * 1000;
  const heightMicrons = paperHeightMm
    ? paperHeightMm * 1000
    : DEFAULT_CONTINUOUS_HEIGHT_MICRONS;

  // settings.deviceName is the documented/preferred key; the rest are
  // defensive fallbacks in case a caller uses a different property name for
  // the same thing (e.g. a "printerName" written straight onto settings
  // instead of nested correctly) — all still funnel through the same
  // resolvePrinterName exact-match check below, so a wrong guess here just
  // fails with a clear "Printer not found" error, never a silent misroute.
  // Explicit name > known station type > (nothing given) cashier; an unknown
  // type is an error, never a silent cashier default — see resolveStationTarget.
  const target = resolveStationTarget(
    settings.deviceName || settings.printerName || settings.printer || settings.device || settings.name,
    type
  );
  if (target.error) {
    console.error(`Print job routing failed: ${target.error}`);
    return { success: false, error: target.error };
  }
  const requestedDeviceName = target.name;

  console.log(`[Electron Print] print-silent-job — type: "${type}", requested deviceName: "${requestedDeviceName}"`);

  // Fail fast, before spinning up a headless window, on an unresolvable
  // printer name — see resolvePrinterName's own comment for why this is an
  // exact match only, not a "contains" guess.
  const { matched: deviceName, available } = await resolvePrinterName(requestedDeviceName);
  if (!deviceName) {
    const error = `Target printer "${requestedDeviceName}" not found or offline. Print rejected to prevent misrouting. Available: ${available.join(', ') || '(none detected)'}`;
    console.error(`Print job routing failed (type: ${type}): ${error}`);
    return { success: false, error };
  }

  console.log(`[Electron Print] print-silent-job — resolved deviceName: "${deviceName}"`);

  return new Promise((resolve) => {
    const fullHtml = buildPrintDocument(htmlContent || '', paperWidthMm, paperHeightMm);

    // Explicit narrow viewport matching the printable head — without this,
    // Chromium lays the DOM out against its default 800px-wide window, and
    // the pageSize above then stretches or shrinks that mismatched layout
    // onto the actual physical page.
    //
    // UNIT NOTE: BrowserWindow width/height are CSS/device-independent
    // pixels (96 per inch), NOT thermal printer dots (203 per inch) — an
    // earlier version of this line used *203, which made the actual viewport
    // roughly double the real printable width (same bug print-receipt-silent
    // had further up in this file, fixed the same way there).
    const targetWidthPx = Math.round((printableWidthMm / 25.4) * 96);

    let win = new BrowserWindow({
      show: false,
      width: targetWidthPx,
      height: 1200,
      useContentSize: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let settled = false;
    let safetyTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;

      if (safetyTimer) clearTimeout(safetyTimer);
      resolve(result);

      if (win && !win.isDestroyed()) {
        win.destroy();
      }
      win = null;
    };

    // Guarantees the window is never leaked if load/print never fires
    safetyTimer = setTimeout(() => {
      console.error(`Print job timed out (type: ${type}, device: ${deviceName})`);
      finish({ success: false, error: 'print-timeout' });
    }, PRINT_TIMEOUT_MS);

    win.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
      console.error(`Print job load failed (type: ${type}):`, errorDescription);
      finish({ success: false, error: errorDescription || `load-failed-${errorCode}` });
    });

    win.webContents.once('did-finish-load', async () => {
      // Reset to 1.0: no hardware result or diagnostic log came back on the
      // 0.85 attempt, and this round switches the shrink mechanism to a CSS
      // transform on <html> instead (see insertCSS below) — same reasoning
      // as print-receipt-silent's equivalent comment.
      const zoomFactor = 1.0;
      win.webContents.setZoomFactor(zoomFactor);

      // Same transform-based shrink as print-receipt-silent, switched to a
      // center-anchored scale for symmetric margins — see that handler's
      // comment for the full reasoning. Not applied to barcode jobs, which
      // have their own exact physical dimensions. Case-insensitive, same
      // reasoning as the station-name lookup above (a caller could send
      // 'Barcode'/'BARCODE' just as easily as 'kot' vs 'kitchen').
      const isBarcodeType = typeof type === 'string' && type.trim().toLowerCase() === 'barcode';
      await win.webContents.insertCSS(`
        ${isBarcodeType ? '' : `
        html {
          transform: scale(0.97) !important;
          transform-origin: top center !important;
          width: 100% !important;
        }
        `}
        body {
          margin: 0 !important;
          padding: 0 !important;
          box-sizing: border-box !important;
        }
        table {
          width: 100% !important;
          table-layout: fixed !important;
        }
      `);

      const baseOptions = {
        silent: true,
        printBackground: true,
        deviceName,
        landscape: false,
        margins: { marginType: 'none' }
      };

      // Diagnostic: after two rounds of substantial, different structural
      // fixes producing "identical" clipping on real hardware, this confirms
      // — on the NEXT test — whether this code path actually ran with the
      // values it's supposed to, rather than guessing again blind.
      console.log(
        `[print-silent-job] printing: type=${type} printer="${deviceName}" ` +
        `zoomFactor=${zoomFactor} targetWidthPx=${targetWidthPx} ` +
        `printableWidthMm=${printableWidthMm} pageSize=${widthMicrons}x${heightMicrons}um`
      );

      // Same same-device geometry retry as print-receipt-silent: some Windows
      // print drivers hard-reject a custom pageSize that isn't a registered
      // form/paper size on that printer. Retry once, same deviceName, using
      // the driver's own default page size instead of a different printer.
      win.webContents.print(
        { ...baseOptions, pageSize: { width: widthMicrons, height: heightMicrons } },
        (success, failureReason) => {
          if (success) {
            finish({ success: true, error: null });
            return;
          }

          console.error(
            `Print job with custom pageSize failed (type: ${type}, device: ${deviceName}):`,
            failureReason,
            '— retrying with the driver\'s own default page size (same device).'
          );

          win.webContents.print(baseOptions, (success2, failureReason2) => {
            if (success2) {
              console.warn(
                `Print job (type: ${type}, device: ${deviceName}) succeeded only WITHOUT the custom ` +
                'pageSize — output size may not exactly match the intended paper width.'
              );
              finish({ success: true, error: null });
              return;
            }

            console.error(`Print job also failed with default page size (type: ${type}, device: ${deviceName}):`, failureReason2);
            finish({
              success: false,
              error: `Print failed both with a custom page size (${failureReason}) and the driver's default page size (${failureReason2}).`
            });
          });
        }
      );
    });

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
  });
}

ipcMain.handle('print-silent-job', async (event, data) => {
  try {
    return await printSilentJob(data || {});
  } catch (err) {
    console.error('Unexpected error in print-silent-job:', err);
    return { success: false, error: err.message };
  }
});

// ============================================================
// MULTI-TARGET SILENT PRINT ENGINE (print-receipt-silent)
// Dynamic role routing + physical thermal-head safe scaling via zoom
// (not global CSS shrink) + label printing support.
// ============================================================

async function printReceiptSilentJob(payload, ...args) {
  console.log('[IPC RAW ARGS]', payload, ...args);
  let printWin = null;
  try {
    let html = '';
    let printerName = '';
    let paperWidth = '80mm';
    let isLabel = false;
    let customHeight = 297000;

    if (typeof payload === 'object' && payload !== null) {
      html = payload.html || payload.htmlContent || '';
      // printerName/targetPrinter are the documented/preferred keys; the rest
      // are defensive fallbacks for an alternate property name. If NONE of
      // them are present at all, default to the cashier printer — same
      // app-level "no target specified" default printSilentJob already uses
      // (DEFAULT_DEVICE_NAMES[type] || DEFAULT_DEVICE_NAMES.cashier). This is
      // NOT a retry against whatever Windows' OS default queue is; it still
      // funnels through resolvePrinterName's exact-match check below, so if
      // "CashierPrinter" itself isn't actually installed, this still fails
      // loudly rather than guessing further — see resolvePrinterName's own
      // comment for that policy.
      printerName = payload.printerName || payload.targetPrinter || payload.printer || payload.name || payload.device || DEFAULT_DEVICE_NAMES.cashier;
      paperWidth = payload.paperWidth || '80mm';
      isLabel = !!payload.isLabel;
      if (payload.customHeightMicrons) customHeight = payload.customHeightMicrons;
    } else {
      // A bare string payload (the Hardware Setup Test Print button calls it
      // this way — just the HTML, no printer specified, zero extra args) also
      // defaults to the cashier printer rather than resolving to "".
      html = payload || '';
      printerName = args[0] || DEFAULT_DEVICE_NAMES.cashier;
      paperWidth = args[1] || '80mm';
    }

    if (!html || !html.trim()) {
      html = '<div style="font-family:monospace;font-size:12px;text-align:center;padding:10px;">TEST PRINT SUCCESSFUL</div>';
    }

    console.log(`[Electron Print] print-receipt-silent — requested deviceName: "${printerName}"`);

    // Fail fast, before spinning up a headless window, on an unresolvable
    // printer name — see resolvePrinterName's own comment for why this is an
    // exact match only, not a "contains" guess.
    const requestedPrinterName = printerName;
    const printerResolution = await resolvePrinterName(requestedPrinterName);
    printerName = printerResolution.matched;
    if (!printerName) {
      const error = `Target printer "${requestedPrinterName}" not found or offline. Print rejected to prevent misrouting. Available: ${printerResolution.available.join(', ') || '(none detected)'}`;
      console.error(`print-receipt-silent routing failed: ${error}`);
      return { success: false, error };
    }

    console.log(`[Electron Print] print-receipt-silent — resolved deviceName: "${printerName}"`);

    // Reset to 1.0: no hardware result or diagnostic log came back on the
    // 0.85 attempt, and this round switches the shrink mechanism to a CSS
    // transform on <html> instead (see insertCSS below). Running both at
    // once would make it impossible to tell which one actually did anything
    // if the next test is inconclusive again — this keeps the test isolated.
    let zoomFactor = 1.0;
    // 72mm, not 80mm: the confirmed physical printable head on an "80mm" roll
    // is 72mm (576 dots @ 203dpi — this is also the standard Epson TM-T88-class
    // spec). Using the full 80mm nominal paper width here — while the window's
    // viewport below is laid out at the narrower 72mm-equivalent pixel width —
    // is what caused Chromium to stretch the 72mm layout to fill an 80mm page,
    // pushing the right edge ~8mm past the actual print head and clipping the
    // AMOUNT/INVOICE columns. Keep these two numbers in the same physical unit.
    let widthMicrons = 72000;

    if (paperWidth === '58mm') {
      // Standard spec: 58mm paper, ~48mm printable head, 384 dots @ 203dpi —
      // matches targetWidthPx below for the same reason as the 72mm case above.
      widthMicrons = 48000;
    } else if (isLabel) {
      widthMicrons = (payload && payload.labelWidthMicrons) || 50000;
      customHeight = (payload && payload.labelHeightMicrons) || 30000;
    }

    const printableWidthMm = widthMicrons / 1000;

    // Explicit narrow viewport matching the printable head — without this,
    // Chromium lays the DOM out against its default 800px-wide window, and
    // payloads using screen-style percentage/fixed-pixel widths get laid out
    // at that width and then squeezed onto the physical page.
    //
    // IMPORTANT UNIT NOTE: BrowserWindow width/height are CSS/device-
    // independent pixels (96 per inch, the standard web reference unit) —
    // NOT thermal printer dots (203 per inch). An earlier version of this
    // code used 576/384, which are the correct DOT counts for 72mm/48mm at
    // 203dpi, but used them directly as a CSS-pixel BrowserWindow width —
    // making the actual viewport ~152mm/~102mm, roughly DOUBLE the real
    // printable width. That mismatch likely explains why the right edge kept
    // clipping identically across CSS-only fix attempts: the canvas itself
    // was never actually narrow. Converting properly at 96dpi here instead.
    const targetWidthPx = Math.round((printableWidthMm / 25.4) * 96);

    printWin = new BrowserWindow({
      show: false,
      width: targetWidthPx,
      height: 1200,
      useContentSize: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    printWin.webContents.setZoomFactor(zoomFactor);

    // CSS transform on <html> as the shrink mechanism — hardware-confirmed
    // this works. transform-origin switched from "top left" to "top center":
    // scaling from a corner always pushes ALL the freed-up blank space to one
    // side (asymmetric margins, by definition); scaling from the center
    // distributes it evenly on both sides, which is the correct tool for a
    // "balanced margins" goal regardless of which side was previously larger.
    // Also dropped the width:105.3% pre-widening (was compensating for the
    // corner-anchored scale eating into the page's own footprint) in favor
    // of a gentler 0.97 scale alone — if right-edge clipping reappears, this
    // combination (no pre-widening + a milder scale) is the first thing to
    // revisit, since the widening was giving fixed-pixel content extra
    // layout room independent of the final visual scale.
    // table-layout:fixed is kept — it stops a table growing past its column
    // hints to fit long cell content (e.g. an AMOUNT column), which is a
    // separate problem from overall page scale/centering.
    await printWin.webContents.insertCSS(`
      @page {
        margin: 0 !important;
        size: ${isLabel ? `${paperWidth} auto` : 'auto'} !important;
      }
      ${isLabel ? '' : `
      html {
        transform: scale(0.97) !important;
        transform-origin: top center !important;
        width: 100% !important;
      }
      `}
      body {
        margin: 0 !important;
        padding: 0 !important;
        box-sizing: border-box !important;
      }
      table {
        width: 100% !important;
        table-layout: fixed !important;
      }
    `);

    // Belt-and-braces: some receipt payloads hardcode inline pixel widths
    // (style="width:300px") or centering (margin:auto) that a stylesheet rule
    // can only beat with !important, and deeply-nested wrappers can sit past
    // the insertCSS selectors above. Force every element's inline style
    // directly, using setProperty(...,'important') — a plain assignment like
    // el.style.width = '92%' would lose to the !important CSS rules above.
    // EXCLUDES <html> itself: max-width clamps width regardless of !important
    // on either side (it's not a cascade conflict, it's how the box model
    // resolves the two together), so forcing max-width:100% on <html> would
    // silently cancel the deliberate width:100% rule above.
    await printWin.webContents.executeJavaScript(`
      (() => {
        document.querySelectorAll('*').forEach((el) => {
          if (el.style && el !== document.documentElement) {
            el.style.setProperty('max-width', '100%', 'important');
            el.style.setProperty('box-sizing', 'border-box', 'important');
            if (el.style.marginLeft === 'auto') el.style.marginLeft = '0px';
            if (el.style.marginRight === 'auto') el.style.marginRight = '0px';
          }
        });
      })();
    `);

    // NOTE: on a printerName mismatch this resolves { success: false } and does
    // NOT retry against the OS default printer — a wrong/typo'd deviceName must
    // fail loudly rather than silently route a job to the wrong physical printer.
    //
    // The retry below is a DIFFERENT thing: it never changes deviceName (always
    // the same already-resolved printerName), only the page geometry. Some
    // Windows print drivers reject an arbitrary custom pageSize outright — no
    // partial success, no auto-fit, just a hard failure with Chromium's generic
    // "Failed to print" — if that exact size isn't registered as a form/paper
    // size on that printer. Retrying once with the driver's own default page
    // size (still on the SAME device) trades exact 72mm/48mm sizing for the job
    // actually printing, rather than failing outright on a driver that can't
    // take a custom size at all.
    const printOnce = (options) => new Promise((res) => {
      printWin.webContents.print(options, (success, failureReason) => res({ success, failureReason }));
    });

    const baseOptions = {
      silent: true,
      printBackground: true,
      deviceName: printerName,
      margins: { marginType: 'none' }
    };

    // Diagnostic: after two rounds of substantial, different structural
    // fixes producing "identical" clipping on real hardware, this confirms
    // — on the NEXT test — whether this code path actually ran with the
    // values it's supposed to, rather than guessing again blind.
    console.log(
      `[print-receipt-silent] printing: printer="${printerName}" paperWidth=${paperWidth} ` +
      `isLabel=${isLabel} zoomFactor=${zoomFactor} targetWidthPx=${targetWidthPx} ` +
      `printableWidthMm=${printableWidthMm} pageSize=${widthMicrons}x${customHeight}um`
    );

    // scaleFactor stays 100 here deliberately — the actual size reduction is
    // already applied via zoomFactor above (webContents.setZoomFactor runs
    // before this print() call). print()'s own scaleFactor option is a
    // SEPARATE additional scale layered on top of whatever was rendered, so
    // setting both to 90 would compound to 0.9 x 0.9 = 0.81 (a 19% shrink),
    // not the intended 10%.
    const first = await printOnce({
      ...baseOptions,
      pageSize: { width: widthMicrons, height: customHeight },
      scaleFactor: 100
    });

    if (first.success) {
      return { success: true, error: null };
    }

    console.error(
      `Printing to ${printerName} with custom pageSize (${widthMicrons}x${customHeight} microns) failed:`,
      first.failureReason,
      '— retrying with the printer driver\'s own default page size (same device, no fallback printer).'
    );

    const second = await printOnce(baseOptions);

    if (second.success) {
      console.warn(
        `Printing to ${printerName} succeeded only WITHOUT the custom pageSize — this printer's ` +
        'Windows driver likely does not accept that custom page geometry, so its own configured ' +
        'default paper size was used. Output width/length may not exactly match the intended thermal roll.'
      );
      return { success: true, error: null };
    }

    console.error(`Printing to ${printerName} also failed with the driver's default page size:`, second.failureReason);
    return {
      success: false,
      error: `Print failed on ${printerName} both with a custom page size (${first.failureReason}) and with the driver's default page size (${second.failureReason}).`
    };
  } catch (err) {
    console.error('IPC silent print exception (print-receipt-silent):', err);
    return { success: false, error: err.message };
  } finally {
    // Guaranteed cleanup on every path: success, print failure, load failure, or thrown error.
    if (printWin && !printWin.isDestroyed()) {
      printWin.destroy();
    }
  }
}

ipcMain.handle('print-receipt-silent', (event, payload, ...args) => printReceiptSilentJob(payload, ...args));

// ============================================================
// UNIFIED ENTRY POINT (print-thermal) — window.electronAPI.printThermalReceipt
// ============================================================
//
// One call for "print this receipt silently, and open the drawer if asked":
// reuses the exact same pipeline as print-receipt-silent (so the web app's
// own bill HTML/CSS is what gets printed — no dialog, no re-templating) and
// the same drawer kick as open-cash-drawer. Nothing here is a second,
// divergent print path.
//
// Payload = same shape as print-receipt-silent, plus:
//   openDrawer?: boolean         kick the drawer after printing (default false —
//                                the caller knows whether it's a cash sale)
//   drawerPrinterName?: string   printer the drawer hangs off (default: the
//                                receipt's printerName, else CashierPrinter)
//
// The drawer is kicked even if the print itself failed: a cash sale still
// needs the drawer open, and blocking it on a receipt failure would stall
// the till. Both outcomes are reported separately.
ipcMain.handle('print-thermal', async (event, payload, ...args) => {
  const printResult = await printReceiptSilentJob(payload, ...args);

  const wantsDrawer = !!payload && typeof payload === 'object' && !!(payload.openDrawer || payload.kickDrawer);
  if (!wantsDrawer) return printResult;

  const drawerResult = await kickCashDrawer({
    deviceName: payload.drawerPrinterName || payload.printerName || payload.deviceName
  });

  return { ...printResult, drawer: drawerResult };
});

app.whenReady().then(() => {
  // Saved printer selection must be live before the first print request can
  // arrive; both steps are non-throwing (failures fall back to factory names).
  initHardwareStore();
  applyPrinterMapping();
  createWindow();

  // Deferred so it doesn't compete with the POS page loading and the startup
  // hardware check; harmless if raw printing is never used (idle PowerShell).
  const prewarm = setTimeout(prewarmRawWorker, 8000);
  if (prewarm.unref) prewarm.unref();

  // Auto-update (GitHub Releases). Required and started inside a try so that
  // any problem here can only switch updating off — never stop the POS from
  // launching. Checks run ~45s after launch and every 6h; nothing downloads or
  // restarts without the cashier tapping a button. See updater.js.
  try {
    const { createUpdater } = require('./updater');
    createUpdater({ getWindow: () => mainWindow }).start();
  } catch (err) {
    console.error('[Updater] could not start (the POS is unaffected, but updates are off):', err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
