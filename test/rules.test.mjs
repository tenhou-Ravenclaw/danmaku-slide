import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, updateDoc, deleteDoc, getDoc, collection, getDocs,
  query, limit, serverTimestamp, writeBatch, Timestamp
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';

const env = await initializeTestEnvironment({
  projectId: 'rules-lab',
  firestore: { host: '127.0.0.1', port: 8181,
    rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
});

let pass = 0, fail = 0;
const rows = [];
async function t(name, fn) {
  try { await fn(); pass++; rows.push(['ok  ', name, '']); }
  catch (e) { fail++; rows.push([' NG ', name, String(e.message || e).slice(0, 140)]); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- seed ---------------------------------------------------------------
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'events/ev1'), {
    name: '学内LT大会 冬', heldOn: '2026-12-12', ownerUid: 'staff', createdAt: Timestamp.now(),
  });
  await setDoc(doc(db, 'events/ev1/private/handoff'), { code: 'EVENT-CODE' });
  await setDoc(doc(db, 'events/ev1/tracks/tA'), {
    // 投稿を見るテストが多いので、種は登壇中にしておく
    name: 'Track A', stopped: false, live: true,
    sessionStartedAt: Timestamp.now(), createdAt: Timestamp.now(),
  });
  await setDoc(doc(db, 'events/ev1/tracks/tA/private/handoff'), { code: 'TRACK-A-CODE' });
  await setDoc(doc(db, 'events/ev1/tracks/tA/comments/c1'), { text: 'hello', createdAt: Timestamp.now() });
  await setDoc(doc(db, 'events/ev1/tracks/tStopped'), {
    name: 'Track Z', stopped: true, live: false,
    sessionStartedAt: Timestamp.now(), createdAt: Timestamp.now(),
  });
});

const anon = () => env.unauthenticatedContext().firestore();
/** 匿名サインイン。観客と登壇者はこちら。 */
const as = (uid) =>
  env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
/** 本人確認できる人。運営はこちら。 */
const asStaff = (uid) =>
  env.authenticatedContext(uid, { firebase: { sign_in_provider: 'google.com' } }).firestore();

// 投稿は「コメント + posters」のバッチ。アプリ側もこの形で書く。
function post(db, trackId, uid, text, eventId = 'ev1') {
  const base = `events/${eventId}/tracks/${trackId}`;
  const b = writeBatch(db);
  b.set(doc(collection(db, `${base}/comments`)), { text, createdAt: serverTimestamp() });
  b.set(doc(db, `${base}/posters/${uid}`), { lastPostAt: serverTimestamp() });
  return b.commit();
}

// --- T1: 未認証を落とす -------------------------------------------------
await t('T1 未認証はイベントを読めない', () => assertFails(getDoc(doc(anon(), 'events/ev1'))));
await t('T1 未認証はトラックを読めない', () => assertFails(getDoc(doc(anon(), 'events/ev1/tracks/tA'))));
await t('T1 未認証はコメントを読めない',
  () => assertFails(getDocs(query(collection(anon(), 'events/ev1/tracks/tA/comments'), limit(50)))));
await t('T1 未認証は投稿できない', () => assertFails(post(anon(), 'tA', 'nobody', 'hi')));

// --- EV: イベント -------------------------------------------------------
await t('EV 認証済みならイベントを作れる', () => assertSucceeds(setDoc(doc(asStaff('u1'), 'events/mine'), {
  name: 'My Event', heldOn: '2027-01-01', ownerUid: 'u1', createdAt: serverTimestamp() })));
await t('EV 作成時に ownerUid を偽装できない', () => assertFails(setDoc(doc(asStaff('u1'), 'events/forged'), {
  name: 'X', heldOn: '2027-01-01', ownerUid: 'victim', createdAt: serverTimestamp() })));
await t('EV 他人はイベント名を変えられない',
  () => assertFails(updateDoc(doc(asStaff('attacker'), 'events/ev1'), { name: 'のっとり' })));
await t('EV owner はイベント名を変えられる',
  () => assertSucceeds(updateDoc(doc(asStaff('staff'), 'events/ev1'), { name: '学内LT大会 冬' })));
await t('EV owner でも ownerUid は奪えない',
  () => assertFails(updateDoc(doc(asStaff('staff'), 'events/ev1'), { ownerUid: 'other' })));
await t('EV 他人はイベントを消せない', () => assertFails(deleteDoc(doc(asStaff('attacker'), 'events/ev1'))));
await t('EV 一覧の大量取得は落ちる',
  () => assertFails(getDocs(query(collection(asStaff('u1'), 'events'), limit(500)))));

