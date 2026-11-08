// 貼り方C: 透過ウィンドウをスライドの上に重ねる。
//
// このシェルは弾幕を描かない。配信済みの弾幕ページを透過ウィンドウで開くだけ。
// 描画の実装を1本に保つのがこのプロダクトの設計なので、ここに描画を持たせない。
//
// 全画面のスライドショーの上に残すには 'screen-saver' レベルが要る。
// 'floating' や 'normal' では PowerPoint や Keynote の全画面に負ける。
const { app, BrowserWindow, globalShortcut, screen, ipcMain, shell } = require('electron');
const path = require('node:path');

/** 既定の配信先。開発中は DANMAKU_ORIGIN で差し替える。 */
const ORIGIN = process.env.DANMAKU_ORIGIN ?? 'https://df-hackathon-2026.web.app';

let setupWin = null;
let overlayWin = null;
let clickThrough = true;

function overlayUrl(trackId) {
  const u = new URL('/overlay.html', ORIGIN);
  u.searchParams.set('track', trackId);
  u.searchParams.set('transparent', '1');
  u.searchParams.set('hud', '0');       // 投影に映るので既定では出さない
  return u.toString();
}

/** 入力されたものからトラックIDを取り出す。URL をそのまま貼られても通す。 */
function parseTrackId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const t = u.searchParams.get('track');
    if (t) return t;
  } catch { /* URL でなければ ID そのものとして扱う */ }
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 520, height: 460, resizable: false,
    title: '弾幕スライド',
    backgroundColor: '#0b0b0f',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  setupWin.loadFile(path.join(__dirname, 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; });
  return setupWin;
}

/**
 * 重ねるウィンドウの設定。
 *
 * ここの組み合わせが 貼り方C の本体で、1つ外れるだけで最前面に残らなくなる。
 * 作った後から読み戻せない項目があるので、データとして切り出してテストできるようにする。
 */
function overlayWindowOptions(bounds) {
  return {
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    // fullscreen にすると OS が別の Space を作って、スライドの上に出られない
    fullscreenable: false,
    // フォーカスを取るとスライドショーが一時停止する
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      // 画面が隠れていても描画を止めない。止まると弾幕が固まる。
      backgroundThrottling: false,
    },
  };
}

function createOverlayWindow(trackId, displayId) {
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => String(d.id) === String(displayId)) ?? screen.getPrimaryDisplay();
  const { x, y, width, height } = target.bounds;

  overlayWin = new BrowserWindow(overlayWindowOptions({ x, y, width, height }));

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(clickThrough, { forward: true });
  overlayWin.loadURL(overlayUrl(trackId));
  overlayWin.on('closed', () => { overlayWin = null; });
  return overlayWin;
}

/**
 * 最前面を取り直す。
 *
 * PowerPoint のスライドショーは自分を最前面に主張し続けるので、一度重ねても
 * しばらくすると裏に回ることがある。定期的に押し戻す。
 * 奪い返すのはウィンドウの重なり順だけで、フォーカスは取らない
 * （フォーカスを取るとスライドショーが一時停止する）。
 */
function keepOnTop() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.moveTop();
}

function registerShortcuts() {
  const mod = process.platform === 'darwin' ? 'Command' : 'Control';
  globalShortcut.register(`${mod}+Shift+X`, () => app.quit());
  globalShortcut.register(`${mod}+Shift+C`, () => {
    clickThrough = !clickThrough;
    overlayWin?.setIgnoreMouseEvents(clickThrough, { forward: true });
  });
}

app.whenReady().then(() => {
  // Dock に出すとフォーカスを取ってしまう場面があるので隠す
  if (process.platform === 'darwin') app.dock?.hide();

  ipcMain.handle('displays', () => screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `${i + 1}: ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? '（メイン）' : ''}`,
    primary: d.id === screen.getPrimaryDisplay().id,
  })));

  ipcMain.handle('start', (_e, { track, displayId }) => {
    const id = parseTrackId(track);
    if (!id) return { ok: false, reason: 'トラックIDかURLを入れる' };
    overlayWin?.close();
    createOverlayWindow(id, displayId);
    setupWin?.hide();
    return { ok: true, trackId: id };
  });

  ipcMain.handle('stop', () => { overlayWin?.close(); setupWin?.show(); return { ok: true }; });
  ipcMain.handle('openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('origin', () => ORIGIN);

  registerShortcuts();
  setInterval(keepOnTop, 1500);
  createSetupWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSetupWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => globalShortcut.unregisterAll());

// テストから中身を確かめられるようにする
module.exports = { parseTrackId, overlayUrl, overlayWindowOptions };
