const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Legacy handlers (kept for backward compatibility with existing POS code) ---
  printReceipt: (options) => ipcRenderer.send('print-receipt', options),
  printKOT: (kotHtml) => ipcRenderer.send('print-kot', kotHtml),
  printBarcode: (barcodeHtml) => ipcRenderer.send('print-barcode', barcodeHtml),

  // --- New unified silent print bridge ---
  // data: { type: 'cashier' | 'kitchen' | 'kot' | 'bot' | 'bar' | 'barcode', htmlContent: string,
  //         settings?: { deviceName?: string, paperWidthMm?: number, paperHeightMm?: number } }
  // Returns: Promise<{ success: boolean, error: string | null }>
  // On a printer-name mismatch this resolves { success: false, error } listing
  // the requested name and the actually-installed printers — it does not
  // guess via a partial/"contains" match or fall back to the OS default.
  // print-silent-job's handler only reads a single `data` argument (no
  // positional-args support like printReceiptSilent below), so this stays
  // single-argument by design — call it as sendPrintJob({...}), one object.
  sendPrintJob: (data) => {
    console.log('[IPC RAW ARGS] sendPrintJob called with:', data);
    return ipcRenderer.invoke('print-silent-job', data);
  },

  // --- Dynamic printer discovery ---
  // Returns: Promise<Array<{ name, displayName, isDefault, status }>>
  getPrinters: () => ipcRenderer.invoke('get-system-printers'),

  // --- Quick diagnostic: just the printer names, for startup logging ---
  // Returns: Promise<string[]>
  getAvailablePrinters: () => ipcRenderer.invoke('get-available-printers'),

  // --- Multi-target silent print engine (role routing + thermal safe-scaling) ---
  // Accepts EITHER a single object payload:
  //   { html, printerName, paperWidth?: '80mm'|'58mm', isLabel?: boolean,
  //     labelWidthMicrons?, labelHeightMicrons?, customHeightMicrons? }
  // OR positional arguments: (html, printerName, paperWidth) — main.js's
  // handler supports both. THIS MUST STAY VARIADIC (...args), not a single
  // named parameter: an earlier version was `(payload) => invoke(..., payload)`,
  // which silently dropped every argument after the first — a frontend call
  // like printReceiptSilent(html, 'KitchenPrinter') had its printer name
  // discarded right here, before it ever reached main.js, which then fell
  // through to the CashierPrinter default. That was the actual root cause of
  // a KOT-always-prints-on-cashier bug — not a bug in main.js's routing logic
  // at all, which was reading the (already-empty) args correctly the whole time.
  // Returns: Promise<{ success: boolean, error: string | null }>
  // Same exact-match-only printer resolution as sendPrintJob above.
  printReceiptSilent: (...args) => {
    console.log('[IPC RAW ARGS] printReceiptSilent called with:', args);
    return ipcRenderer.invoke('print-receipt-silent', ...args);
  },

  // --- Unified silent print + optional drawer kick ---
  // Same payload as printReceiptSilent, plus { openDrawer?: boolean,
  // drawerPrinterName?: string }. Prints the web app's own receipt HTML with
  // no dialog, then kicks the drawer if openDrawer is true (drawer is kicked
  // even if the print fails, so a cash sale never stalls on a receipt error).
  // Returns: Promise<{ success: boolean, error: string | null,
  //                    drawer?: { success: boolean, error?: string } }>
  // Variadic for the same reason as printReceiptSilent above — never name a
  // single parameter here, or every argument after the first gets dropped.
  printThermalReceipt: (...args) => ipcRenderer.invoke('print-thermal', ...args),

  // --- Cash drawer kick (no printing, no paper feed) ---
  // payload?: { deviceName?: string, printerName?: string } — defaults to
  // the cashier printer. Returns: Promise<{ success: boolean, error: string | null }>
  // Same exact-match-only printer resolution as sendPrintJob above.
  openCashDrawer: (payload) => ipcRenderer.invoke('open-cash-drawer', payload),

  // --- Kiosk window control (for touch terminals with no physical Esc/F11 key) ---
  // Both return Promise<boolean>: true = window is now/currently in kiosk mode.
  toggleKiosk: () => ipcRenderer.invoke('toggle-kiosk'),
  isKiosk: () => ipcRenderer.invoke('is-kiosk'),

  // --- Touch-friendly window controls (for terminals with no keyboard) ---
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  // Toggles maximize/restore; resolves to the resulting isMaximized() state
  // (always false while in kiosk mode, where it's a no-op).
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window')
});
