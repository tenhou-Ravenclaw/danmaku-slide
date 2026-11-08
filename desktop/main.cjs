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
let pendingTrack = null;   // リンクから渡ってきたトラック

function overlayUrl({ eventId, trackId }) {
  const u = new URL('/overlay.html', ORIGIN);
  u.searchParams.set('e', eventId);
  u.searchParams.set('t', trackId);
  u.searchParams.set('transparent', '1');
  u.searchParams.set('hud', '0');       // 投影に映るので既定では出さない
  return u.toString();
}

/**
 * 入力されたものからトラックIDを取り出す。
 *
 * 手で貼られるもの（ID / 投稿URL）と、運営のリンクから渡ってくるもの
 * （danmaku://track/xxx）のどちらも通す。前者は人が、後者は OS が渡してくる。
 */
function parseTrackId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const e = u.searchParams.get('e'), t = u.searchParams.get('t');
    if (valid(e) && valid(t)) return { eventId: e, trackId: t };
  } catch { /* URL でなければ下の形を見る */ }
  // 「イベントID トラックID」を手で貼られた場合
  const m = s.match(/^([A-Za-z0-9_-]{1,64})[\s/]+([A-Za-z0-9_-]{1,64})$/);
  if (m) return { eventId: m[1], trackId: m[2] };
  return null;
}
const valid = (s) => (/^[A-Za-z0-9_-]{1,64}$/.test(String(s ?? '')) ? String(s) : null);

/** 起動時の引数や second-instance の引数から danmaku:// を拾う。 */
function trackFromArgv(argv) {
  const hit = (argv ?? []).find((a) => typeof a === 'string' && a.startsWith('danmaku:'));
  return hit ? parseTrackId(hit) : null;
}

/**
 * リンクから渡ってきたトラックを設定ウィンドウに流し込む。
 * 登壇者に貼らせないためにこの経路がある。
 */
function deliverTrack(target) {
  if (!target) return;
  pendingTrack = target;
  if (!setupWin || setupWin.isDestroyed()) createSetupWindow();
  setupWin.show();
  setupWin.focus();
  setupWin.webContents.send('track', target);
}

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 520, height: 460, resizable: false,
    title: '弾幕スライド',
    backgroundColor: '#0b0b0f',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  setupWin.loadFile(path.join(__dirname, 'setup.html'));
  setupWin.webContents.once('did-finish-load', () => {
    if (pendingTrack) setupWin.webContents.send('track', pendingTrack);
  });
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
    // macOS はメニューバーのぶんウィンドウを押し下げる。これを外さないと
    // 画面の上端 30px ほどが覆えず、投影に帯が残る。
    enableLargerThanScreen: true,
    webPreferences: {
      // 画面が隠れていても描画を止めない。止まると弾幕が固まる。
      backgroundThrottling: false,
    },
  };
}

function createOverlayWindow(track, displayId) {
  const displays = screen.getAllDisplays();
  const display = displays.find((d) => String(d.id) === String(displayId)) ?? screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  overlayWin = new BrowserWindow(overlayWindowOptions({ x, y, width, height }));

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 生成時の指定だけだと、macOS がメニューバーのぶん押し下げることがある。
  // 最前面のレベルを上げてから置き直すと、画面の端まで覆える。
  overlayWin.setBounds({ x, y, width, height });
  overlayWin.setIgnoreMouseEvents(clickThrough, { forward: true });
  overlayWin.loadURL(overlayUrl(track));
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

// 二重起動させない。リンクを開くたびに新しいアプリが立つと、重なりが二重になる。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => deliverTrack(trackFromArgv(argv)));
}
// macOS はここに来る
app.on('open-url', (e, url) => { e.preventDefault(); deliverTrack(parseTrackId(url)); });

app.whenReady().then(() => {
  // Dock に出すとフォーカスを取ってしまう場面があるので隠す
  if (process.platform === 'darwin') app.dock?.hide();

  ipcMain.handle('displays', () => screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `${i + 1}: ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? '（メイン）' : ''}`,
    primary: d.id === screen.getPrimaryDisplay().id,
  })));

  ipcMain.handle('start', (_e, { track, displayId }) => {
    const target = parseTrackId(track);
    if (!target) return { ok: false, reason: '運営からのリンクを貼ってください' };
    overlayWin?.close();
    createOverlayWindow(target, displayId);
    setupWin?.hide();
    return { ok: true, trackId: target.trackId };
  });

  ipcMain.handle('stop', () => { overlayWin?.close(); setupWin?.show(); return { ok: true }; });
  ipcMain.handle('openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('origin', () => ORIGIN);

  // 開発中は実行ファイルの場所が違うので、引数を添えて登録する
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('danmaku', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('danmaku');
  }

  registerShortcuts();
  setInterval(keepOnTop, 1500);
  pendingTrack = trackFromArgv(process.argv);
  createSetupWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSetupWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => globalShortcut.unregisterAll());

// テストから中身を確かめられるようにする
module.exports = { parseTrackId, overlayUrl, overlayWindowOptions, trackFromArgv };
