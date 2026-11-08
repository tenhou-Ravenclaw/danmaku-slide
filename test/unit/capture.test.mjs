import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitRect } from '../../public/lib/capture.mjs';
import { Renderer } from '../../public/lib/renderer.mjs';

test('同じ比なら画面いっぱいに収まる', () => {
  const r = fitRect(1920, 1080, 1280, 720);
  assert.deepEqual(r, { x: 0, y: 0, width: 1280, height: 720 });
});

test('横長の画面では左右に余白が出る', () => {
  // 4:3 のスライドを 16:9 の画面に出す
  const r = fitRect(1024, 768, 1920, 1080);
  assert.equal(r.height, 1080);
  assert.equal(Math.round(r.width), 1440);
  assert.equal(Math.round(r.x), 240);
  assert.equal(r.y, 0);
});

test('縦長の画面では上下に余白が出る', () => {
  const r = fitRect(1920, 1080, 1080, 1920);
  assert.equal(r.width, 1080);
  assert.equal(Math.round(r.height), 608);
  assert.equal(r.x, 0);
  assert.ok(r.y > 0);
});

test('歪めない', () => {
  for (const [sw, sh, dw, dh] of [[1920,1080,800,600],[1024,768,1920,500],[3000,2000,640,480]]) {
    const r = fitRect(sw, sh, dw, dh);
    assert.ok(Math.abs((r.width / r.height) - (sw / sh)) < 1e-6,
      `比が変わった: ${sw}x${sh} → ${r.width}x${r.height}`);
  }
});

test('はみ出さない', () => {
  for (const [sw, sh, dw, dh] of [[1920,1080,800,600],[1024,768,1920,500],[100,4000,640,480]]) {
    const r = fitRect(sw, sh, dw, dh);
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6, `原点がはみ出した: ${JSON.stringify(r)}`);
    assert.ok(r.x + r.width <= dw + 1e-6, `右にはみ出した: ${JSON.stringify(r)}`);
    assert.ok(r.y + r.height <= dh + 1e-6, `下にはみ出した: ${JSON.stringify(r)}`);
  }
});

test('大きさが取れていないときは何も描かない形を返す', () => {
  // キャプチャ直後は videoWidth が 0 のことがある
  for (const a of [[0, 1080, 800, 600], [1920, 0, 800, 600], [1920, 1080, 0, 600]]) {
    assert.deepEqual(fitRect(...a), { x: 0, y: 0, width: 0, height: 0 });
  }
});

// --- 下敷きの描画 -------------------------------------------------------
function fakeCanvas() {
  const calls = [];
  const ctx = {
    _s: {},
    setTransform: () => {}, clearRect: (...a) => calls.push(['clearRect', ...a]),
    drawImage: (...a) => calls.push(['drawImage', ...a]),
    strokeText: (...a) => calls.push(['strokeText', ...a]),
    fillText: (...a) => calls.push(['fillText', ...a]),
    measureText: (t) => ({ width: [...t].length * 18 }),
  };
  for (const k of ['font','textBaseline','fillStyle','strokeStyle','lineWidth','lineJoin','miterLimit']) {
    Object.defineProperty(ctx, k, { get() { return this._s[k]; }, set(v) { this._s[k] = v; } });
  }
  return { canvas: { width: 0, height: 0, getContext: () => ctx }, calls };
}

test('下敷きは弾幕より先に描く', () => {
  // 逆だとスライドがコメントを塗りつぶす
  const { canvas, calls } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(1920, 1080, 1);
  calls.length = 0;
  r.draw([{ id: 'a', text: 'あ', width: 18, x: 10, y: 0, lane: 0 }],
         { source: {}, x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(calls.map((c) => c[0]), ['clearRect', 'drawImage', 'strokeText', 'fillText']);
});

test('下敷きが無ければ描かない', () => {
  const { canvas, calls } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(1920, 1080, 1);
  calls.length = 0;
  r.draw([], null);
  assert.deepEqual(calls.map((c) => c[0]), ['clearRect']);
});

test('大きさ 0 の下敷きは描かない', () => {
  // キャプチャ直後に 0 のまま描くと例外になる
  const { canvas, calls } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(1920, 1080, 1);
  calls.length = 0;
  r.draw([], { source: {}, x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(calls.map((c) => c[0]), ['clearRect']);
});

test('下敷きは渡された位置と大きさで描く', () => {
  const { canvas, calls } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(1920, 1080, 1);
  calls.length = 0;
  const src = { tag: 'video' };
  r.draw([], { source: src, x: 240, y: 0, width: 1440, height: 1080 });
  assert.deepEqual(calls.find((c) => c[0] === 'drawImage'),
    ['drawImage', src, 240, 0, 1440, 1080]);
});
