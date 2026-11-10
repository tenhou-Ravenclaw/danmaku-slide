// Electron を実際に起動して、透過ウィンドウの性質を確かめる。
//
// 「全画面のスライドショーの上に残るか」は実機と人間が要るので自動化できない。
// できるのは、そのために必要な設定が実際に入っているかを見るところまで。
// 設定が1つ外れただけで最前面に残らなくなるので、ここを固定する価値はある。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAIN = fileURLToPath(new URL('../../desktop/main.cjs', import.meta.url));
let app, setup, profile;

before(async () => {
  // 専用の作業ディレクトリで動かす。
  // 二重起動を止める仕組みがあるので、手元でアプリを起動していると
  // テスト側がロックを取れずに即終了する。
  profile = mkdtempSync(join(tmpdir(), 'danmaku-shell-'));
  app = await _electron.launch({
    args: [`--user-data-dir=${profile}`, MAIN],
    // 本番を叩かせない。重ねる先の URL の組み立てだけを見る。
    env: { ...process.env, DANMAKU_ORIGIN: 'http://127.0.0.1:1/' },
  });
  setup = await app.firstWindow();
  await setup.waitForSelector('#track');
});

after(async () => {
  await app?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

test('最初に出るのは設定ウィンドウ', async () => {
  assert.equal(await setup.title(), '弾幕スライド');
  assert.ok(await setup.isVisible('#track'));
  assert.ok(await setup.isVisible('#display'));
});

test('画面の一覧が出る', async () => {
  const n = await setup.evaluate(() => document.getElementById('display').options.length);
  assert.ok(n >= 1, `画面が出ていない: ${n}`);
});

test('確認用のテスト弾のチェックが既定でオンで出ている', async () => {
  // 投稿が来るまで画面は空なので、透過・最前面・位置を確かめる確認弾。
  assert.ok(await setup.isVisible('#testShot'), '確認弾のチェックが無い');
  assert.ok(await setup.evaluate(() => document.getElementById('testShot').checked),
    '確認弾が既定でオフになっている');
});

test('不正なトラックIDは弾いて理由を出す', async () => {
  await setup.fill('#track', 'a b c d');
  await setup.click('#go');
  await setup.waitForFunction(
    () => document.getElementById('msg').dataset.kind === 'bad', { timeout: 5000 });
  const made = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => w.isAlwaysOnTop()).length);
  assert.equal(made, 0, '不正な入力で重ねるウィンドウができた');
});

test('重ねるウィンドウが透過・枠なし・最前面で作られる', async () => {
  await setup.fill('#track', 'https://x.test/stage.html?e=ev123&t=testtrak');
  await setup.click('#go');
  await setup.waitForFunction(
    () => document.body.dataset.running === '1', { timeout: 10000 });

  const props = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.isAlwaysOnTop());
    if (!w) return null;
    return {
      alwaysOnTop: w.isAlwaysOnTop(),
      resizable: w.isResizable(),
      movable: w.isMovable(),
      fullScreenable: w.isFullScreenable(),
      minimizable: w.isMinimizable(),
      maximizable: w.isMaximizable(),
      bounds: w.getBounds(),
    };
  });
  assert.ok(props, '重ねるウィンドウができていない');
  assert.ok(props.alwaysOnTop, '最前面になっていない');
  assert.ok(!props.resizable, 'リサイズできてしまう');
  assert.ok(!props.movable, '動かせてしまう');
  // fullscreen にすると OS が別の Space を作り、スライドの上に出られなくなる
  assert.ok(!props.fullScreenable, '全画面にできてしまう');
  assert.ok(!props.minimizable && !props.maximizable, '最小化・最大化できてしまう');
  // 透過そのものは作った後から読み戻せない。設定は parse.test.mjs で見ている。
  assert.ok(props.bounds.width > 0 && props.bounds.height > 0, `大きさが変: ${JSON.stringify(props.bounds)}`);
});