await t('EV 匿名ではイベントを作れない', () => assertFails(setDoc(doc(as('anon1'), 'events/byanon'), {
  name: '匿名の会', heldOn: '', ownerUid: 'anon1', createdAt: serverTimestamp() })));
await t('EV 匿名ではイベント名を変えられない',
  () => assertFails(updateDoc(doc(as('staff'), 'events/ev1'), { name: '匿名から' })));
await t('EV 匿名ではイベントを消せない', () => assertFails(deleteDoc(doc(as('staff'), 'events/ev1'))));

// --- TR: トラック -------------------------------------------------------
await t('TR 運営はトラックを作れる', () => assertSucceeds(setDoc(doc(asStaff('staff'), 'events/ev1/tracks/tNew'), {
  name: 'Track D', stopped: false, live: false, live: false,
  sessionStartedAt: serverTimestamp(), createdAt: serverTimestamp() })));
await t('TR 運営以外はトラックを作れない',
  () => assertFails(setDoc(doc(asStaff('attacker'), 'events/ev1/tracks/tBad'), {
    name: 'Track X', stopped: false, live: false,
    sessionStartedAt: serverTimestamp(), createdAt: serverTimestamp() })));
await t('TR 作成時に live を true にはできない',
  () => assertFails(setDoc(doc(asStaff('staff'), 'events/ev1/tracks/tLive'), {
    name: 'Track L', stopped: false, live: true,
    sessionStartedAt: serverTimestamp(), createdAt: serverTimestamp() })));
await t('TR 停止状態を作成時に true にはできない',
  () => assertFails(setDoc(doc(asStaff('staff'), 'events/ev1/tracks/tBad2'), {
    name: 'Track X', stopped: true, live: false,
    sessionStartedAt: serverTimestamp(), createdAt: serverTimestamp() })));
await t('TR 関係ない人は stopped を書けない',
  () => assertFails(updateDoc(doc(as('attacker'), 'events/ev1/tracks/tA'), { stopped: true })));
await t('TR 他人は sessionStartedAt を書けない',
  () => assertFails(updateDoc(doc(as('attacker'), 'events/ev1/tracks/tA'), { sessionStartedAt: serverTimestamp() })));

await t('TR 演題は持たない（書こうとすると落ちる）',
  () => assertFails(updateDoc(doc(asStaff('staff'), 'events/ev1/tracks/tA'), { title: 'はじめてのLT' })));
await t('TR createdAt は書き換えられない',
  () => assertFails(updateDoc(doc(asStaff('staff'), 'events/ev1/tracks/tA'), { createdAt: serverTimestamp() })));
await t('TR 名前は後から変えられない',
  () => assertFails(updateDoc(doc(asStaff('staff'), 'events/ev1/tracks/tA'), { name: 'Track ZZ' })));
await t('TR 他人はトラックを消せない',
  () => assertFails(deleteDoc(doc(asStaff('attacker'), 'events/ev1/tracks/tA'))));

await t('TR 匿名ではトラックを作れない',
  () => assertFails(setDoc(doc(as('staff'), 'events/ev1/tracks/tAnon'), {
    name: 'Track Anon', stopped: false, live: false,
    sessionStartedAt: serverTimestamp(), createdAt: serverTimestamp() })));
await t('TR 匿名ではトラックを消せない',
  () => assertFails(deleteDoc(doc(as('staff'), 'events/ev1/tracks/tStopped'))));
