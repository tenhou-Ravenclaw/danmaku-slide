import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DanmakuFlow, DEFAULTS } from '../../public/lib/danmaku.mjs';

// 1920x1080、1行52px、上8px → 20行
const W = 1920, H = 1080;
const LANES = Math.floor((H - DEFAULTS.topMargin) / DEFAULTS.lineHeight);

function flow(opts) {
  const f = new DanmakuFlow(opts);
  f.resize(W, H);
  return f;
}
let n = 0;
const c = (text = 'あ', width = 200) => ({ id: `c${++n}`, text, width });

/**
 * 同じ行に乗っているもの同士が重なっていないことを確かめる。
 * 行ごとに x で並べ、隣り合う2つの間隔だけを見る。
 * 「各行の最後の1件」だけを覚える書き方だと3件以上乗ったときに見逃す。
 */
function assertNoOverlap(items, t) {
  const byLane = new Map();
  for (const it of items) {
    if (!byLane.has(it.lane)) byLane.set(it.lane, []);
    byLane.get(it.lane).push(it);
  }
  for (const [lane, list] of byLane) {
    list.sort((a, b) => a.x - b.x);
    for (let i = 1; i < list.length; i++) {
      const l = list[i - 1], r = list[i];
      assert.ok(l.x + l.width <= r.x,
        `t=${t} lane=${lane}: ${l.id}[${l.x}..${l.x + l.width}] と ${r.id}[${r.x}..] が重なった`);
    }
  }
}

test('画面の高さから行数が決まる', () => {
  const f = flow();
  assert.equal(f.laneCount, LANES);
  assert.equal(LANES, 20);
});

test('行の y は重ならず、画面内に収まる', () => {
  const f = flow();
  const ys = [...Array(f.laneCount)].map((_, i) => f.laneY(i));
  assert.equal(new Set(ys).size, ys.length);
  assert.ok(ys[0] >= 0);
  assert.ok(ys.at(-1) + DEFAULTS.lineHeight <= H);
});

test('最初のコメントは即座に流れ始め、右端から入る', () => {
  const f = flow();
  assert.equal(f.add(c(), 0), 'placed');
  const [it] = f.step(0);
  assert.equal(it.x, W);
});

test('一定速度で左に進む', () => {
  const f = flow();
  f.add(c(), 0);
  assert.equal(f.step(1000)[0].x, W - DEFAULTS.speed);
  assert.equal(f.step(2000)[0].x, W - DEFAULTS.speed * 2);
});

test('左端を抜けきったら消える', () => {
  const f = flow();
  f.add(c('あ', 200), 0);
  // 幅200が右端1920から完全に抜けるのは (1920+200)/180 秒後
  const outMs = ((W + 200) / DEFAULTS.speed) * 1000;
  assert.equal(f.step(outMs - 100).length, 1);
  assert.equal(f.step(outMs + 100).length, 0);
});

test('同じ id は二度流れない', () => {
  const f = flow();
  const dup = { id: 'same', text: 'あ', width: 200 };
  assert.equal(f.add(dup, 0), 'placed');
  assert.equal(f.add(dup, 0), 'dup');
  assert.equal(f.step(0).length, 1);
});

test('行はラウンドロビンで使われ、偏らない', () => {
  // 同時に行数ぶん投げれば全行に散る
  const f = flow();
  for (let i = 0; i < f.laneCount; i++) assert.equal(f.add(c(), 0), 'placed');
  const used = new Set(f.step(0).map((it) => it.lane));
  assert.equal(used.size, f.laneCount);
});

test('流量が少なくても上の行だけに固まらない', () => {
  // 1行が空くより十分に遅い間隔で投げても、使われる行が回っていく
  const f = flow();
  const used = new Set();
  for (let i = 0; i < 10; i++) {
    const t = i * 20000;   // 行は確実に空いている
    f.add(c(), t);
    f.step(t).forEach((it) => used.add(it.lane));
  }
  assert.equal(used.size, 10, `使われた行: ${[...used].sort((a, b) => a - b)}`);
});

test('同じ行では前のコメントと重ならない', () => {
  // 全行を埋めてから、1行目が空く直前と直後で挙動が変わることを見る
  const f = flow({ waitMs: 1e9 });
  for (let i = 0; i < f.laneCount; i++) f.add(c('あ', 300), 0);
  const freeAt = ((300 + DEFAULTS.gap) / DEFAULTS.speed) * 1000;

  assert.equal(f.add(c('あ', 300), freeAt - 1), 'queued');

  const f2 = flow({ waitMs: 1e9 });
  for (let i = 0; i < f2.laneCount; i++) f2.add(c('あ', 300), 0);
  assert.equal(f2.add(c('あ', 300), freeAt + 1), 'placed');
});

test('同じ行に入った2つは画面上で必ず離れている', () => {
  const f = flow({ waitMs: 1e9 });
  for (let i = 0; i < f.laneCount; i++) f.add(c('あ', 300), 0);
  const freeAt = ((300 + DEFAULTS.gap) / DEFAULTS.speed) * 1000;
  f.add(c('あ', 300), freeAt);

  // 以降どの時点でも、同じ行のものは重ならない
  for (let t = freeAt; t < freeAt + 15000; t += 100) {
    assertNoOverlap(f.step(t), t);
  }
});