test('流したとき overlay の URL に test=1 が乗る（確認弾が既定オン）', async () => {
  // 投稿が来るまで画面は空なので、透過・最前面・位置を確かめる確認弾。
  // チェックは既定オンなので、直前の start で test=1 が付いているはず。
  const url = await app.evaluate(() => global.__lastOverlayUrl);
  assert.match(url ?? '', /[?&]test=1\b/, `overlay に test=1 が無い: ${url}`);
});

test('弾幕を出し始めても設定ウィンドウは消えない', async () => {
  // 止める手段はこのウィンドウの中にしか無い。Dock を隠しているので
  // Cmd+Tab でも呼び戻せず、隠すと「出すには止める、止めるには出す」になる。
  const shown = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => !w.isAlwaysOnTop()).map((w) => w.isVisible()));
  assert.equal(shown.length, 1, `設定ウィンドウが1つでない: ${shown.length}`);
  assert.ok(shown[0], '設定ウィンドウが隠れている');
});

test('重ねるウィンドウはどれかの画面をいっぱいに覆う', async () => {
  // 投影先を既定にしているので、メインとは限らない。
  // どれかの画面とぴったり一致していればいい。
  const fits = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.isAlwaysOnTop());
    return { b: w.getBounds(), ds: screen.getAllDisplays().map((d) => d.bounds) };
  });
  const hit = fits.ds.some((d) =>
    d.x === fits.b.x && d.y === fits.b.y && d.width === fits.b.width && d.height === fits.b.height);
  assert.ok(hit, `どの画面とも一致しない: ${JSON.stringify(fits.b)} / ${JSON.stringify(fits.ds)}`);
});

test('画面が2枚以上あるときは投影先（メインでないほう）を既定にする', async () => {
  const r = await app.evaluate(({ BrowserWindow, screen }) => {
    const ds = screen.getAllDisplays();
    if (ds.length < 2) return { skip: true };
    const w = BrowserWindow.getAllWindows().find((x) => x.isAlwaysOnTop());
    const b = w.getBounds();
    const primary = screen.getPrimaryDisplay().bounds;
    return { skip: false, onPrimary: b.x === primary.x && b.y === primary.y };
  });
  if (r.skip) { console.log('    （画面が1枚なので確かめられない）'); return; }
  assert.ok(!r.onPrimary, 'メイン画面に出している');
});

test('弾幕ウィンドウはクリックを必ず下へ通す', async () => {
  // 切り替える口は置かない。この窓には押せるものが1つも無いので、
  // 受け取るようにすると、何もせずクリックを飲み込むだけの板になる。
  // スライドにも設定ウィンドウにも手が届かなくなる（旧 #65）。
  const through = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => w.isAlwaysOnTop()).length);
  assert.ok(through > 0, '弾幕ウィンドウが無い');
  assert.equal(await setup.evaluate(() => typeof window.shell.setClickThrough),
    'undefined', '切り替える口が残っている');
});

test('終了ボタンは置いていない', async () => {
  // 終了はウィンドウを閉じるか ⌘⇧X。ボタンを無くしたので、renderer 向けの
  // quit の口も外してある（残すと使い道の無い口だけが開いたままになる）。
  assert.equal(await setup.evaluate(() => !!document.getElementById('quit')), false, '終了ボタンが残っている');
  assert.equal(await setup.evaluate(() => typeof window.shell.quit),
    'undefined', '終了の口が残っている');
});

test('終了のキーが登録されている', async () => {
  // 全画面のスライドショー中は窓に手が届かない。そこからの逃げ道。
  const keys = await app.evaluate(({ globalShortcut }) => ({
    quit: globalShortcut.isRegistered('Command+Shift+X') || globalShortcut.isRegistered('Control+Shift+X'),
    gone: globalShortcut.isRegistered('Command+Shift+C') || globalShortcut.isRegistered('Control+Shift+C'),
  }));
  assert.ok(keys.quit, '終了のキーが無い');
  assert.ok(!keys.gone, '切り替えのキーが残っている');
});

