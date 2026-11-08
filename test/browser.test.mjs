import { chromium } from 'playwright';
import * as sdk from 'firebase/firestore';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import { readFileSync } from 'node:fs';
import { createBus } from '../public/lib/bus.mjs';

const HOST = process.env.HOSTING_URL ?? 'http://127.0.0.1:5055';

// ブラウザ側は public/firebase-config.js の projectId でエミュレータに繋ぐ。
// node 側が別の projectId を使うと、同じエミュレータでも別のデータを見ることになる。
const CONFIG = JSON.parse(readFileSync(new URL('../.firebase-config.json', import.meta.url), 'utf8'));

let pass = 0, fail = 0;
const rows = [];
async function t(name, fn) {
  try { await fn(); pass++; rows.push(['ok  ', name, '']); }
  catch (e) { fail++; rows.push([' NG ', name, String(e?.message ?? e).slice(0, 200)]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- エミュレータ側に土台を作る -----------------------------------------
// 投稿者ごとに別の匿名ユーザーが必要。Rules が posters/{uid} の uid と
// request.auth.uid の一致を要求しているので、uid を文字列で渡すだけでは通らない。
let seq = 0;
async function actor(trackId) {
  const app = initializeApp({ ...CONFIG, authDomain: 'localhost' }, `a${++seq}`);
  const db = sdk.initializeFirestore(app, {});
  sdk.connectFirestoreEmulator(db, '127.0.0.1', 8181);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const { user } = await signInAnonymously(auth);
  return createBus(sdk, { db, trackId, uid: user.uid });
}

const TRACK = 'browser-track';
const speaker = await actor(TRACK);
await speaker.createTrack({ name: 'Browser Track', title: '実ブラウザ検証' });

const browser = await chromium.launch();

/** ページを開いて、致命的なエラーが出ていないことを確かめる。 */
async function open(url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  return { page, errors };
}

/** Canvas に実際に何か描かれているかを数える。 */
function drawnPixels(page) {
  return page.evaluate(() => {
    const c = document.getElementById('stage');
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  });
}

// --- トラック未指定 -----------------------------------------------------
await t('トラック未指定なら画面にエラーを出す（黙って死なない）', async () => {
  const { page } = await open(`${HOST}/overlay.html?emu=1`);
  await page.waitForFunction(() => document.getElementById('hud')?.dataset.kind === 'error', { timeout: 10000 });
  const text = await page.textContent('#hud');
  assert(/トラックが指定されていない/.test(text), `HUD=${text}`);
  await page.close();
});

// --- 接続と描画 ---------------------------------------------------------
await t('トラックに接続して HUD に名前が出る', async () => {
  const { page, errors } = await open(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 15000 });
  const text = await page.textContent('#hud');
  assert(/実ブラウザ検証/.test(text), `演題が出ていない: ${text}`);
  assert(errors.length === 0, `エラーが出た: ${errors.join(' / ')}`);
  await page.close();
});

await t('投稿すると Canvas に描かれる', async () => {
  const { page, errors } = await open(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 15000 });

  assert(await drawnPixels(page) === 0, '何も投稿していないのに描かれている');

  const poster = await actor(TRACK);
  await poster.post('えっ、ちゃんと流れてる');
  await page.waitForFunction(() => (window.__overlay?.flow?.activeCount ?? 0) > 0, { timeout: 15000 });
  await sleep(300);

  const n = await drawnPixels(page);
  assert(n > 500, `描かれたピクセルが少なすぎる: ${n}`);
  assert(errors.length === 0, `エラーが出た: ${errors.join(' / ')}`);
  await page.close();
});

await t('文字が左へ進む', async () => {
  const { page } = await open(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 15000 });
  const poster = await actor(TRACK);
  await poster.post('流れていく');
  await page.waitForFunction(() => (window.__overlay?.flow?.activeCount ?? 0) > 0, { timeout: 15000 });

  const xAt = () => page.evaluate(() => window.__overlay.flow.step(performance.now())[0]?.x ?? null);
  const first = await xAt();
  await sleep(500);
  const second = await xAt();
  assert(first != null && second != null, '流れているものが取れない');
  assert(second < first, `左へ進んでいない: ${first} → ${second}`);
  await page.close();
});

