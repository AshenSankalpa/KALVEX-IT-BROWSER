const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const POS_URL = 'https://virelpos.kalvexit.com';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    kiosk: true,              // Kiosk Full Screen Mode
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
ipcMain.on('print-receipt', (event, options = {}) => {
  const isSilent = options.silent !== undefined ? options.silent : true;

  mainWindow.webContents.print({
    silent: isSilent,
    printBackground: true,
    deviceName: 'CashierPrinter'
  }, (success, failureReason) => {
    if (!success) {
      console.error('CashierPrinter print failed (no default-printer fallback):', failureReason);
    }
  });
});

// 2. KITCHEN KOT AUTO-PRINT
ipcMain.on('print-kot', (event, kotHtml) => {
  let workerWindow = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false }
  });

  workerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURI(kotHtml)}`);

  workerWindow.webContents.on('did-finish-load', () => {
    workerWindow.webContents.print({
      silent: true,
      deviceName: 'KitchenPrinter'
    }, (success, errorType) => {
      if (!success) console.error('Kitchen Print Error:', errorType);
      workerWindow.close();
    });
  });
});

// 3. BARCODE STICKER LABEL AUTO-PRINT
ipcMain.on('print-barcode', (event, barcodeHtml) => {
  let workerWindow = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false }
  });

  workerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURI(barcodeHtml)}`);

  workerWindow.webContents.on('did-finish-load', () => {
    workerWindow.webContents.print({
      silent: true,
      deviceName: 'BarcodePrinter'
    }, (success, errorType) => {
      if (!success) console.error('Barcode Print Error:', errorType);
      workerWindow.close();
    });
  });
});

// ============================================================
// NEW UNIFIED SILENT PRINT PIPELINE (print-silent-job)
// ============================================================

const DEFAULT_DEVICE_NAMES = {
  cashier: 'CashierPrinter',
  kitchen: 'KitchenPrinter',
  bot: 'BarPrinter',
  barcode: 'BarcodePrinter'
};

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