test('「流すのをやめる」で重ねるウィンドウが消える（設定画面には戻らない）', async () => {
  // オンオフはその場で切り替える。登壇中に一瞬だけ消したいとき、
  // 設定画面を経由させない。
  await setup.click('#toggle');
  await setup.waitForFunction(
    () => document.body.dataset.running !== '1', { timeout: 10000 });
  const left = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => w.isAlwaysOnTop()).length);
  assert.equal(left, 0, `残っている: ${left}`);
  assert.equal(await setup.evaluate(() => document.body.dataset.view), 'live',
    '設定画面に戻ってしまった');
  assert.equal(await setup.textContent('#toggle'), 'スライドに流す');
});

test('もう一度押すと同じ設定のまま流し直せる', async () => {
  await setup.click('#toggle');
  await setup.waitForFunction(
    () => document.body.dataset.running === '1', { timeout: 10000 });
  assert.match(await setup.textContent('#liveText'), /を流しています$/);
  assert.equal(await setup.textContent('#toggle'), '流すのをやめる');
});

test('「設定を変更する」で止まって設定画面に戻る', async () => {
  await setup.click('#config');
  await setup.waitForFunction(
    () => document.body.dataset.view !== 'live', { timeout: 10000 });
  const left = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => w.isAlwaysOnTop()).length);
  assert.equal(left, 0, `重ねるウィンドウが残っている: ${left}`);
  assert.ok(await setup.isVisible('#track'), '貼る欄が戻っていない');
});

test('リンクから渡ってきたトラックを入力欄に差し込まない', async () => {
  // 欄の中に `b52bj39v a` と並ぶと、受け取れたのではなく自分が貼り間違えたように
  // 見える。受け取れた事実と、受け取った中身を分けて出す。
  await setup.fill('#track', '');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isAlwaysOnTop());
    w.webContents.send('track', { eventId: 'b52bj39v', trackId: 'a' });
  });
  await setup.waitForFunction(() => document.body.dataset.got === '1', { timeout: 5000 });
  assert.equal(await setup.inputValue('#track'), '', '入力欄に差し込んでいる');
  assert.equal(await setup.isVisible('#track'), false, '貼る欄が出たままになっている');
  assert.equal(await setup.textContent('#gotEvent'), 'b52bj39v');
  assert.equal(await setup.textContent('#gotTrack'), 'a');
});

test('受け取ったリンクは貼らずにそのまま流し始められる', async () => {
  // 手で貼る経路は変えていないので、受け取ったぶんも同じ入口を通る
  await setup.click('#go');
  await setup.waitForFunction(
    () => document.body.dataset.running === '1', { timeout: 10000 });
  assert.match(await setup.textContent('#liveText'), /^a を/);
  await setup.click('#config');
  await setup.waitForFunction(
    () => document.body.dataset.view !== 'live', { timeout: 10000 });
});

test('届いたリンクが違っていたら、手で貼る欄に戻せる', async () => {
  // 運営が別のトラックのリンクを送ることがある。戻る道が無いと、
  // アプリを閉じて開き直すしかなくなる（#66）。
  await setup.waitForFunction(() => document.body.dataset.got === '1', { timeout: 5000 });
  await setup.click('#redo');
  await setup.waitForFunction(() => document.body.dataset.got !== '1', { timeout: 5000 });
  assert.equal(await setup.isVisible('#track'), true, '貼る欄が戻っていない');
  assert.equal(await setup.inputValue('#track'), '', '前の値が残っている');

  // 受け取ったぶんは捨てる。残っていると、手で貼ったものが無視される。
  await setup.fill('#track', 'b52bj39v b');
  await setup.click('#go');
  await setup.waitForFunction(
    () => document.body.dataset.running === '1', { timeout: 10000 });
  assert.match(await setup.textContent('#liveText'), /^b を/, '受け取ったぶんが残っている');
  await setup.click('#config');
  await setup.waitForFunction(
    () => document.body.dataset.view !== 'live', { timeout: 10000 });
});

test('設定ウィンドウを閉じるとアプリが終わる', async () => {
  // 終了ボタンの代わり。閉じたまま生き残ると、Dock も隠れているので
  // 戻る道が1つも無くなる。終わらせるので、この項目はいちばん最後に置く。
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => !w.isAlwaysOnTop())?.close();
  }).catch(() => { /* 終了と評価が競走するので、切れても構わない */ });
  await exited;
  app = null;
});
