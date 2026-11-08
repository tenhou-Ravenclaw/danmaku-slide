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

test('終了と切り替えのキーが登録されている', async () => {
  const keys = await app.evaluate(({ globalShortcut }) => ({
    mac: globalShortcut.isRegistered('Command+Shift+X') || globalShortcut.isRegistered('Control+Shift+X'),
    toggle: globalShortcut.isRegistered('Command+Shift+C') || globalShortcut.isRegistered('Control+Shift+C'),
  }));
  assert.ok(keys.mac, '終了のキーが無い');
  assert.ok(keys.toggle, 'クリック透過の切り替えキーが無い');
});

test('やめると重ねるウィンドウが消えて設定に戻る', async () => {
  await setup.click('#halt');
  await setup.waitForFunction(
    () => document.body.dataset.running !== '1', { timeout: 10000 });
  const left = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => w.isAlwaysOnTop()).length);
  assert.equal(left, 0, `残っている: ${left}`);
});
