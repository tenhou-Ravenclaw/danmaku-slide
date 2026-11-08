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
const { parseTrackId, overlayUrl, overlayWindowOptions } = require_('../../desktop/main.cjs');
Module._resolveFilename = origResolve;

test('トラックIDをそのまま受け取る', () => {
  assert.equal(parseTrackId('abc23xyz'), 'abc23xyz');
});

test('投稿URLを貼られてもトラックIDを取り出す', () => {
  assert.equal(
    parseTrackId('https://df-hackathon-2026.web.app/post.html?track=abc23xyz'),
    'abc23xyz');
});

test('弾幕ページのURLからも取り出す', () => {
  assert.equal(
    parseTrackId('https://df-hackathon-2026.web.app/overlay.html?track=zz99&hud=0'),
    'zz99');
});

test('前後の空白を落とす', () => {
  assert.equal(parseTrackId('  abc23xyz \n'), 'abc23xyz');
});

test('空なら null', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(parseTrackId(v), null);
});

test('URLでもIDでもないものは通さない', () => {
  // そのまま URL に差し込むと他のクエリを足せてしまう
  for (const v of ['a b', 'abc?x=1', 'a/b', '<script>', 'a&b=c', 'あいう']) {
    assert.equal(parseTrackId(v), null, `通ってしまった: ${v}`);
  }
});

test('track を持たないURLは通さない', () => {
  assert.equal(parseTrackId('https://df-hackathon-2026.web.app/post.html'), null);
});

test('弾幕ページのURLは透過とHUD非表示を付ける', () => {
  const u = new URL(overlayUrl('abc23xyz'));
  assert.equal(u.pathname, '/overlay.html');
  assert.equal(u.searchParams.get('track'), 'abc23xyz');
  assert.equal(u.searchParams.get('transparent'), '1');
  assert.equal(u.searchParams.get('hud'), '0');
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
