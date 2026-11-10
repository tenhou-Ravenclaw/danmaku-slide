// 本番に対して、デプロイ済みの Rules と**インデックス**を確かめる。
//
// この層の役目はひとつ。エミュレータでは出ない失敗を出すこと。
// エミュレータはインデックスを検査しないので、複合インデックスの不足は
// 本番でしか出ない（実際に failed-precondition を出した）。
//
// 本番に何も書かない。クエリは「無い親」に対して投げる。
// Firestore はクエリを実行する前に計画するので、結果が0件でも
// インデックスが足りなければ failed-precondition になる。
// 書かないので後片付けも要らず、本番を汚さない。
//
// ここで見られないこと：投稿が実際に流れる通しの確認。
// 運営の操作には Google サインインが要り、自動化できない。
// そこは実機での手動確認が受け持つ。
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import * as sdk from 'firebase/firestore';
import { createBus, createEventBus } from '../public/lib/bus.mjs';

const CONFIG = JSON.parse(readFileSync(new URL('../.firebase-config.json', import.meta.url), 'utf8'));

// 実在しない ID を使う。読むだけなので作らない。
const ABSENT = 'e2eabsent';

let pass = 0, fail = 0;
const rows = [];

/** 通ること。インデックス不足は failed-precondition で出る。 */
async function ok(name, fn) {
  try { await fn(); pass++; rows.push(['ok  ', name, '']); }
  catch (e) { fail++; rows.push([' NG ', name, `${e.code ?? ''} ${e.message ?? e}`.slice(0, 220)]); }
}

/** 落ちること。落ちる理由まで見る。別の理由で落ちたなら通報する。 */
async function denied(name, fn) {
  try { await fn(); fail++; rows.push([' NG ', name, '落ちるべきが通った']); }
  catch (e) {
    const s = `${e.code ?? ''}${e.message ?? e}`;
    if (/permission-denied|PERMISSION_DENIED/.test(s)) { pass++; rows.push(['ok  ', name, '']); }
    else { fail++; rows.push([' NG ', name, `別の理由: ${s}`.slice(0, 180)]); }
  }
}

const assert = (c, m) => { if (!c) throw new Error(m); };

const app = initializeApp(CONFIG, 'e2e');
const db = sdk.initializeFirestore(app, {});
const { user } = await signInAnonymously(getAuth(app));
const uid = user.uid;
const events = createEventBus(sdk, { db, uid });
const bus = (trackId) => createBus(sdk, { db, eventId: ABSENT, trackId, uid });

// --- インデックス -------------------------------------------------------
// ここが本番でしか見られない部分。
await ok('イベント一覧（where + orderBy の複合インデックス）', async () => {
  // where(ownerUid == 自分) + orderBy(createdAt desc)。
  // 索引が無いと failed-precondition。自分のイベントは無いので0件で返る。
  const got = await new Promise((res, rej) => {
    const un = events.watchMyEvents((v) => { un(); res(v); }, rej);
  });
  assert(Array.isArray(got), `配列で返らない: ${typeof got}`);
});

await ok('トラック一覧（orderBy(name) + limit）', async () => {
  const snap = await events.getTracksOnce(ABSENT);
  assert(snap.size === 0, `無い親から返ってきた: ${snap.size}`);
});

await ok('コメント購読（orderBy(createdAt desc) + limit50）', async () => {
  const seen = await new Promise((res, rej) => {
    const got = [];
    const un = bus('a').watchComments((c) => got.push(c.text), rej);
    setTimeout(() => { un(); res(got); }, 1500);
  });
  assert(seen.length === 0, `無い親から返ってきた: ${seen.length}`);
});

// --- デプロイ済みの Rules -----------------------------------------------
// エミュレータと同じ判定が本番にも乗っているかを見る。
// 期待するのは「落ちること」なので、データは要らない。
await ok('認証は通っている（匿名サインイン）', () => {
  assert(typeof uid === 'string' && uid.length > 0, `uid=${uid}`);
});

await denied('匿名ではイベントを作れない', () =>
  events.createEvent(`${ABSENT}1`, { name: 'E2E', heldOn: '2026-12-12' }));

await denied('匿名ではトラックを作れない', () =>
  events.createTrack(ABSENT, 'a', { name: 'Track A' }));

await denied('引き継ぎコードは誰も読めない', () =>
  sdk.getDoc(sdk.doc(db, 'events', ABSENT, 'private', 'handoff')));

await denied('posters は読めない', () =>
  sdk.getDoc(sdk.doc(db, 'events', ABSENT, 'tracks', 'a', 'posters', uid)));

await denied('limit 51 の取得は落ちる', () =>
  sdk.getDocs(sdk.query(
    sdk.collection(db, 'events', ABSENT, 'tracks', 'a', 'comments'), sdk.limit(51))));

await denied('limit 無しの全件取得は落ちる', () =>
  sdk.getDocs(sdk.collection(db, 'events', ABSENT, 'tracks', 'a', 'comments')));

await ok('受付中でないトラックには投稿できない', async () => {
  // トラックが無ければ get(trackPath()).data.stopped が評価できず拒まれる。
  // 手元の判定ではなくサーバが拒んでいることを見たいので、購読していない bus で投げる。
  let kind = null;
  try { await bus('a').post('通ってはいけない'); } catch (e) { kind = e.kind; }
  assert(kind === 'denied', `サーバが拒んでいない: kind=${kind}`);
});

for (const [st, name, msg] of rows) console.log(`  ${st} ${name}${msg ? '\n         -> ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
console.log('本番には何も書いていない（片付け不要）');
process.exit(fail ? 1 : 0);
