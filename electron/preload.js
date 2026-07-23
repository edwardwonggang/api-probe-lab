const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apiProbe', {
  extractCredentials: (rawText) => ipcRenderer.invoke('extract-credentials', rawText),
  probeEndpoint: (payload) => ipcRenderer.invoke('probe-endpoint', payload),
  chatTest: (payload) => ipcRenderer.invoke('chat-test', payload),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
  testProxy: (proxy) => ipcRenderer.invoke('test-proxy', proxy),
  detectSystemProxy: () => ipcRenderer.invoke('detect-system-proxy'),
  platform: process.platform,
});
