import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newEventId, newTrackId, newHandoffCode, slugFromName,
  postUrlFor, stageUrlFor, overlayUrlFor, eventUrlFor, shortUrl, ago, formatDate, withEnv,
  nextTrackName, isDefaultTrackName, compareTrackName,
} from '../../public/lib/ids.mjs';

test('IDに紛れる文字を使わない', () => {
  // 印刷して読み上げることがあるので 0/O、1/l/I を避ける
  const joined = Array.from({ length: 300 }, () => newEventId() + newTrackId()).join('');
  for (const bad of ['0', 'O', 'o', '1', 'l', 'I', 'i']) {
    assert.ok(!joined.includes(bad), `${bad} が入っている`);
  }
});

test('合言葉は大文字8文字で紛れる文字を使わない', () => {
  const codes = Array.from({ length: 300 }, () => newHandoffCode());
  for (const c of codes) {
    assert.equal(c.length, 8);
    assert.equal(c, c.toUpperCase());
  }
  for (const bad of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!codes.join('').includes(bad), `${bad} が入っている`);
  }
});

test('合言葉は十分にばらける', () => {
  const set = new Set(Array.from({ length: 500 }, () => newHandoffCode()));
  assert.equal(set.size, 500, `重複した: ${500 - set.size}件`);
});

test('IDはURLに入れて壊れない', () => {
  for (let i = 0; i < 200; i++) {
    const id = newEventId();
    assert.equal(encodeURIComponent(id), id, `要エスケープ: ${id}`);
  }
});

test('トラック名から読めるIDを作る', () => {
  assert.equal(slugFromName('Track A'), 'a');
  assert.equal(slugFromName('Track B'), 'b');
  assert.equal(slugFromName('会場2'), '2');
  assert.equal(slugFromName('Main'), null, '紛れる文字を含むので使わない');
});

test('名前からIDを作れないときは null を返す', () => {
  // 呼び出し側が乱数に落とす
  for (const v of ['', '   ', 'ホール', null, undefined, 'Track!!']) {
    assert.equal(slugFromName(v), null, `通ってしまった: ${v}`);
  }
});

test('URLを組み立てる', () => {
  assert.equal(postUrlFor('ev1', 'a', 'https://x.test'), 'https://x.test/post.html?e=ev1&t=a');
  assert.equal(overlayUrlFor('ev1', 'a', 'https://x.test'), 'https://x.test/overlay.html?e=ev1&t=a');
  assert.equal(eventUrlFor('ev1', 'https://x.test'), 'https://x.test/e/ev1');
});

test('登壇者のリンクは合言葉を載せない', () => {
  // 登壇者に操作権が無いので鍵を渡さない。何も開けない鍵は誤解を生む。
  const url = stageUrlFor('ev1', 'a', 'https://x.test');
  assert.equal(url, 'https://x.test/stage.html?e=ev1&t=a');
  assert.ok(!url.includes('k='), url);
});

test('URLに入れると危ない文字はエスケープする', () => {
  const url = postUrlFor('a/b?c=d&e', 'x y', 'https://x.test');
  assert.ok(!url.includes('&c='), `クエリが差し込まれている: ${url}`);
  assert.ok(url.includes('%2F') && url.includes('%20'), url);
});

test('長いURLは末尾を残して省く', () => {
  const s = shortUrl('https://df-hackathon-2026.web.app/stage.html?e=lt-winter&t=a');
  assert.ok(s.startsWith('…'), s);
  assert.ok(s.endsWith('t=a'), `末尾が切れている: ${s}`);
  assert.ok(s.length <= 35, `長すぎる: ${s.length}`);
});

test('短いURLはそのまま', () => {
  assert.equal(shortUrl('https://x.test/a'), 'x.test/a');
});

test('相対時刻は秒まで出す', () => {
  const now = 1_000_000_000_000;
  assert.equal(ago(now, now), '0秒前');
  assert.equal(ago(now - 3_000, now), '3秒前');
  assert.equal(ago(now - 59_000, now), '59秒前');
  assert.equal(ago(now - 60_000, now), '1分前');
  assert.equal(ago(now - 3_600_000, now), '1時間前');
  assert.equal(ago(now - 86_400_000, now), '1日前');
});

