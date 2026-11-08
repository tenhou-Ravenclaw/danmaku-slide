import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTrackId, newHandoffCode, postUrlFor, overlayUrlFor } from '../../public/lib/speaker.mjs';

// 決まった並びを返す乱数。生成結果を固定して確かめる。
function seeded(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('トラックIDに紛れる文字を使わない', () => {
  // 印刷して読み上げることがあるので 0/O、1/l/I を避ける
  const ids = [];
  for (let i = 0; i < 200; i++) ids.push(newTrackId());
  const joined = ids.join('');
  for (const bad of ['0', 'O', 'o', '1', 'l', 'I', 'i']) {
    assert.ok(!joined.includes(bad), `${bad} が入っている`);
  }
});

test('トラックIDは8文字', () => {
  assert.equal(newTrackId().length, 8);
});

test('トラックIDはURLに入れて壊れない', () => {
  for (let i = 0; i < 100; i++) {
    const id = newTrackId();
    assert.equal(encodeURIComponent(id), id, `要エスケープ: ${id}`);
  }
});

test('同じ乱数からは同じIDが出る', () => {
  assert.equal(newTrackId(seeded([0])), newTrackId(seeded([0])));
  assert.notEqual(newTrackId(seeded([0])), newTrackId(seeded([0.99])));
});

test('引き継ぎコードは大文字6文字で紛れる文字を使わない', () => {
  const codes = [];
  for (let i = 0; i < 200; i++) codes.push(newHandoffCode());
  for (const c of codes) {
    assert.equal(c.length, 6);
    assert.equal(c, c.toUpperCase());
  }
  const joined = codes.join('');
  for (const bad of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!joined.includes(bad), `${bad} が入っている`);
  }
});

test('引き継ぎコードは十分にばらける', () => {
  const set = new Set();
  for (let i = 0; i < 500; i++) set.add(newHandoffCode());
  // 31^6 ≒ 8.9億 なので、500件で重複が出たら生成が偏っている
  assert.equal(set.size, 500, `重複した: ${500 - set.size}件`);
});

test('投稿URLと弾幕URLを組み立てる', () => {
  assert.equal(postUrlFor('abc', 'https://x.test'), 'https://x.test/post.html?track=abc');
  assert.equal(overlayUrlFor('abc', 'https://x.test'), 'https://x.test/overlay.html?track=abc');
});

test('URLに入れると危ない文字はエスケープする', () => {
  const url = postUrlFor('a/b?c=d&e', 'https://x.test');
  assert.equal(url, 'https://x.test/post.html?track=a%2Fb%3Fc%3Dd%26e');
  assert.ok(!url.includes('&e'), 'クエリが差し込まれている');
});
