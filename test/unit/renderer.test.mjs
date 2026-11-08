import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer, STYLE } from '../../public/lib/renderer.mjs';

/** 呼ばれた描画命令を記録する ctx。実際の Canvas は要らない。 */
function fakeCanvas() {
  const calls = [];
  const ctx = {
    _state: {},
    setTransform: (...a) => calls.push(['setTransform', ...a]),
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    strokeText: (...a) => calls.push(['strokeText', ...a]),
    fillText: (...a) => calls.push(['fillText', ...a]),
    measureText: (t) => ({ width: [...t].length * 18 }),
  };
  for (const k of ['font', 'textBaseline', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineJoin', 'miterLimit']) {
    Object.defineProperty(ctx, k, {
      get() { return this._state[k]; },
      set(v) { this._state[k] = v; calls.push(['set', k, v]); },
    });
  }
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return { canvas, ctx, calls };
}

test('実ピクセルで持ち、変換行列で DPR を吸収する', () => {
  const { canvas, calls } = fakeCanvas();
  const r = new Renderer(canvas);
  const size = r.resize(1920, 1080, 2);
  assert.equal(canvas.width, 3840);
  assert.equal(canvas.height, 2160);
  assert.deepEqual(size, { width: 1920, height: 1080 });
  assert.deepEqual(calls.filter((c) => c[0] === 'setTransform').at(-1), ['setTransform', 2, 0, 0, 2, 0, 0]);
});

test('0 以下のサイズでも Canvas が壊れない', () => {
  const { canvas } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(0, 0, 1);
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
});

test('描くのは strokeText と fillText だけ（DOM を作らない）', () => {
  const { canvas, calls } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(800, 600, 1);
  calls.length = 0;
  r.draw([{ id: 'a', text: 'あ', width: 18, x: 100, y: 52, lane: 1 }]);
  const kinds = calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['clearRect', 'strokeText', 'fillText']);
});

test('縁取りを先に描いてから本体を描く', () => {
  // 逆順だと縁取りが文字の上に乗って読めなくなる
  const { canvas, calls } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(800, 600, 1);
  calls.length = 0;
  r.draw([{ id: 'a', text: 'テスト', width: 54, x: 10, y: 0, lane: 0 }]);
  const i = calls.findIndex((c) => c[0] === 'strokeText');
  const j = calls.findIndex((c) => c[0] === 'fillText');
  assert.ok(i < j, 'fillText が先に来ている');
});

test('基準線は行の上端から baselineOffset だけ下げる', () => {
  const { canvas, calls } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(800, 600, 1);
  calls.length = 0;
  r.draw([{ id: 'a', text: 'あ', width: 18, x: 10, y: 104, lane: 2 }]);
  const fill = calls.find((c) => c[0] === 'fillText');
  assert.equal(fill[3], 104 + STYLE.baselineOffset);
});

test('文字列はそのまま渡す（マークアップとして解釈しない）', () => {
  // Canvas の fillText は文字を文字として描くだけ。DOM に入れないことが対策になる。
  const { canvas, calls } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(800, 600, 1);
  calls.length = 0;
  const payload = '<script>alert(1)</scr' + 'ipt>';
  r.draw([{ id: 'x', text: payload, width: 100, x: 0, y: 0, lane: 0 }]);
  assert.equal(calls.find((c) => c[0] === 'fillText')[1], payload);
});

test('幅は測れて、同じ文面は測り直さない', () => {
  const { canvas, ctx } = fakeCanvas();
  let measured = 0;
  const orig = ctx.measureText;
  ctx.measureText = (t) => { measured++; return orig(t); };
  const r = new Renderer(canvas);
  r.resize(800, 600, 1);

  assert.equal(r.measure('あいう'), 54);
  assert.equal(measured, 1);
  assert.equal(r.measure('あいう'), 54);
  assert.equal(measured, 1, '同じ文面で測り直している');
  r.measure('かきくけこ');
  assert.equal(measured, 2);
});

test('幅のキャッシュは際限なく溜まらない', () => {
  const { canvas } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(800, 600, 1);
  for (let i = 0; i < 600; i++) r.measure(`c${i}`);
  assert.ok(r.widthCache.size <= 501, `size=${r.widthCache.size}`);
});

test('リサイズすると幅のキャッシュは捨てる', () => {
  // font を再設定するので、同じ文面でも幅が変わり得る
  const { canvas } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(800, 600, 1);
  r.measure('あ');
  assert.equal(r.widthCache.size, 1);
  r.resize(1920, 1080, 2);
  assert.equal(r.widthCache.size, 0);
});

test('空の配列でも画面は消される', () => {
  const { canvas, calls } = fakeCanvas();
  const r = new Renderer(canvas);
  r.resize(800, 600, 1);
  calls.length = 0;
  r.draw([]);
  assert.deepEqual(calls.map((c) => c[0]), ['clearRect']);
});
