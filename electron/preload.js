const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apiProbe', {
  extractCredentials: (rawText) => ipcRenderer.invoke('extract-credentials', rawText),
  probeEndpoint: (payload) => ipcRenderer.invoke('probe-endpoint', payload),
  chatTest: (payload) => ipcRenderer.invoke('chat-test', payload),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
  testProxy: (proxy) => ipcRenderer.invoke('test-proxy', proxy),
  detectSystemProxy: () => ipcRenderer.invoke('detect-system-proxy'),
  platform: process.platform,

  streamChatStart: (payload) => {
    const requestId = 's' + Date.now().toString(36);
    ipcRenderer.send('stream-chat-start', { requestId, payload });
    return requestId;
  },
  streamChatStop: (requestId) => {
    if (!requestId) return;
    ipcRenderer.send('stream-chat-stop', { requestId });
  },
  streamChatOnChunk: (cb) => ipcRenderer.on('stream-chat-chunk', (_, d) => cb(d)),
  streamChatOnDone: (cb) => ipcRenderer.on('stream-chat-done', (_, d) => cb(d)),
  streamChatOnError: (cb) => ipcRenderer.on('stream-chat-error', (_, d) => cb(d)),
  streamChatOff: () => {
    ipcRenderer.removeAllListeners('stream-chat-chunk');
    ipcRenderer.removeAllListeners('stream-chat-done');
    ipcRenderer.removeAllListeners('stream-chat-error');
  },
});