test('未来の時刻でも負にならない', () => {
  const now = 1_000_000_000_000;
  assert.equal(ago(now + 5_000, now), '0秒前');
});

test('日付に曜日を付ける', () => {
  assert.equal(formatDate('2026-12-12'), '2026/12/12（土）');
  assert.equal(formatDate('2027-01-23'), '2027/01/23（土）');
  assert.equal(formatDate(''), '');
  assert.equal(formatDate('へんな値'), 'へんな値');
});

test('画面を移っても接続先のクエリを引き継ぐ', () => {
  // 引き継がないと、移った先だけ別の環境に繋ぐことになる
  assert.equal(withEnv('/organizer.html?e=ev1', '?emu=1'), '/organizer.html?e=ev1&emu=1');
  assert.equal(withEnv('/post.html?e=ev1&t=a', '?emu=1'), '/post.html?e=ev1&t=a&emu=1');
});

test('本番では何も足さない', () => {
  assert.equal(withEnv('/organizer.html?e=ev1', ''), '/organizer.html?e=ev1');
  assert.equal(withEnv('/post.html?e=ev1&t=a', '?other=1'), '/post.html?e=ev1&t=a');
});

test('引き継ぐのは接続先を決めるものだけ', () => {
  // track や code をそのまま持ち回すと、別のトラックへ移れなくなる
  assert.equal(withEnv('/post.html?e=ev2&t=b', '?e=ev1&t=a&k=CODE'), '/post.html?e=ev2&t=b');
});

test('空のイベントなら Track A を勧める', () => {
  // 固定の例を置くと「Track D」のような嘘を出すことになる
  assert.equal(nextTrackName([]), 'Track A');
});

test('使われていない次の文字を勧める', () => {
  assert.equal(nextTrackName(['Track A']), 'Track B');
  assert.equal(nextTrackName(['Track A', 'Track B']), 'Track C');
});

test('抜けているところを先に埋める', () => {
  assert.equal(nextTrackName(['Track A', 'Track C']), 'Track B');
});

test('自由につけた名前とは衝突を見ない', () => {
  assert.equal(nextTrackName(['大ホール', '第2会議室']), 'Track A');
});

test('Z まで埋まったら番号に切り替える', () => {
  const all = Array.from({ length: 26 }, (_, i) => `Track ${String.fromCharCode(65 + i)}`);
  assert.equal(nextTrackName(all), 'Track 1');
  assert.equal(nextTrackName([...all, 'Track 1']), 'Track 2');
});

test('空や空白の名前は無視する', () => {
  assert.equal(nextTrackName(['', '  ', null, undefined]), 'Track A');
});

// --- トラックの並び ------------------------------------------------------
//
// 当日その表を見る人にとって意味があるのは、会場を見て決めた名前のほう。
// 仮の名前が上に来ると、自分が決めた行を目で探すことになる。

test('nextTrackName が作る形は既定とみなす', () => {
  for (const n of ['Track A', 'Track Z', 'Track 1', 'Track 999', 'Track']) {
    assert.equal(isDefaultTrackName(n), true, n);
  }
});

test('自分で付けた名前は既定ではない', () => {
  for (const n of ['2F ホール', '大講義室', 'トラックA', 'Main Hall', 'Track AA', 'Track 0', '']) {
    assert.equal(isDefaultTrackName(n), false, n);
  }
});

test('前後の空白は見ない（打ち込みの揺れで区分が変わらない）', () => {
  assert.equal(isDefaultTrackName('  Track A  '), true);
});

test('自分で付けた名前が先、既定は後', () => {
  const rows = ['Track B', '2F ホール', 'Track A', '大講義室'];
  assert.deepEqual(rows.sort(compareTrackName), ['2F ホール', '大講義室', 'Track A', 'Track B']);
});

test('同じ区分の中はこれまで通り名前順', () => {
  assert.deepEqual(['Track C', 'Track A', 'Track B'].sort(compareTrackName),
    ['Track A', 'Track B', 'Track C']);
  assert.deepEqual(['大講義室', '2F ホール'].sort(compareTrackName), ['2F ホール', '大講義室']);
});

test('名前が無くても落ちない', () => {
  assert.deepEqual([null, 'Track A', undefined].sort(compareTrackName).length, 3);
});