// --- 再読み込みで溜まった分が一斉に流れない ----------------------------
await t('再読み込みしても溜まっていた分は流れない', async () => {
  const t2 = 'browser-backlog';
  const sp = await actor(t2);
  await sp.createTrack({ name: 'Backlog Track' });
  for (const u of ['x', 'y', 'z']) {
    const p = await actor(t2);
    await p.post(`溜まっていた ${u}`);
    await sleep(60);
  }
  await sleep(400);

  const { page, errors } = await open(`${HOST}/overlay.html?emu=1&track=${t2}`);
  await page.waitForFunction(
    () => /Backlog Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 15000 });
  await sleep(1200);
  const active = await page.evaluate(() => window.__overlay.flow.activeCount);
  assert(active === 0, `溜まっていた分が流れた: ${active}件`);
  assert(await drawnPixels(page) === 0, '描かれている');
  assert(errors.length === 0, `エラーが出た: ${errors.join(' / ')}`);
  await page.close();
});

// --- 透過 ---------------------------------------------------------------
await t('?transparent=1 で html に透過が当たる', async () => {
  const { page } = await open(`${HOST}/overlay.html?emu=1&transparent=1&track=${TRACK}`);
  // body だけに当てると html の背景が残って黒く見える（PoC で踏んだ）
  const onHtml = await page.evaluate(() => document.documentElement.classList.contains('transparent'));
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  assert(onHtml, 'html に transparent が付いていない');
  assert(/rgba\(0, 0, 0, 0\)|transparent/.test(bg), `html の背景が透過でない: ${bg}`);
  await page.close();
});

await t('?hud=0 で HUD が消える', async () => {
  const { page } = await open(`${HOST}/overlay.html?emu=1&hud=0&track=${TRACK}`);
  await sleep(500);
  const shown = await page.evaluate(() => getComputedStyle(document.getElementById('hud')).display);
  assert(shown === 'none', `HUD が見えている: ${shown}`);
  await page.close();
});

