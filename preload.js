const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Legacy handlers (kept for backward compatibility with existing POS code) ---
  printReceipt: (options) => ipcRenderer.send('print-receipt', options),
  printKOT: (kotHtml) => ipcRenderer.send('print-kot', kotHtml),
  printBarcode: (barcodeHtml) => ipcRenderer.send('print-barcode', barcodeHtml),

  // --- New unified silent print bridge ---
  // data: { type: 'cashier' | 'kitchen' | 'bot' | 'barcode', htmlContent: string,
  //         settings?: { deviceName?: string, paperWidthMm?: number, paperHeightMm?: number } }
  // Returns: Promise<{ success: boolean, error: string | null }>
  // On a printer-name mismatch this resolves { success: false, error } listing
  // the requested name and the actually-installed printers — it does not
  // guess via a partial/"contains" match or fall back to the OS default.
  sendPrintJob: (data) => ipcRenderer.invoke('print-silent-job', data),

  // --- Dynamic printer discovery ---
  // Returns: Promise<Array<{ name, displayName, isDefault, status }>>
  getPrinters: () => ipcRenderer.invoke('get-system-printers'),

  // --- Multi-target silent print engine (role routing + thermal safe-scaling) ---
  // payload: { html, printerName, paperWidth?: '80mm'|'58mm', isLabel?: boolean,
  //            labelWidthMicrons?, labelHeightMicrons?, customHeightMicrons? }
  // Returns: Promise<{ success: boolean, error: string | null }>
  // Same exact-match-only printer resolution as sendPrintJob above.
  printReceiptSilent: (payload) => ipcRenderer.invoke('print-receipt-silent', payload),

  // --- Kiosk window control (for touch terminals with no physical Esc/F11 key) ---
  // Both return Promise<boolean>: true = window is now/currently in kiosk mode.
  toggleKiosk: () => ipcRenderer.invoke('toggle-kiosk'),
  isKiosk: () => ipcRenderer.invoke('is-kiosk'),

  // --- Touch-friendly window controls (for terminals with no keyboard) ---
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window')
});
