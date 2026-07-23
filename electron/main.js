const { app, BrowserWindow, ipcMain, shell, clipboard, nativeTheme } = require('electron');
const path = require('path');
const { extractCredentials } = require('../src/core/parser');
const { probeEndpoint } = require('../src/core/probe');
const { chatTest } = require('../src/core/chat');
const { createProxyDispatcher, normalizeProxy } = require('../src/core/http');
const { detectSystemProxy } = require('../src/core/system-proxy');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0b0f14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '../src/index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('extract-credentials', async (_event, rawText) => {
  return extractCredentials(rawText || '');
});

ipcMain.handle('probe-endpoint', async (_event, payload) => {
  return probeEndpoint(payload || {});
});

ipcMain.handle('chat-test', async (_event, payload) => {
  try {
    return await chatTest(payload || {});
  } catch (err) {
    return { success: false, error: err.message || String(err), attempts: [] };
  }
});

ipcMain.handle('clipboard-write', async (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('detect-system-proxy', async () => {
  try {
    return detectSystemProxy();
  } catch (err) {
    return {
      proxy: '',
      source: 'error',
      enabled: false,
      note: err.message || String(err),
    };
  }
});

ipcMain.handle('test-proxy', async (_event, proxy) => {
  try {
    const { fetchWithProxy } = require('../src/core/http');
    const useProxy = normalizeProxy(proxy || '');
    const res = await fetchWithProxy('https://api.ipify.org?format=json', {
      proxy: useProxy,
      timeoutMs: 12000,
      headers: { Accept: 'application/json' },
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      body: body.slice(0, 500),
      proxy: useProxy || '(直连)',
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
    };
  }
});

void createProxyDispatcher;