await t('TR 運営はトラックを消せる', async () => {
  await assertSucceeds(setDoc(doc(asStaff('staff'), 'events/ev1/tracks/tDel'), {
    name: 'Track Del', stopped: false, live: false,
    sessionStartedAt: serverTimestamp(), createdAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(asStaff('staff'), 'events/ev1/tracks/tDel')));
});
await t('TR 匿名の登壇者でも開始・終了はできる', async () => {
  // 登壇中に本人確認を挟むのは現実的でない。合言葉で足りる。
  await assertSucceeds(setDoc(doc(as('sp9'), 'events/ev1/tracks/tA/operators/sp9'), { code: 'TRACK-A-CODE' }));
  await assertSucceeds(updateDoc(doc(as('sp9'), 'events/ev1/tracks/tA'),
    { sessionStartedAt: serverTimestamp(), live: true }));
  await assertSucceeds(updateDoc(doc(as('sp9'), 'events/ev1/tracks/tA'), { live: false }));
});

await t('TR 登壇者は投稿を止められない', async () => {
  // 止めるのは運営の操作。荒らしへの対処なので登壇者には持たせない。
  await assertFails(updateDoc(doc(as('sp9'), 'events/ev1/tracks/tA'), { stopped: true }));
});

await t('TR 運営が止めたものを登壇者は戻せない', async () => {
  await assertSucceeds(updateDoc(doc(asStaff('staff'), 'events/ev1/tracks/tA'), { stopped: true }));
  await assertFails(updateDoc(doc(as('sp9'), 'events/ev1/tracks/tA'), { stopped: false }));
  // 登壇者は自分の開始・終了は続けられる
  await assertSucceeds(updateDoc(doc(as('sp9'), 'events/ev1/tracks/tA'), { live: false }));
  await assertSucceeds(updateDoc(doc(asStaff('staff'), 'events/ev1/tracks/tA'), { stopped: false }));
});

await t('TR 運営は止めたり戻したりできる', async () => {
  await assertSucceeds(updateDoc(doc(asStaff('staff'), 'events/ev1/tracks/tA'), { stopped: true }));
  await assertSucceeds(updateDoc(doc(asStaff('staff'), 'events/ev1/tracks/tA'), { stopped: false }));
});

// --- HO: 引き継ぎ -------------------------------------------------------
await t('HO イベントの引き継ぎコードは誰も読めない',
  () => assertFails(getDoc(doc(as('attacker'), 'events/ev1/private/handoff'))));
await t('HO owner 自身も読めない',
  () => assertFails(getDoc(doc(asStaff('staff'), 'events/ev1/private/handoff'))));
await t('HO owner 以外は private に書けない',
  () => assertFails(setDoc(doc(asStaff('attacker'), 'events/ev1/private/handoff'), { code: 'X' })));
await t('HO 誤コードでは運営を手伝えない',
  () => assertFails(setDoc(doc(as('helper'), 'events/ev1/operators/helper'), { code: 'WRONG' })));
await t('HO 正コードで運営を手伝える',
  () => assertSucceeds(setDoc(doc(as('helper'), 'events/ev1/operators/helper'), { code: 'EVENT-CODE' })));
await t('HO 運営を手伝う人は投稿を止められる',
  () => assertSucceeds(updateDoc(doc(as('helper'), 'events/ev1/tracks/tA'), { stopped: false })));
await t('HO 手伝う人でも匿名ではイベント名を変えられない',
  () => assertFails(updateDoc(doc(as('helper'), 'events/ev1'), { name: '手伝いから' })));

await t('HO トラックの引き継ぎコードは誰も読めない',
  () => assertFails(getDoc(doc(as('speaker1'), 'events/ev1/tracks/tA/private/handoff'))));
await t('HO 誤コードでは登壇者になれない',
  () => assertFails(setDoc(doc(as('speaker1'), 'events/ev1/tracks/tA/operators/speaker1'), { code: 'WRONG' })));
await t('HO 他人のUIDで登録できない',
  () => assertFails(setDoc(doc(as('speaker1'), 'events/ev1/tracks/tA/operators/speaker2'), { code: 'TRACK-A-CODE' })));
await t('HO 正コードで登壇者になれる',
  () => assertSucceeds(setDoc(doc(as('speaker1'), 'events/ev1/tracks/tA/operators/speaker1'), { code: 'TRACK-A-CODE' })));
await t('HO 登壇者は自分のトラックを操作できる',
  () => assertSucceeds(updateDoc(doc(as('speaker1'), 'events/ev1/tracks/tA'), { sessionStartedAt: serverTimestamp() })));
await t('HO 登壇者は他のトラックを操作できない',
  () => assertFails(updateDoc(doc(as('speaker1'), 'events/ev1/tracks/tStopped'), { stopped: false })));
await t('HO 運用者登録は上書きできない',
  () => assertFails(updateDoc(doc(as('speaker1'), 'events/ev1/tracks/tA/operators/speaker1'), { code: 'TRACK-A-CODE' })));

// 投稿のテストは専用のトラックでやる。
// 他のテストが tA の live を落とすと、ここが巻き添えで落ちる。
await env.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), 'events/ev1/tracks/tLive'), {
    name: 'Track Live', stopped: false, live: true,
    sessionStartedAt: Timestamp.fromMillis(0), createdAt: Timestamp.now(),
  });
});