// --- 画面サイズ ---------------------------------------------------------
await t('ウィンドウサイズを変えると行数が追従する', async () => {
  const { page, errors } = await open(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(() => window.__overlay?.flow?.laneCount > 0, { timeout: 15000 });
  const before = await page.evaluate(() => window.__overlay.flow.laneCount);
  await page.setViewportSize({ width: 1280, height: 400 });
  await sleep(300);
  const after = await page.evaluate(() => window.__overlay.flow.laneCount);
  assert(after < before, `行数が変わっていない: ${before} → ${after}`);
  assert(errors.length === 0, `エラーが出た: ${errors.join(' / ')}`);
  await page.close();
});

// --- 投稿ページ ---------------------------------------------------------
await t('投稿ページは開いた時点で入力欄にフォーカスが当たる', async () => {
  const { page, errors } = await open(`${HOST}/post.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('where')?.textContent ?? ''),
    { timeout: 15000 });
  const focused = await page.evaluate(() => document.activeElement?.id);
  assert(focused === 'text', `フォーカス=${focused}`);
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close();
});

await t('文字数が出て、空のうちは送れない', async () => {
  const { page } = await open(`${HOST}/post.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(() => document.getElementById('send') !== null);
  assert(await page.isDisabled('#send'), '空なのに押せる');
  assert((await page.textContent('#count')) === '0 / 60', await page.textContent('#count'));
  await page.fill('#text', 'あいうえお');
  await page.waitForFunction(() => document.getElementById('count').textContent === '5 / 60');
  await page.waitForFunction(() => !document.getElementById('send').disabled);
  await page.close();
});

await t('60文字を超える入力は打てない（UI 側でも止める）', async () => {
  const { page } = await open(`${HOST}/post.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(() => document.getElementById('text') !== null);
  await page.fill('#text', 'あ'.repeat(80));
  const len = await page.evaluate(() => document.getElementById('text').value.length);
  assert(len === 60, `maxlength が効いていない: ${len}`);
  await page.close();
});

await t('投稿すると入力欄が空になり、続けて打てる', async () => {
  const { page, errors } = await open(`${HOST}/post.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('where')?.textContent ?? ''),
    { timeout: 15000 });
  await page.fill('#text', 'ブラウザから送る');
  await page.click('#send');
  await page.waitForFunction(() => document.getElementById('text').value === '', { timeout: 15000 });
  assert((await page.textContent('#note')) === '送った', await page.textContent('#note'));
  const focused = await page.evaluate(() => document.activeElement?.id);
  assert(focused === 'text', `送信後のフォーカス=${focused}`);
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close();
});

await t('連投するとボタンに残り秒数が出る（無言で押せなくしない）', async () => {
  const { page } = await open(`${HOST}/post.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('where')?.textContent ?? ''),
    { timeout: 15000 });
  await page.fill('#text', 'いちど');
  await page.click('#send');
  await page.waitForFunction(() => document.getElementById('text').value === '', { timeout: 15000 });

  await page.fill('#text', 'にかいめ');
  await page.waitForFunction(() => /秒待つ/.test(document.getElementById('send').textContent), { timeout: 5000 });
  assert(await page.isDisabled('#send'), '待機中なのに押せる');
  await page.close();
});

await t('停止中のトラックでは理由が出て押せない', async () => {
  const t3 = 'browser-stopped';
  const sp = await actor(t3);
  await sp.createTrack({ name: 'Stopped Track' });
  await sp.stop();

  const { page } = await open(`${HOST}/post.html?emu=1&track=${t3}`);
  await page.waitForFunction(
    () => /もう終わって/.test(document.getElementById('note')?.textContent ?? ''),
    { timeout: 15000 });
  await page.fill('#text', 'まだ送れる？');
  await page.waitForFunction(() => document.getElementById('send').disabled, { timeout: 5000 });
  await page.close();
});

await t('存在しないトラックなら理由が出る', async () => {
  const { page } = await open(`${HOST}/post.html?emu=1&track=no-such-track`);
  await page.waitForFunction(
    () => /存在しない/.test(document.getElementById('where')?.textContent ?? ''),
    { timeout: 15000 });
  await page.close();
});

await t('トラック未指定なら QR を読み直すよう出す', async () => {
  const { page } = await open(`${HOST}/post.html?emu=1`);
  await page.waitForFunction(
    () => /QRコード/.test(document.getElementById('note')?.textContent ?? ''),
    { timeout: 10000 });
  await page.close();
});

// --- 一連の流れ ---------------------------------------------------------
await t('投稿ページから送ったものが弾幕ページに流れる（通し）', async () => {
  const t4 = 'browser-e2e';
  const sp = await actor(t4);
  await sp.createTrack({ name: 'E2E Track', title: '通し確認' });

  const overlay = await open(`${HOST}/overlay.html?emu=1&track=${t4}`);
  await overlay.page.waitForFunction(
    () => /E2E Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 15000 });
  assert(await drawnPixels(overlay.page) === 0, '最初から描かれている');

  const post = await open(`${HOST}/post.html?emu=1&track=${t4}`);
  await post.page.waitForFunction(
    () => /E2E Track/.test(document.getElementById('where')?.textContent ?? ''),
    { timeout: 15000 });
  await post.page.fill('#text', '通しで流れた');
  await post.page.click('#send');
  await post.page.waitForFunction(() => document.getElementById('text').value === '', { timeout: 15000 });

  await overlay.page.waitForFunction(
    () => (window.__overlay?.flow?.activeCount ?? 0) > 0, { timeout: 20000 });
  await sleep(300);
  const n = await drawnPixels(overlay.page);
  assert(n > 500, `描かれたピクセルが少なすぎる: ${n}`);
  assert(overlay.errors.length === 0, `弾幕側のエラー: ${overlay.errors.join(' / ')}`);
  assert(post.errors.length === 0, `投稿側のエラー: ${post.errors.join(' / ')}`);
  await post.page.close();
  await overlay.page.close();
});

await browser.close();
for (const [st, name, msg] of rows) console.log(`  ${st} ${name}${msg ? '\n         -> ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
