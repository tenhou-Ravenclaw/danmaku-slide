// main.cjs を読み込むためだけの差し替え。入出力だけの関数を試すのに使う。
const noop = () => {};
module.exports = {
  app: { whenReady: () => ({ then: noop }), on: noop, quit: noop, dock: { hide: noop } },
  BrowserWindow: class { static getAllWindows() { return []; } },
  globalShortcut: { register: noop, unregisterAll: noop },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, bounds: {}, size: {} }) },
  ipcMain: { handle: noop },
  shell: { openExternal: noop },
};