// --- T5: 入力の形 -------------------------------------------------------
await t('T5 空文字は投稿できない', () => assertFails(post(as('p1'), 'tLive', 'p1', '')));
await t('T5 61文字は投稿できない', () => assertFails(post(as('p1'), 'tLive', 'p1', 'あ'.repeat(61))));
await t('T5 60文字は投稿できる', () => assertSucceeds(post(as('p60'), 'tLive', 'p60', 'あ'.repeat(60))));
await t('T5 余計なフィールドは落ちる', () => {
  const db = as('p2'); const b = writeBatch(db);
  b.set(doc(collection(db, 'events/ev1/tracks/tLive/comments')),
    { text: 'hi', createdAt: serverTimestamp(), color: 'red' });
  b.set(doc(db, 'events/ev1/tracks/tLive/posters/p2'), { lastPostAt: serverTimestamp() });
  return assertFails(b.commit());
});
await t('T5 createdAt のクライアント偽装は落ちる', () => {
  const db = as('p3'); const b = writeBatch(db);
  b.set(doc(collection(db, 'events/ev1/tracks/tLive/comments')),
    { text: 'hi', createdAt: Timestamp.fromMillis(0) });
  b.set(doc(db, 'events/ev1/tracks/tLive/posters/p3'), { lastPostAt: serverTimestamp() });
  return assertFails(b.commit());
});
await t('T5 数値テキストは落ちる', () => {
  const db = as('p4'); const b = writeBatch(db);
  b.set(doc(collection(db, 'events/ev1/tracks/tLive/comments')), { text: 12345, createdAt: serverTimestamp() });
  b.set(doc(db, 'events/ev1/tracks/tLive/posters/p4'), { lastPostAt: serverTimestamp() });
  return assertFails(b.commit());
});

// --- T3: 投稿は追記専用 -------------------------------------------------
await t('T3 コメントは書き換えられない',
  () => assertFails(updateDoc(doc(as('attacker'), 'events/ev1/tracks/tA/comments/c1'), { text: 'hacked' })));
await t('T3 コメントは消せない',
  () => assertFails(deleteDoc(doc(as('attacker'), 'events/ev1/tracks/tA/comments/c1'))));
await t('T3 運営でもコメントは消せない',
  () => assertFails(deleteDoc(doc(asStaff('staff'), 'events/ev1/tracks/tA/comments/c1'))));

// --- T4: レート制限と読み取り量 -----------------------------------------
await t('T4 posters を伴わない単発投稿は落ちる',
  () => assertFails(setDoc(doc(collection(as('p5'), 'events/ev1/tracks/tLive/comments')),
    { text: 'solo', createdAt: serverTimestamp() })));
await t('T4 1投稿目は通る', () => assertSucceeds(post(as('p6'), 'tLive', 'p6', 'first')));
await t('T4 2秒以内の連投は落ちる', () => assertFails(post(as('p6'), 'tLive', 'p6', 'second')));
await t('T4 2秒待てば通る', async () => { await sleep(2300); return assertSucceeds(post(as('p6'), 'tLive', 'p6', 'third')); });
await t('T4 他人の posters は更新できない',
  () => assertFails(setDoc(doc(as('p7'), 'events/ev1/tracks/tLive/posters/p6'), { lastPostAt: serverTimestamp() })));
await t('T4 posters は読めない',
  () => assertFails(getDoc(doc(as('p6'), 'events/ev1/tracks/tLive/posters/p6'))));
await t('T4 limit 50 の購読は通る',
  () => assertSucceeds(getDocs(query(collection(as('r1'), 'events/ev1/tracks/tA/comments'), limit(50)))));
await t('T4 limit 51 の購読は落ちる',
  () => assertFails(getDocs(query(collection(as('r1'), 'events/ev1/tracks/tA/comments'), limit(51)))));
await t('T4 limit 無しの全件取得は落ちる',
  () => assertFails(getDocs(collection(as('r1'), 'events/ev1/tracks/tA/comments'))));
await t('T4 トラック一覧の大量取得は落ちる',
  () => assertFails(getDocs(query(collection(as('r1'), 'events/ev1/tracks'), limit(500)))));
await t('T4 トラック一覧は 50 まで通る',
  () => assertSucceeds(getDocs(query(collection(as('r1'), 'events/ev1/tracks'), limit(50)))));

// --- 停止後 -------------------------------------------------------------
await t('ST 停止済みトラックには投稿できない', () => assertFails(post(as('p8'), 'tStopped', 'p8', 'late')));
await t('ST 開始前のトラックにも投稿できない', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'events/ev1/tracks/tIdle'), {
      name: 'Track Idle', stopped: false, live: false,
      sessionStartedAt: Timestamp.now(), createdAt: Timestamp.now() });
  });
  await assertFails(post(as('p9'), 'tIdle', 'p9', 'まだ'));
});
await t('ST 停止済みでも履歴は読める',
  () => assertSucceeds(getDocs(query(collection(as('r1'), 'events/ev1/tracks/tStopped/comments'), limit(50)))));

await env.cleanup();
for (const [st, name, msg] of rows) console.log(`  ${st} ${name}${msg ? '\n        -> ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
