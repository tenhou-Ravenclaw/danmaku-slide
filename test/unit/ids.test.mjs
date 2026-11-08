import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newEventId, newTrackId, newHandoffCode, slugFromName,
  postUrlFor, stageUrlFor, overlayUrlFor, eventUrlFor, shortUrl, ago, formatDate, withEnv,
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

test('登壇者のリンクは合言葉を載せる', () => {
  assert.equal(stageUrlFor('ev1', 'a', 'CODE', 'https://x.test'),
    'https://x.test/stage.html?e=ev1&t=a&k=CODE');
  assert.equal(stageUrlFor('ev1', 'a', null, 'https://x.test'),
    'https://x.test/stage.html?e=ev1&t=a');
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
