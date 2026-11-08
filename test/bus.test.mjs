// Firestore 境界のテスト。エミュレータに対して実際に読み書きする。
//
// Rules のテスト（test/rules.test.mjs）は「守れているか」を見るもので、
// こちらは「アプリが意図どおり読み書きできるか」を見る。
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import * as sdk from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { createBus, createEventBus, PostError, MAX_TEXT } from '../public/lib/bus.mjs';

const env = await initializeTestEnvironment({
  projectId: 'bus-lab',
  firestore: {
    host: '127.0.0.1', port: 8181,
    rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
  },
});

let pass = 0, fail = 0;
const rows = [];
async function t(name, fn) {
  try { await fn(); pass++; rows.push(['ok  ', name, '']); }
  catch (e) { fail++; rows.push([' NG ', name, String(e?.message ?? e).slice(0, 160)]); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const dbOf = (uid) => env.authenticatedContext(uid).firestore();
const evBus = (uid) => createEventBus(sdk, { db: dbOf(uid), uid });
const bus = (uid, eventId, trackId, clock = { t: 0 }) =>
  createBus(sdk, { db: dbOf(uid), eventId, trackId, uid, now: () => clock.t });

/** 待つ代わりに、購読が最初の値を返すまで待つ。 */
function once(subscribe) {
  return new Promise((res, rej) => {
    const un = subscribe((v) => { if (v != null) { un(); res(v); } }, rej);
  });
}

// --- イベント -----------------------------------------------------------
await t('イベントを作ると購読で読める', async () => {
  const staff = evBus('staff1');
  await staff.createEvent('ev-a', { name: '学内LT大会 冬', heldOn: '2026-12-12' });
  const got = await once((cb, err) => staff.watchEvent('ev-a', cb, err));
  assert(got.name === '学内LT大会 冬', `name=${got.name}`);
  assert(got.heldOn === '2026-12-12', `heldOn=${got.heldOn}`);
});

await t('自分のイベントだけが一覧に出る', async () => {
  const mine = evBus('staff2'), other = evBus('staff3');
  await mine.createEvent('ev-mine', { name: 'わたしの会' });
  await other.createEvent('ev-other', { name: 'ひとの会' });
  await sleep(300);
  const list = await new Promise((res, rej) => {
    const un = mine.watchMyEvents((v) => { un(); res(v); }, rej);
  });
  const names = list.map((e) => e.name);
  assert(names.includes('わたしの会'), `入っていない: ${names}`);
  assert(!names.includes('ひとの会'), `他人のが入っている: ${names}`);
});

await t('イベント名を直せる', async () => {
  const staff = evBus('staff4');
  await staff.createEvent('ev-rename', { name: '仮' });
  await staff.renameEvent('ev-rename', { name: '本番', heldOn: '2027-03-03' });
  const d = (await staff.getEvent('ev-rename')).data();
  assert(d.name === '本番' && d.heldOn === '2027-03-03', JSON.stringify(d));
});

// --- トラック -----------------------------------------------------------
await t('運営はトラックを並べられる', async () => {
  const staff = evBus('staff5');
  await staff.createEvent('ev-tracks', { name: 'イベント' });
  for (const [id, name] of [['c', 'Track C'], ['a', 'Track A'], ['b', 'Track B']]) {
    await staff.createTrack('ev-tracks', id, { name });
  }
  await sleep(300);
  const list = await new Promise((res, rej) => {
    const un = staff.watchTracks('ev-tracks', (v) => { if (v.length === 3) { un(); res(v); } }, rej);
  });
  assert(list.map((t) => t.name).join(',') === 'Track A,Track B,Track C',
    `名前順になっていない: ${list.map((t) => t.name)}`);
});

await t('運営以外はトラックを足せない', async () => {
  const staff = evBus('staff6'), outsider = evBus('outsider1');
  await staff.createEvent('ev-guard', { name: 'イベント' });
  let denied = false;
  try { await outsider.createTrack('ev-guard', 'x', { name: 'Track X' }); }
  catch (e) { denied = e.code === 'permission-denied'; }
  assert(denied, '通ってしまった');
});

// --- 投稿と購読 ---------------------------------------------------------
await t('投稿が購読側に届く', async () => {
  const staff = evBus('staff7');
  await staff.createEvent('ev-post', { name: 'イベント' });
  await staff.createTrack('ev-post', 'a', { name: 'Track A' });

  const watcher = bus('staff7', 'ev-post', 'a');
  const track = await once((cb, err) => watcher.watchTrack(cb, err));
  const seen = [];
  const un = watcher.watchComments(track.sessionStartedAt, (c, m) => seen.push({ ...c, ...m }));
  await sleep(300);
  await bus('po1', 'ev-post', 'a').post('こんにちは');
  await sleep(800);
  un();

  const live = seen.filter((c) => !c.isBacklog);
  assert(live.length === 1, `届いた件数=${live.length}`);
  assert(live[0].text === 'こんにちは', `text=${live[0].text}`);
});

await t('最初のスナップショットは backlog として区別される', async () => {
  const staff = evBus('staff8');
  await staff.createEvent('ev-backlog', { name: 'イベント' });
  await staff.createTrack('ev-backlog', 'a', { name: 'Track A' });
  const watcher = bus('staff8', 'ev-backlog', 'a');
  const track = await once((cb, err) => watcher.watchTrack(cb, err));
  await bus('po2', 'ev-backlog', 'a').post('さき');
  await sleep(500);

  const seen = [];
  const un = watcher.watchComments(track.sessionStartedAt, (c, m) => seen.push({ ...c, ...m }));
  await sleep(700);
  un();
  assert(seen.length === 1 && seen[0].isBacklog === true, JSON.stringify(seen));
});

await t('前のセッションのコメントは購読に入らない', async () => {
  const staff = evBus('staff9');
  await staff.createEvent('ev-session', { name: 'イベント' });
  await staff.createTrack('ev-session', 'a', { name: 'Track A' });
  const sp = bus('staff9', 'ev-session', 'a');
  await bus('po3', 'ev-session', 'a').post('前の登壇のコメント');
  await sleep(400);

  await sp.startSession({ title: '次の登壇', speaker: 'わたし' });
  await sleep(400);
  const startedAt = (await sp.getTrack()).data().sessionStartedAt;

  const seen = [];
  const un = sp.watchComments(startedAt, (c) => seen.push(c.text));
  await sleep(700);
  un();
  assert(seen.length === 0, `残っている: ${seen}`);
});

// --- 入力の検証 ---------------------------------------------------------
await t('空文字はサーバへ行かずに落ちる', async () => {
  try { await bus('po4', 'ev-post', 'a').post('   '); throw new Error('通った'); }
  catch (e) { assert(e instanceof PostError && e.kind === 'empty', `kind=${e.kind}`); }
});

await t('61文字はサーバへ行かずに落ちる', async () => {
  try { await bus('po5', 'ev-post', 'a').post('あ'.repeat(MAX_TEXT + 1)); throw new Error('通った'); }
  catch (e) { assert(e instanceof PostError && e.kind === 'too-long', `kind=${e.kind}`); }
});

// --- クールダウン -------------------------------------------------------
await t('2秒以内の連投は cooldown として落ちる', async () => {
  const clock = { t: 0 };
  const po = bus('po6', 'ev-post', 'a', clock);
  await po.post('いちど');
  assert(po.cooldownRemaining() > 0, '残り時間が 0');
  try { await po.post('にかいめ'); throw new Error('通った'); }
  catch (e) { assert(e.kind === 'cooldown', `kind=${e.kind}`); }
});

await t('2秒経てば投稿できる', async () => {
  const clock = { t: 0 };
  const po = bus('po7', 'ev-post', 'a', clock);
  await po.post('いちど');
  clock.t += 2100;
  await sleep(2100);
  await po.post('にかいめ');
});

await t('サーバに弾かれたら手元の時刻は進めない', async () => {
  const clock = { t: 0 };
  const po = bus('po8', 'ev-post', 'a', clock);
  await po.post('いちど');
  clock.t += 2100;
  try { await po.post('はやすぎ'); } catch (e) { assert(e.kind === 'denied', `kind=${e.kind}`); }
  assert(po.cooldownRemaining() === 0, `残り=${po.cooldownRemaining()}`);
});

// --- 登壇の開始と終了 ---------------------------------------------------
await t('登壇を終えると投稿が止まる', async () => {
  const staff = evBus('staffA');
  await staff.createEvent('ev-end', { name: 'イベント' });
  await staff.createTrack('ev-end', 'a', { name: 'Track A' });
  const sp = bus('staffA', 'ev-end', 'a');
  const po = bus('poA', 'ev-end', 'a');
  const un = po.watchTrack(() => {});
  await sleep(300);
  await sp.endSession();
  await sleep(500);
  un();
  assert(po.isStopped === true, '停止が伝わっていない');
  try { await po.post('おそい'); throw new Error('通った'); }
  catch (e) { assert(e.kind === 'stopped', `kind=${e.kind}`); }
});

await t('次の登壇が始まると再スキャンなしで送れる', async () => {
  const staff = evBus('staffB');
  await staff.createEvent('ev-next', { name: 'イベント' });
  await staff.createTrack('ev-next', 'a', { name: 'Track A' });
  const sp = bus('staffB', 'ev-next', 'a');
  const po = bus('poB', 'ev-next', 'a');
  const un = po.watchTrack(() => {});
  await sleep(300);
  await sp.endSession();    await sleep(400);
  await sp.startSession({ title: '次の登壇' }); await sleep(500);
  un();
  assert(po.isStopped === false, '再開が伝わっていない');
  await po.post('おかえり');
});

// --- 引き継ぎ -----------------------------------------------------------
await t('リンクの合言葉で登壇者になれる', async () => {
  const staff = evBus('staffC');
  await staff.createEvent('ev-ho', { name: 'イベント' });
  await staff.createTrack('ev-ho', 'a', { name: 'Track A' });
  await staff.setTrackHandoff('ev-ho', 'a', 'CODE-42');

  const speaker = bus('spC', 'ev-ho', 'a');
  await speaker.claim('CODE-42');
  await speaker.startSession({ title: '引き継いだ登壇' });
  assert((await speaker.getTrack()).data().title === '引き継いだ登壇', '書けていない');
});

await t('誤った合言葉では登壇者になれない', async () => {
  const staff = evBus('staffD');
  await staff.createEvent('ev-ho2', { name: 'イベント' });
  await staff.createTrack('ev-ho2', 'a', { name: 'Track A' });
  await staff.setTrackHandoff('ev-ho2', 'a', 'RIGHT');
  let denied = false;
  try { await bus('spD', 'ev-ho2', 'a').claim('WRONG'); }
  catch (e) { denied = e.code === 'permission-denied'; }
  assert(denied, '通ってしまった');
});

await env.cleanup();
for (const [st, name, msg] of rows) console.log(`  ${st} ${name}${msg ? '\n         -> ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
