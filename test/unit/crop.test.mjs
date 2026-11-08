import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContentRect } from '../../public/lib/capture.mjs';

/** 縁が color、中身が inner の画像を作る。 */
function img(w, h, pad, color = [0, 0, 0], inner = [200, 30, 30]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const isEdge = x < pad.left || x >= w - pad.right || y < pad.top || y >= h - pad.bottom;
    const c = isEdge ? color : inner;
    data[i] = c[0]; data[i+1] = c[1]; data[i+2] = c[2]; data[i+3] = 255;
  }
  return { data, width: w, height: h };
}

test('左右の黒帯を切り取る', () => {
  const r = detectContentRect(img(100, 60, { left: 20, right: 20, top: 0, bottom: 0 }));
  assert.deepEqual(r, { x: 20, y: 0, width: 60, height: 60 });
});

test('上下の黒帯を切り取る', () => {
  const r = detectContentRect(img(100, 100, { left: 0, right: 0, top: 25, bottom: 25 }));
  assert.deepEqual(r, { x: 0, y: 25, width: 100, height: 50 });
});

test('四方の帯を切り取る', () => {
  const r = detectContentRect(img(120, 80, { left: 10, right: 10, top: 8, bottom: 8 }));
  assert.deepEqual(r, { x: 10, y: 8, width: 100, height: 64 });
});

test('帯が無ければ何も切らない', () => {
  const r = detectContentRect(img(100, 60, { left: 0, right: 0, top: 0, bottom: 0 }));
  assert.deepEqual(r, { x: 0, y: 0, width: 100, height: 60 });
});

test('白い帯でも切り取る', () => {
  // 黒決め打ちにしない。明るいスライドツールもある。
  const r = detectContentRect(img(100, 60, { left: 15, right: 15, top: 0, bottom: 0 }, [255,255,255], [20,20,20]));
  assert.deepEqual(r, { x: 15, y: 0, width: 70, height: 60 });
});

test('わずかな色ムラは帯とみなす', () => {
  // 圧縮のノイズで完全な同色にならないことがある
  const im = img(100, 60, { left: 20, right: 20, top: 0, bottom: 0 }, [4, 2, 3]);
  const r = detectContentRect(im, 10);
  assert.deepEqual(r, { x: 20, y: 0, width: 60, height: 60 });
});

test('四隅の色が揃っていなければ触らない', () => {
  // 縁取りではなくグラデーションや中身そのもの
  const im = img(100, 60, { left: 20, right: 20, top: 0, bottom: 0 });
  im.data[0] = 255; im.data[1] = 255; im.data[2] = 255;   // 左上だけ白
  assert.deepEqual(detectContentRect(im), { x: 0, y: 0, width: 100, height: 60 });
});

test('全面が一様なら切らない', () => {
  // 真っ暗なスライドを切ると何も映らなくなる
  const im = img(100, 60, { left: 50, right: 50, top: 30, bottom: 30 });
  const r = detectContentRect(im);
  assert.deepEqual(r, { x: 0, y: 0, width: 100, height: 60 });
});

test('中身が極端に小さいときは切らない', () => {
  // 検出がおかしいときに巨大拡大して壊すより、そのまま出す
  const im = img(200, 200, { left: 95, right: 95, top: 95, bottom: 95 });
  const r = detectContentRect(im);
  assert.deepEqual(r, { x: 0, y: 0, width: 200, height: 200 });
});

test('小さすぎる画像は触らない', () => {
  assert.deepEqual(detectContentRect({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    { x: 0, y: 0, width: 1, height: 1 });
});

test('実際にありがちな形: 16:9 の枠に 4:3 のスライド', () => {
  const r = detectContentRect(img(160, 90, { left: 20, right: 20, top: 0, bottom: 0 }));
  assert.deepEqual(r, { x: 20, y: 0, width: 120, height: 90 });
  assert.ok(Math.abs(r.width / r.height - 4 / 3) < 0.01, `比が 4:3 でない: ${r.width}/${r.height}`);
});

test('実際にありがちな形: 共有バーのぶん上が削れている', () => {
  // タブ取り込みだと上に帯が入る。中身の上端がそのぶん下がる。
  const r = detectContentRect(img(160, 100, { left: 20, right: 20, top: 10, bottom: 0 }));
  assert.deepEqual(r, { x: 20, y: 10, width: 120, height: 90 });
});
