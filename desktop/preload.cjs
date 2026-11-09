// レンダラに渡す口。contextIsolation の既定（有効）のまま、必要な分だけ通す。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  // 運営のリンクから渡ってきたトラックを受け取る
  onTrack: (fn) => ipcRenderer.on('track', (_e, id) => fn(id)),
  displays: () => ipcRenderer.invoke('displays'),
  start: (args) => ipcRenderer.invoke('start', args),
  stop: () => ipcRenderer.invoke('stop'),
  quit: () => ipcRenderer.invoke('quit'),
  origin: () => ipcRenderer.invoke('origin'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
});
