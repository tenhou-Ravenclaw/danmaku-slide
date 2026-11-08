// Firestore 境界のテスト。エミュレータに対して実際に読み書きする。
//
// Rules のテスト（test/rules.test.mjs）は「守れているか」を見るもので、
// こちらは「アプリが意図どおり読み書きできるか」を見る。
// 特に、Rules がバッチ形を要求していることと購読の形が噛み合っているかを確かめる。
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import * as sdk from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { createBus, PostError, MAX_TEXT } from '../public/lib/bus.mjs';

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

// 時刻を手で動かせる now を渡す（クールダウンの判定が実時間に縛られないように）
function busFor(uid, trackId, clock) {
  const db = env.authenticatedContext(uid).firestore();
  return createBus(sdk, { db, trackId, uid, now: () => clock.t });
}

// --- トラック作成と購読 -------------------------------------------------
await t('トラックを作ると購読で状態が取れる', async () => {
  const clock = { t: 0 };
  const b = busFor('sp1', 'tA', clock);
  await b.createTrack({ name: 'Track A', title: 'はじめの一歩' });

  const got = await new Promise((res, rej) => {
    const un = b.watchTrack((tr) => { if (tr) { un(); res(tr); } }, rej);
  });
  assert(got.name === 'Track A', `name=${got.name}`);
  assert(got.title === 'はじめの一歩', `title=${got.title}`);
  assert(got.stopped === false, 'stopped が true になっている');
  assert(got.sessionStartedAt != null, 'sessionStartedAt が無い');
});

// --- 投稿と購読が噛み合うか ---------------------------------------------
await t('投稿が購読側に届く', async () => {
  const clock = { t: 0 };
  const sp = busFor('sp2', 'tB', clock);
  await sp.createTrack({ name: 'Track B' });
  const snap = await sp.getTrack();
  const startedAt = snap.data().sessionStartedAt;

  const po = busFor('po2', 'tB', { t: 0 });
  const seen = [];
  const un = sp.watchComments(startedAt, (c, meta) => seen.push({ ...c, ...meta }));
  await sleep(300);                       // 最初のスナップショットを消化させる
  await po.post('こんにちは');
  await sleep(800);
  un();

  const live = seen.filter((c) => !c.isBacklog);
  assert(live.length === 1, `届いた件数=${live.length} (all=${seen.length})`);
  assert(live[0].text === 'こんにちは', `text=${live[0].text}`);
  assert(typeof live[0].id === 'string' && live[0].id.length > 0, 'id が無い');
});

await t('最初のスナップショットは backlog として区別される', async () => {
  const sp = busFor('sp3', 'tC', { t: 0 });
  await sp.createTrack({ name: 'Track C' });
  const startedAt = (await sp.getTrack()).data().sessionStartedAt;

  const po = busFor('po3', 'tC', { t: 0 });
  await po.post('さき');
  await sleep(400);

  const seen = [];
  const un = sp.watchComments(startedAt, (c, meta) => seen.push({ ...c, ...meta }));
  await sleep(600);
  un();
  assert(seen.length === 1, `件数=${seen.length}`);
  assert(seen[0].isBacklog === true, 'backlog として来ていない');
});

await t('backlog は古い順に返る', async () => {
  const sp = busFor('sp4', 'tD', { t: 0 });
  await sp.createTrack({ name: 'Track D' });
  const startedAt = (await sp.getTrack()).data().sessionStartedAt;

  // クールダウンを避けるため投稿者を分ける
  for (const [i, uid] of ['a', 'b', 'c'].entries()) {
    await busFor(`po4${uid}`, 'tD', { t: 0 }).post(`${i + 1}番目`);
    await sleep(60);
  }
  await sleep(400);

  const seen = [];
  const un = sp.watchComments(startedAt, (c) => seen.push(c.text));
  await sleep(700);
  un();
  assert(seen.length === 3, `件数=${seen.length}: ${seen}`);
  assert(seen.join(',') === '1番目,2番目,3番目', `順序=${seen}`);
});

// --- セッション境界 -----------------------------------------------------
await t('前のセッションのコメントは購読に入らない', async () => {
  const sp = busFor('sp5', 'tE', { t: 0 });
  await sp.createTrack({ name: 'Track E' });
  await busFor('po5', 'tE', { t: 0 }).post('前の登壇のコメント');
  await sleep(400);

  await sp.startSession({ title: '次の登壇' });     // sessionStartedAt が進む
  await sleep(300);
  const startedAt = (await sp.getTrack()).data().sessionStartedAt;

  const seen = [];
  const un = sp.watchComments(startedAt, (c) => seen.push(c.text));
  await sleep(600);
  un();
  assert(seen.length === 0, `残っている: ${seen}`);
});