test('行が埋まっていれば待機列に入る', () => {
  const f = flow();
  for (let i = 0; i < f.laneCount; i++) assert.equal(f.add(c('あ', 400), 0), 'placed');
  assert.equal(f.add(c('あ', 400), 0), 'queued');
  assert.equal(f.pendingCount, 1);
});

test('待機中のものは行が空き次第流れる', () => {
  const f = flow({ waitMs: 1e9 });
  for (let i = 0; i < f.laneCount; i++) f.add(c('あ', 300), 0);
  f.add(c('あ', 300), 0);
  const freeAt = ((300 + DEFAULTS.gap) / DEFAULTS.speed) * 1000;

  f.step(freeAt - 1);
  assert.equal(f.pendingCount, 1);
  f.step(freeAt + 1);
  assert.equal(f.pendingCount, 0);
  assert.equal(f.dropped, 0);
});

test('待たせすぎたものは捨てる', () => {
  // 行が絶対に空かない状況を作る
  const f = flow({ speed: 1, waitMs: 3000 });
  for (let i = 0; i < f.laneCount; i++) f.add(c('あ', 1e6), 0);
  f.add(c('あ', 1e6), 0);
  assert.equal(f.pendingCount, 1);

  f.step(2999);
  assert.equal(f.dropped, 0, '3秒以内は捨てない');
  f.step(3001);
  assert.equal(f.dropped, 1);
  assert.equal(f.pendingCount, 0);
});

test('待機列は古い順に捌かれる', () => {
  // 空く行が1本しかない状況を作る。全行を同じ幅で埋めると全行が同時に空いて
  // 待機中のものが一斉に流れてしまい、順序が観測できない。
  const f = new DanmakuFlow({ waitMs: 1e9 });
  f.resize(W, DEFAULTS.topMargin + DEFAULTS.lineHeight);
  assert.equal(f.laneCount, 1);

  f.add({ id: 'running', text: 'あ', width: 300 }, 0);
  f.add({ id: 'first', text: 'あ', width: 300 }, 0);
  f.add({ id: 'second', text: 'あ', width: 300 }, 100);
  assert.equal(f.pendingCount, 2);

  const freeAt = ((300 + DEFAULTS.gap) / DEFAULTS.speed) * 1000;
  const ids = f.step(freeAt + 1).map((it) => it.id);
  assert.ok(ids.includes('first'), '先に来たものが先に流れる');
  assert.ok(!ids.includes('second'), '後から来たものは待たされる');
  assert.equal(f.pendingCount, 1);
});

test('markSeen したものは流れない', () => {
  const f = flow();
  f.markSeen('old');
  assert.equal(f.add({ id: 'old', text: 'あ', width: 200 }, 0), 'dup');
  assert.equal(f.step(0).length, 0);
});

test('markSeen は流れているものに影響しない', () => {
  const f = flow();
  f.add({ id: 'live', text: 'あ', width: 200 }, 0);
  f.markSeen('other');
  assert.equal(f.step(0).length, 1);
});

test('画面サイズが変わると行数が変わる', () => {
  const f = flow();
  assert.equal(f.laneCount, 20);
  f.resize(1280, 400);
  assert.equal(f.laneCount, Math.floor((400 - DEFAULTS.topMargin) / DEFAULTS.lineHeight));
  assert.ok(f.laneY(f.laneCount - 1) + DEFAULTS.lineHeight <= 400);
});

test('極端に低い画面でも必ず1行は確保する', () => {
  const f = new DanmakuFlow();
  f.resize(1280, 10);
  assert.equal(f.laneCount, 1);
  assert.equal(f.add(c(), 0), 'placed');
});

test('内部で現在時刻を読まない', () => {
  // Date.now を壊しても動くこと。壊れるならロジックが時計に依存している
  const real = Date.now;
  Date.now = () => { throw new Error('ロジックが Date.now を呼んでいる'); };
  try {
    const f = flow();
    f.add(c(), 0);
    f.step(1000);
  } finally {
    Date.now = real;
  }
});

test('PoC で出た偏りの再発防止: 毎秒5件を30秒流して全行が使われる', () => {
  // PoC では毎回 lane 0 から探していたため、この流量で上の数行しか使われなかった。
  const f = flow();
  const used = new Set();
  let m = 0;
  for (let t = 0; t <= 30000; t += 200) {   // 200ms ごと = 毎秒5件
    f.add({ id: `p${++m}`, text: 'テストコメント', width: 260 }, t);
    f.step(t).forEach((it) => used.add(it.lane));
  }
  assert.equal(used.size, f.laneCount,
    `使われた行 ${used.size}/${f.laneCount}: ${[...used].sort((a, b) => a - b)}`);
});

test('同じ行に2つ以上が同時に乗ることはない（長時間）', () => {
  const f = flow();
  let m = 0;
  for (let t = 0; t <= 60000; t += 100) {
    if (t % 200 === 0) f.add({ id: `q${++m}`, text: 'あ', width: 260 }, t);
    assertNoOverlap(f.step(t), t);
  }
});
