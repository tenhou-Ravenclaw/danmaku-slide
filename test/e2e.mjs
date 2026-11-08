// 本番の Firestore に対して、デプロイ済みの Rules と**インデックス**を確かめる。
//
// エミュレータはインデックスを検査しないので、複合インデックスの不足は
// 本番でしか出ない（実際に failed-precondition を出した）。
// アプリが実際に使うクエリをそのまま投げるのが、この層の役目。
//
// 終わったら作ったものを自分で片付ける。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import * as sdk from 'firebase/firestore';
import { createBus, createEventBus } from '../public/lib/bus.mjs';

const CONFIG = JSON.parse(readFileSync(new URL('../.firebase-config.json', import.meta.url), 'utf8'));
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
const EVENT = `e2e${stamp}`.slice(0, 20);

let pass = 0, fail = 0;
const rows = [];
async function ok(name, fn) {
  try { await fn(); pass++; rows.push(['ok  ', name, '']); }
  catch (e) { fail++; rows.push([' NG ', name, `${e.code ?? ''} ${e.message ?? e}`.slice(0, 200)]); }
}
async function denied(name, fn) {
  try { await fn(); fail++; rows.push([' NG ', name, '落ちるべきが通った']); }
  catch (e) {
    const s = `${e.code ?? ''}${e.message ?? e}`;
    if (/permission-denied|PERMISSION_DENIED/.test(s)) { pass++; rows.push(['ok  ', name, '']); }
    else { fail++; rows.push([' NG ', name, `別の理由: ${s}`.slice(0, 160)]); }
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let seq = 0;
async function person() {
  const app = initializeApp(CONFIG, `p${++seq}`);
  const db = sdk.initializeFirestore(app, {});
  const { user } = await signInAnonymously(getAuth(app));
  return { db, uid: user.uid, events: createEventBus(sdk, { db, uid: user.uid }) };
}
const uids = [];
const staff = await person(); uids.push(staff.uid);
const busFor = (p, trackId) => createBus(sdk, { db: p.db, eventId: EVENT, trackId, uid: p.uid });

// --- 運営の道 -----------------------------------------------------------
await ok('イベントを作れる', () => staff.events.createEvent(EVENT, { name: 'E2E', heldOn: '2026-12-12' }));

await ok('自分のイベント一覧が引ける（複合インデックス）', async () => {
  // where(ownerUid) + orderBy(createdAt desc)。
  // インデックスが無いと failed-precondition になる。エミュレータでは出ない。
  const got = await new Promise((res, rej) => {
    const un = staff.events.watchMyEvents((v) => { un(); res(v); }, rej);
  });
  assert(got.some((e) => e.id === EVENT), `一覧に出ない: ${got.map((e) => e.id)}`);
});

await ok('トラックを並べられる', async () => {
  await staff.events.createTrack(EVENT, 'a', { name: 'Track A' });
  await staff.events.createTrack(EVENT, 'b', { name: 'Track B' });
  const snap = await staff.events.getTracksOnce(EVENT);
  assert(snap.size === 2, `件数=${snap.size}`);
});

await ok('トラックを名前順で購読できる', async () => {
  const got = await new Promise((res, rej) => {
    const un = staff.events.watchTracks(EVENT, (v) => { if (v.length === 2) { un(); res(v); } }, rej);
  });
  assert(got.map((t) => t.name).join(',') === 'Track A,Track B', `順番: ${got.map((t) => t.name)}`);
});

// --- 投稿と購読 ---------------------------------------------------------
const po = await person(); uids.push(po.uid);
// 同じ bus を使い回す。作り直すと手元のクールダウンが消えて、連投の検証にならない。
const poBus = busFor(po, 'a');
await ok('投稿できる', () => poBus.post('本番で流れる'));

// クールダウンは投稿直後に見る。間に他のテストを挟むと2秒を過ぎてしまう。
await ok('2秒以内の連投は手元で止まる', async () => {
  // サーバに行く前に止める。無駄な往復をさせない。
  let kind = null;
  try { await poBus.post('れんだ'); } catch (e) { kind = e.kind; }
  assert(kind === 'cooldown', `kind=${kind}`);
});

await ok('本番クエリ（session境界 + desc + limit50）が通る', async () => {
  const sp = busFor(staff, 'a');
  const startedAt = (await sp.getTrack()).data().sessionStartedAt;
  const seen = [];
  const un = sp.watchComments(startedAt, (c) => seen.push(c.text));
  await sleep(1500);
  un();
  assert(seen.includes('本番で流れる'), `届かない: ${seen}`);
});

await ok('件数を数えるクエリが通る', async () => {
  const sp = busFor(staff, 'a');
  const startedAt = (await sp.getTrack()).data().sessionStartedAt;
  const snap = await sdk.getDocs(sdk.query(
    sdk.collection(staff.db, 'events', EVENT, 'tracks', 'a', 'comments'),
    sdk.where('createdAt', '>=', startedAt), sdk.orderBy('createdAt', 'desc'), sdk.limit(50)));
  assert(snap.size >= 1, `件数=${snap.size}`);
});

// --- 守り ---------------------------------------------------------------
await denied('運営以外はトラックを足せない', async () => {
  const other = await person(); uids.push(other.uid);
  await other.events.createTrack(EVENT, 'x', { name: 'Track X' });
});
await denied('他人はイベント名を変えられない', async () => {
  const other = await person(); uids.push(other.uid);
  await other.events.renameEvent(EVENT, { name: 'のっとり', heldOn: '' });
});
await ok('手元の判定を抜けてもサーバが連投を拒む', async () => {
  // 手元のクールダウンだけに頼らない。bus を作り直すと手元の時計は消えるので、
  // 1件送った直後に別の bus（同じ uid）から投げれば、サーバの判定だけが残る。
  const fresh1 = busFor(po, 'b');
  await fresh1.post('いちど');
  const fresh2 = busFor(po, 'b');
  let kind = null;
  try { await fresh2.post('すりぬけ'); } catch (e) { kind = e.kind; }
  assert(kind === 'denied', `サーバが通してしまった: kind=${kind}`);
});
await ok('61文字は手元で止まる', async () => {
  let kind = null;
  try { await busFor(po, 'a').post('あ'.repeat(61)); } catch (e) { kind = e.kind; }
  assert(kind === 'too-long', `kind=${kind}`);
});
await denied('引き継ぎコードは誰も読めない', () =>
  sdk.getDoc(sdk.doc(staff.db, 'events', EVENT, 'tracks', 'a', 'private', 'handoff')));
await denied('limit 51 の購読は落ちる', () =>
  sdk.getDocs(sdk.query(sdk.collection(staff.db, 'events', EVENT, 'tracks', 'a', 'comments'), sdk.limit(51))));

await ok('登壇を終えると投稿が止まる', async () => {
  await busFor(staff, 'b').endSession();
  await sleep(800);
  let stopped = false;
  try { await busFor(await person(), 'b').post('おそい'); } catch { stopped = true; }
  assert(stopped, '終えたのに通った');
});

// --- 後片付け -----------------------------------------------------------
function cleanup() {
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execFileSync('firebase',
      ['firestore:delete', '--recursive', `events/${EVENT}`, '--force', '--project', CONFIG.projectId], opts);
    console.log(`\n片付け: events/${EVENT} を削除した`);
  } catch { console.log(`\n片付け失敗（手で消す）: events/${EVENT}`); }
  try {
    const token = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], opts).trim();
    execFileSync('curl', ['-s', '-X', 'POST',
      `https://identitytoolkit.googleapis.com/v1/projects/${CONFIG.projectId}/accounts:batchDelete`,
      '-H', `Authorization: Bearer ${token}`,
      '-H', `x-goog-user-project: ${CONFIG.projectId}`,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ localIds: uids, force: true })], opts);
    console.log(`片付け: 匿名アカウント ${uids.length} 件を削除した`);
  } catch { console.log('片付け失敗: 匿名アカウントが残った'); }
}

for (const [st, name, msg] of rows) console.log(`  ${st} ${name}${msg ? '\n         -> ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