// --- 入力の検証はサーバへ行く前に落とす ---------------------------------
await t('空文字はサーバへ行かずに落ちる', async () => {
  const b = busFor('po6', 'tB', { t: 0 });
  try { await b.post('   '); throw new Error('通ってしまった'); }
  catch (e) { assert(e instanceof PostError && e.kind === 'empty', `kind=${e.kind}`); }
});

await t('61文字はサーバへ行かずに落ちる', async () => {
  const b = busFor('po7', 'tB', { t: 0 });
  try { await b.post('あ'.repeat(MAX_TEXT + 1)); throw new Error('通ってしまった'); }
  catch (e) { assert(e instanceof PostError && e.kind === 'too-long', `kind=${e.kind}`); }
});

// --- クールダウン -------------------------------------------------------
await t('2秒以内の連投は cooldown として落ちる', async () => {
  const clock = { t: 0 };
  const sp = busFor('sp8', 'tF', clock);
  await sp.createTrack({ name: 'Track F' });
  const po = busFor('po8', 'tF', clock);

  await po.post('いちど');
  assert(po.cooldownRemaining() > 0, '残り時間が 0 になっている');
  try { await po.post('にかいめ'); throw new Error('通ってしまった'); }
  catch (e) { assert(e.kind === 'cooldown', `kind=${e.kind}`); }
});

await t('2秒経てば投稿できる', async () => {
  const clock = { t: 0 };
  const sp = busFor('sp9', 'tG', clock);
  await sp.createTrack({ name: 'Track G' });
  const po = busFor('po9', 'tG', clock);

  await po.post('いちど');
  clock.t += 2100;                       // 手元の時刻だけ進める
  assert(po.cooldownRemaining() === 0, `残り=${po.cooldownRemaining()}`);
  await sleep(2100);                     // サーバ側のクールダウンも待つ
  await po.post('にかいめ');
});

await t('サーバに弾かれたら手元の時刻は進めない', async () => {
  const clock = { t: 0 };
  const sp = busFor('spA', 'tH', clock);
  await sp.createTrack({ name: 'Track H' });
  const po = busFor('poA', 'tH', clock);

  await po.post('いちど');
  clock.t += 2100;
  // サーバ側はまだクールダウン中なので弾かれる
  try { await po.post('はやすぎ'); } catch (e) { assert(e.kind === 'denied', `kind=${e.kind}`); }
  // 弾かれた直後も残り時間は 0 のまま（無駄に待たせない）
  assert(po.cooldownRemaining() === 0, `残り=${po.cooldownRemaining()}`);
});

// --- 停止 ---------------------------------------------------------------
await t('停止後の投稿は stopped として落ちる', async () => {
  const clock = { t: 0 };
  const sp = busFor('spB', 'tI', clock);
  await sp.createTrack({ name: 'Track I' });
  const po = busFor('poB', 'tI', clock);

  const un = po.watchTrack(() => {});
  await sleep(300);
  await sp.stop();
  await sleep(500);
  un();

  assert(po.isStopped === true, '停止が手元に伝わっていない');
  try { await po.post('おそい'); throw new Error('通ってしまった'); }
  catch (e) { assert(e.kind === 'stopped', `kind=${e.kind}`); }
});

await t('再開すれば投稿できる', async () => {
  const clock = { t: 0 };
  const sp = busFor('spC', 'tJ', clock);
  await sp.createTrack({ name: 'Track J' });
  const po = busFor('poC', 'tJ', clock);
  const un = po.watchTrack(() => {});
  await sleep(300);
  await sp.stop();  await sleep(400);
  await sp.resume(); await sleep(400);
  un();
  assert(po.isStopped === false, '再開が伝わっていない');
  await po.post('おかえり');
});

// --- 引き継ぎ -----------------------------------------------------------
await t('引き継ぎコードで運用者になれる', async () => {
  const sp = busFor('spD', 'tK', { t: 0 });
  await sp.createTrack({ name: 'Track K' });
  await sp.setHandoffCode('CODE-42');

  const next = busFor('spE', 'tK', { t: 0 });
  await next.claimOperator('CODE-42');
  await next.startSession({ title: '引き継いだ登壇' });   // 運用者として書ける
  const d = (await sp.getTrack()).data();
  assert(d.title === '引き継いだ登壇', `title=${d.title}`);
  assert(d.ownerUid === 'spD', `ownerUid が変わった: ${d.ownerUid}`);
});

await t('誤ったコードでは運用者になれない', async () => {
  const sp = busFor('spF', 'tL', { t: 0 });
  await sp.createTrack({ name: 'Track L' });
  await sp.setHandoffCode('RIGHT');
  const bad = busFor('spG', 'tL', { t: 0 });
  try { await bad.claimOperator('WRONG'); throw new Error('通ってしまった'); }
  catch (e) { assert(e.code === 'permission-denied', `code=${e.code}`); }
});

await env.cleanup();
for (const [st, name, msg] of rows) console.log(`  ${st} ${name}${msg ? '\n         -> ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
