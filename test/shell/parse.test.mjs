import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// main.cjs は electron を require するので、そのまま読み込むと落ちる。
// 入出力だけの関数を試したいので、electron を差し替えて読み込む。
const require_ = createRequire(import.meta.url);
const Module = require_('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return require_.resolve('./electron-stub.cjs');
  return origResolve.call(this, request, ...rest);
};
const { parseTrackId, overlayUrl, overlayWindowOptions, trackFromArgv } = require_('../../desktop/main.cjs');
Module._resolveFilename = origResolve;

test('運営のリンクから2つのIDを取り出す', () => {
  assert.deepEqual(
    parseTrackId('https://df-hackathon-2026.web.app/stage.html?e=ev123&t=a'),
    { eventId: 'ev123', trackId: 'a' });
});

test('古い合言葉つきのリンクも受ける（合言葉は捨てる）', () => {
  // 以前のリンクが残っていても開けるようにする。鍵はもう使わない。
  assert.deepEqual(
    parseTrackId('https://x.test/stage.html?e=ev123&t=a&k=CODE2345'),
    { eventId: 'ev123', trackId: 'a' });
});

test('danmaku:// のリンクから取り出す', () => {
  assert.deepEqual(
    parseTrackId('danmaku://track?e=ev123&t=a&k=CODE2345'),
    { eventId: 'ev123', trackId: 'a' });
});

test('投稿URLからも取り出す', () => {
  assert.deepEqual(
    parseTrackId('https://x.test/post.html?e=ev9&t=b'),
    { eventId: 'ev9', trackId: 'b' });
});

test('手で2つ並べて貼られても受ける', () => {
  assert.deepEqual(parseTrackId('ev123 a'), { eventId: 'ev123', trackId: 'a' });
  assert.deepEqual(parseTrackId('ev123/a'), { eventId: 'ev123', trackId: 'a' });
});

test('前後の空白を落とす', () => {
  assert.deepEqual(parseTrackId('  ev123 a \n'), { eventId: 'ev123', trackId: 'a' });
});

test('空なら null', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(parseTrackId(v), null);
});

test('片方しか無いリンクは通さない', () => {
  assert.equal(parseTrackId('https://x.test/stage.html?e=ev123'), null);
  assert.equal(parseTrackId('https://x.test/stage.html?t=a'), null);
  assert.equal(parseTrackId('https://x.test/stage.html'), null);
});

test('危ない値は通さない', () => {
  // そのまま URL に差し込むと他のクエリを足せてしまう
  for (const v of ['ev1 a b', 'https://x.test/?e=a/b&t=c', 'https://x.test/?e=<script>&t=a',
                   'https://x.test/?e=a&b=c&t=x y', 'danmaku://']) {
    const r = parseTrackId(v);
    assert.ok(r === null || (/^[A-Za-z0-9_-]+$/.test(r.eventId) && /^[A-Za-z0-9_-]+$/.test(r.trackId)),
      `通ってしまった: ${v} -> ${JSON.stringify(r)}`);
  }
});

test('弾幕ページのURLは透過とHUD非表示を付ける', () => {
  const u = new URL(overlayUrl({ eventId: 'ev123', trackId: 'a' }));
  assert.equal(u.pathname, '/overlay.html');
  assert.equal(u.searchParams.get('e'), 'ev123');
  assert.equal(u.searchParams.get('t'), 'a');
  assert.equal(u.searchParams.get('transparent'), '1');
  assert.equal(u.searchParams.get('hud'), '0');
});

test('起動時の引数から danmaku:// を拾う', () => {
  assert.deepEqual(trackFromArgv(['/path/app', 'danmaku://track?e=ev1&t=z']),
    { eventId: 'ev1', trackId: 'z' });
});

test('引数に danmaku:// が無ければ null', () => {
  assert.equal(trackFromArgv(['/path/app', '--foo']), null);
  assert.equal(trackFromArgv([]), null);
  assert.equal(trackFromArgv(undefined), null);
});

test('画面の端まで覆えるようにしてある', () => {
  // macOS はメニューバーのぶんウィンドウを押し下げる。これを外さないと
  // 画面の上端が覆えず、投影に帯が残る。
  const o = overlayWindowOptions({ x: 0, y: 0, width: 100, height: 100 });
  assert.equal(o.enableLargerThanScreen, true);
});

test('重ねるウィンドウの設定が揃っている', () => {
  // どれか1つ外れただけで、全画面のスライドショーの上に残らなくなる
  const o = overlayWindowOptions({ x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(o.transparent, true, '透過していない');
  assert.equal(o.frame, false, '枠が出る');
  assert.equal(o.alwaysOnTop, true, '最前面でない');
  assert.equal(o.backgroundColor, '#00000000', '背景が透過でない');
  assert.equal(o.hasShadow, false, '影が落ちる');
  assert.equal(o.skipTaskbar, true, 'タスクバーに出る');
});

test('全画面にできないようにしてある', () => {
  // fullscreen にすると OS が別の Space を作り、スライドの上に出られなくなる
  const o = overlayWindowOptions({ x: 0, y: 0, width: 100, height: 100 });
  assert.equal(o.fullscreenable, false);
});

test('フォーカスを取らないようにしてある', () => {
  // フォーカスを取るとスライドショーが一時停止する
  const o = overlayWindowOptions({ x: 0, y: 0, width: 100, height: 100 });
  assert.equal(o.focusable, false);
});

test('画面が隠れても描画を止めない', () => {
  // 止まると弾幕が固まる
  const o = overlayWindowOptions({ x: 0, y: 0, width: 100, height: 100 });
  assert.equal(o.webPreferences.backgroundThrottling, false);
});

test('触って動かせないようにしてある', () => {
  const o = overlayWindowOptions({ x: 0, y: 0, width: 100, height: 100 });
  for (const k of ['resizable', 'movable', 'minimizable', 'maximizable']) {
    assert.equal(o[k], false, `${k} が有効`);
  }
});

test('渡した位置と大きさをそのまま使う', () => {
  const o = overlayWindowOptions({ x: 1920, y: 0, width: 2560, height: 1440 });
  assert.equal(o.x, 1920);
  assert.equal(o.y, 0);
  assert.equal(o.width, 2560);
  assert.equal(o.height, 1440);
});