function buildPrintDocument(htmlContent, paperWidthMm, paperHeightMm) {
  const pageHeight = paperHeightMm ? `${paperHeightMm}mm` : 'auto';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {
    size: ${paperWidthMm}mm ${pageHeight};
    margin: 0;
  }
  * { box-sizing: border-box; }
  html, body {
    width: ${paperWidthMm}mm;
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

  const widthMicrons = paperWidthMm * 1000;
  const heightMicrons = paperHeightMm
    ? paperHeightMm * 1000
    : DEFAULT_CONTINUOUS_HEIGHT_MICRONS;

  const requestedDeviceName =
    settings.deviceName ||
    DEFAULT_DEVICE_NAMES[type] ||
    DEFAULT_DEVICE_NAMES.cashier;

  // Fail fast, before spinning up a headless window, on an unresolvable
  // printer name — see resolvePrinterName's own comment for why this is an
  // exact match only, not a "contains" guess.
  const { matched: deviceName, available } = await resolvePrinterName(requestedDeviceName);
  if (!deviceName) {
    const error = `Printer not found: "${requestedDeviceName}". Available: ${available.join(', ') || '(none detected)'}`;
    console.error(`Print job routing failed (type: ${type}): ${error}`);
    return { success: false, error };
  }

  return new Promise((resolve) => {
    const fullHtml = buildPrintDocument(htmlContent || '', paperWidthMm, paperHeightMm);

    let win = new BrowserWindow({
      show: false,
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

    win.webContents.once('did-finish-load', () => {
      const baseOptions = {
        silent: true,
        printBackground: true,
        deviceName,
        landscape: false,
        margins: { marginType: 'none' }
      };

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

ipcMain.handle('print-receipt-silent', async (event, payload, ...args) => {
  let printWin = null;
  try {
    let html = '';
    let printerName = '';
    let paperWidth = '80mm';
    let isLabel = false;
    let customHeight = 297000;

    if (typeof payload === 'object' && payload !== null) {
      html = payload.html || payload.htmlContent || '';
      printerName = payload.printerName || payload.targetPrinter || '';
      paperWidth = payload.paperWidth || '80mm';
      isLabel = !!payload.isLabel;
      if (payload.customHeightMicrons) customHeight = payload.customHeightMicrons;
    } else {
      html = payload || '';
      printerName = args[0] || '';
      paperWidth = args[1] || '80mm';
    }

    if (!html || !html.trim()) {
      html = '<div style="font-family:monospace;font-size:12px;text-align:center;padding:10px;">TEST PRINT SUCCESSFUL</div>';
    }

    // Fail fast, before spinning up a headless window, on an unresolvable
    // printer name — see resolvePrinterName's own comment for why this is an
    // exact match only, not a "contains" guess.
    const requestedPrinterName = printerName;
    const printerResolution = await resolvePrinterName(requestedPrinterName);
    printerName = printerResolution.matched;
    if (!printerName) {
      const error = `Printer not found: "${requestedPrinterName}". Available: ${printerResolution.available.join(', ') || '(none detected)'}`;
      console.error(`print-receipt-silent routing failed: ${error}`);
      return { success: false, error };
    }

    // Zoom stays at 1.0 here: the widthMicrons values below already match the
    // physical printable head (not the nominal paper width), and the window's
    // own viewport (targetWidthPx) is laid out at that same physical size —
    // once the viewport and the page size agree, no compensating zoom is
    // needed, and adding one just reintroduces a scale mismatch.
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

    // Explicit thermal-head line-buffer pixel width (576px @ 80mm / 384px @ 58mm,
    // standard ESC/POS dot widths at 203dpi) as the window's own viewport —
    // without this, Chromium lays the DOM out against its default 800px-wide
    // viewport, and payloads that use screen-style percentage/fixed-pixel widths
    // (rather than proper @page print CSS) get laid out at that width and then
    // scaled DOWN to fit the physical page, which is what produced the shrunk,
    // centered-with-margins output on hardware despite the zoom/CSS changes.
    const targetWidthPx = paperWidth === '58mm' ? 384 : 576;

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

    // Strips Chromium's default print margins/centering so the zoomed content
    // occupies the full page width edge-to-edge rather than sitting centered
    // with blank side margins. Uses universal element selectors instead of
    // guessing the receipt payload's own class/id names, since those didn't
    // match the live DOM on hardware and left the width override a no-op.
    await printWin.webContents.insertCSS(`
      @page {
        margin: 0 !important;
        size: ${isLabel ? 'auto' : `${paperWidth} auto`} !important;
      }
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        box-sizing: border-box !important;
      }
      body > div, body > div > div, table {
        width: 100% !important;
        max-width: 100% !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        box-sizing: border-box !important;
      }
    `);

    // Belt-and-braces: some receipt payloads hardcode inline pixel widths
    // (style="width:300px") or centering (margin:auto) that a stylesheet rule
    // can only beat with !important, and deeply-nested wrappers can sit past
    // the insertCSS selectors above. Force every element's inline style directly.
    await printWin.webContents.executeJavaScript(`
      (() => {
        document.querySelectorAll('*').forEach((el) => {
          if (el.style) {
            el.style.maxWidth = '100%';
            el.style.boxSizing = 'border-box';
            if (el.style.marginLeft === 'auto') el.style.marginLeft = '0px';
            if (el.style.marginRight === 'auto') el.style.marginRight = '0px';
          }
        });

        document.documentElement.style.width = '100%';
        document.documentElement.style.margin = '0';
        document.documentElement.style.padding = '0';
        document.body.style.width = '100%';
        document.body.style.margin = '0';
        document.body.style.padding = '0';

        document.querySelectorAll('table').forEach((tbl) => {
          tbl.style.width = '100%';
          tbl.style.maxWidth = '100%';
        });

        // Fixed hardware-measured safety inset on the main print container
        // (69mm box + 3mm right padding, hard-capped with overflow:hidden) so a
        // font-metric or box-model rounding error can't push the last column
        // past the head, now that the viewport/pageSize width already match the
        // real 72mm/48mm printable area above. Deliberately NOT applied to
        // html/body themselves (left at 100% = the full page canvas) — doing
        // both would stack two insets (page-vs-box AND box-vs-padding) into an
        // unintended ~6mm+3mm margin, right back to the "too much blank space"
        // complaint from earlier hardware rounds.
        const printArea = document.querySelector('#receipt-root') ||
                           document.querySelector('.receipt-container') ||
                           document.querySelector('#receipt-print-area') ||
                           document.querySelector('.receipt-main-container') ||
                           document.querySelector('.print-content') ||
                           document.body.firstElementChild;

        if (printArea && printArea.style) {
          printArea.style.width = '69mm';
          printArea.style.maxWidth = '69mm';
          printArea.style.paddingRight = '3mm';
          printArea.style.marginLeft = '0px';
          printArea.style.marginRight = 'auto';
          printArea.style.boxSizing = 'border-box';
          printArea.style.overflow = 'hidden';
        }
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
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
