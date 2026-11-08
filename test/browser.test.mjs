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

// 画面共有の選択ダイアログを出さずに、自動で擬似スクリーンを選ばせる。
// 人の操作が要る部分を外して、合成そのものを確かめられるようにする。
const capBrowser = await chromium.launch({
  args: [
    // 選択ダイアログを出さずに自動で選ばせる
    '--auto-select-desktop-capture-source=Entire screen',
    '--use-fake-ui-for-media-stream',
    // 実スクリーンが無い環境（headless / CI）では擬似ソースに落とす。
    // これが無いと NotReadableError で取り込めない。
    '--use-fake-device-for-media-stream',
  ],
});
async function openCapturing(url) {
  const ctx = await capBrowser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.grantPermissions([]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  return { page, errors, ctx };
}

/** ページを開いて、致命的なエラーが出ていないことを確かめる。 */
async function open(url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  return { page, errors };
}

/**
 * 登壇者コンソールを開いて、そのページ自身にトラックを作らせる。
 * コンソールは owner が操作するものなので、node 側の別ユーザーで作った
 * トラックを開くと（正しく）拒否される。
 */
async function openConsoleWithNewTrack(name) {
  const r = await open(`${HOST}/speaker.html?emu=1`);
  await r.page.waitForFunction(
    () => !document.getElementById('createBox')?.classList.contains('hidden'),
    { timeout: 15000 });
  await r.page.fill('#newName', name);
  await r.page.click('#create');
  // 受付中の表示は購読から来るので、URL の書き換えより先に起きることがある。
  // trackId が要るので URL のほうを待つ。
  await r.page.waitForFunction(
    () => new URL(location.href).searchParams.get('track') !== null,
    { timeout: 15000 });
  await r.page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''),
    { timeout: 15000 });
  const trackId = new URL(r.page.url()).searchParams.get('track');
  if (!trackId) throw new Error('URL に trackId が入らなかった');
  return { ...r, trackId };
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

// --- 登壇者コンソール ---------------------------------------------------
await t('トラック未指定なら作る画面が出る', async () => {
  const { page, errors } = await open(`${HOST}/speaker.html?emu=1`);
  await page.waitForFunction(
    () => !document.getElementById('createBox')?.classList.contains('hidden'),
    { timeout: 15000 });
  assert(await page.isHidden('#stopBox'), '存在しないのに停止ボタンが出ている');
  const focused = await page.evaluate(() => document.activeElement?.id);
  assert(focused === 'newName', `フォーカス=${focused}`);
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close();
});

await t('トラックを作ると QR と停止ボタンが出る', async () => {
  const { page, errors } = await open(`${HOST}/speaker.html?emu=1`);
  await page.waitForFunction(
    () => !document.getElementById('createBox')?.classList.contains('hidden'),
    { timeout: 15000 });
  await page.fill('#newName', 'Track Z');
  await page.click('#create');
  await page.waitForFunction(
    () => !document.getElementById('qrBox')?.classList.contains('hidden'),
    { timeout: 15000 });

  assert(/受付中/.test(await page.textContent('#stateText')), await page.textContent('#stateText'));
  assert(await page.isVisible('#stop'), '停止ボタンが無い');
  assert(await page.isHidden('#resume'), '再開ボタンが出ている');
  // 再読み込みで戻れるよう URL に trackId が残る
  const url = page.url();
  assert(/[?&]track=[23456789a-z]{8}/.test(url), `URL に trackId が無い: ${url}`);
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close();
});

await t('生成した QR が実際に読み取れる', async () => {
  const { page } = await open(`${HOST}/speaker.html?emu=1`);
  await page.waitForFunction(
    () => !document.getElementById('createBox')?.classList.contains('hidden'),
    { timeout: 15000 });
  await page.fill('#newName', 'QR Track');
  await page.click('#create');
  await page.waitForFunction(
    () => document.querySelector('#qrSlot svg') !== null, { timeout: 15000 });

  const expected = await page.textContent('#postUrl');

  // SVG を Canvas に描いてピクセルを取り出し、デコーダに通す。
  // 「SVG が出た」だけでは読み取れる保証にならない。
  const rgba = await page.evaluate(async () => {
    const svg = document.querySelector('#qrSlot svg').outerHTML;
    const img = new Image();
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const size = 480;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    URL.revokeObjectURL(url);
    return { data: Array.from(ctx.getImageData(0, 0, size, size).data), size };
  });

  const jsQR = (await import('jsqr')).default;
  const decoded = jsQR(new Uint8ClampedArray(rgba.data), rgba.size, rgba.size);
  assert(decoded !== null, 'QR を読み取れなかった');
  assert(decoded.data === expected, `読み取り結果が違う:\n  期待 ${expected}\n  実際 ${decoded.data}`);
  await page.close();
});

await t('停止を押すと止まり、再開で戻る', async () => {
  const { page, errors, trackId: t5 } = await openConsoleWithNewTrack('Stop Me');

  // 止める前は投稿が通ることを先に確かめる（止まったことが本当に効果だと言うため）
  const before = await actor(t5);
  await before.post('止める前');

  await page.click('#stop');
  await page.waitForFunction(
    () => /止めている/.test(document.getElementById('stateText')?.textContent ?? ''),
    { timeout: 15000 });
  assert(await page.isHidden('#stop'), '停止後も停止ボタンが出ている');
  assert(await page.isVisible('#resume'), '再開ボタンが無い');

  // 止めた瞬間から投稿が拒否される
  const po = await actor(t5);
  let denied = false;
  try { await po.post('まだ送れる？'); } catch (e) { denied = true; }
  assert(denied, '停止後なのに投稿が通った');

  await page.click('#resume');
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''),
    { timeout: 15000 });
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close();
});

await t('開始すると演題が反映され、前の登壇のコメントは流れなくなる', async () => {
  const { page, trackId: t6 } = await openConsoleWithNewTrack('Session Track');
  const old = await actor(t6);
  await old.post('前の登壇のコメント');
  await sleep(400);

  await page.fill('#title', 'つぎの演題');
  await page.fill('#speaker', 'わたし');
  await page.click('#start');
  await sleep(900);

  // 弾幕ページを開いても、前のセッションの分は流れない
  const ov = await open(`${HOST}/overlay.html?emu=1&track=${t6}`);
  await ov.page.waitForFunction(
    () => /つぎの演題/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 15000 });
  await sleep(1000);
  const active = await ov.page.evaluate(() => window.__overlay.flow.activeCount);
  assert(active === 0, `前の登壇のコメントが流れた: ${active}件`);
  await ov.page.close();
  await page.close();
});

await t('引き継ぎコードを発行すると画面に出て、実際に使える', async () => {
  const { page, errors, trackId: t7 } = await openConsoleWithNewTrack('Handoff Track');
  await page.click('#issue');
  await page.waitForFunction(
    () => !document.getElementById('handoffCode')?.classList.contains('hidden'),
    { timeout: 15000 });
  const code = (await page.textContent('#handoffCode')).trim();
  assert(/^[23456789A-HJ-NP-Z]{6}$/.test(code), `形が違う: ${code}`);

  // 発行されたコードで別人が運用者になれる
  const next = await actor(t7);
  await next.claimOperator(code);
  await next.startSession({ title: '引き継いだ' });
  assert((await next.getTrack()).data().title === '引き継いだ', '運用者として書けていない');
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close();
});

await t('owner 以外がコンソールを開いても操作できない', async () => {
  // 他人のトラックを開いても、停止や開始は Rules が拒否する
  const t8 = 'speaker-notowner';
  const sp = await actor(t8);
  await sp.createTrack({ name: 'Someone Else' });

  const { page } = await open(`${HOST}/speaker.html?emu=1&track=${t8}`);
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''),
    { timeout: 15000 });
  await page.click('#stop');
  await page.waitForFunction(
    () => /止められない/.test(document.getElementById('stateText')?.textContent ?? ''),
    { timeout: 15000 });
  // 実際に止まっていない
  assert((await sp.getTrack()).data().stopped === false, '他人が止められている');
  await page.close();
});

// --- 貼り方B: キャプチャ合成 -------------------------------------------
await t('操作バーが出ていて、何をすればいいか書いてある', async () => {
  const { page } = await open(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForSelector('#bar', { state: 'attached' });
  await page.waitForFunction(() => document.body.dataset.bar === 'show', { timeout: 5000 });
  assert(await page.isVisible('#pick'), '「スライドを選ぶ」が無い');
  assert(await page.isVisible('#full'), '「全画面にする」が無い');
  assert(/スライドを選ぶと/.test(await page.textContent('#empty')), '案内が無い');
  await page.close();
});

await t('しばらく触らないと操作バーが消える（投影の邪魔をしない）', async () => {
  const { page } = await open(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(() => document.body.dataset.bar === 'show', { timeout: 5000 });
  await page.waitForFunction(() => document.body.dataset.bar !== 'show', { timeout: 8000 });
  await page.mouse.move(400, 20);
  await page.waitForFunction(() => document.body.dataset.bar === 'show', { timeout: 5000 });
  await page.close();
});

await t('透過シェルから開いたときは操作バーを出さない', async () => {
  const { page } = await open(`${HOST}/overlay.html?emu=1&transparent=1&track=${TRACK}`);
  await page.waitForSelector('#bar', { state: 'attached' });
  const shown = await page.evaluate(() => getComputedStyle(document.getElementById('bar')).display);
  assert(shown === 'none', `バーが出ている: ${shown}`);
  const empty = await page.evaluate(() => getComputedStyle(document.getElementById('empty')).display);
  assert(empty === 'none', '案内が出ている');
  await page.close();
});

await t('スライドを取り込むと下敷きとして描かれる', async () => {
  const { page, errors, ctx } = await openCapturing(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 20000 });

  assert(await drawnPixels(page) === 0, '取り込む前から描かれている');

  await page.evaluate(() => document.getElementById('pick').click());
  await page.waitForFunction(() => window.__overlay?.hasSlide === true, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('slide').videoWidth > 0, { timeout: 20000 });
  await sleep(600);

  // 下敷きが描かれていれば、コメントが無くても画面が埋まる
  const n = await drawnPixels(page);
  assert(n > 100000, `下敷きが描かれていない: ${n}`);
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await ctx.close();
});

await t('取り込み中に投稿が来るとスライドの上に重なる', async () => {
  const t9 = 'capture-overlay';
  const sp = await actor(t9);
  await sp.createTrack({ name: 'Capture Track' });

  const { page, ctx } = await openCapturing(`${HOST}/overlay.html?emu=1&track=${t9}`);
  await page.waitForFunction(
    () => /Capture Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 20000 });
  await page.evaluate(() => document.getElementById('pick').click());
  await page.waitForFunction(() => document.getElementById('slide').videoWidth > 0, { timeout: 20000 });
  await sleep(400);

  const po = await actor(t9);
  await po.post('スライドの上に出る');
  await page.waitForFunction(() => (window.__overlay?.flow?.activeCount ?? 0) > 0, { timeout: 20000 });

  // 弾幕が下敷きより後に描かれていること（塗りつぶされていないこと）
  const order = await page.evaluate(() => {
    const seen = [];
    const ctx2 = document.getElementById('stage').getContext('2d');
    const di = ctx2.drawImage.bind(ctx2), ft = ctx2.fillText.bind(ctx2);
    ctx2.drawImage = (...a) => { seen.push('backdrop'); return di(...a); };
    ctx2.fillText = (...a) => { seen.push('danmaku'); return ft(...a); };
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      ctx2.drawImage = di; ctx2.fillText = ft; res(seen);
    })));
  });
  assert(order.indexOf('backdrop') >= 0, '下敷きが描かれていない');
  assert(order.indexOf('danmaku') > order.indexOf('backdrop'), '弾幕が下敷きより先に描かれている');
  await ctx.close();
});

await t('取り込みをやめると下敷きが消える', async () => {
  const { page, ctx } = await openCapturing(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 20000 });
  await page.evaluate(() => document.getElementById('pick').click());
  await page.waitForFunction(() => window.__overlay?.hasSlide === true, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('slide').videoWidth > 0, { timeout: 20000 });
  await sleep(400);
  assert(await drawnPixels(page) > 100000, '下敷きが描かれていない');

  await page.evaluate(() => document.getElementById('drop').click());
  await sleep(500);
  assert(await drawnPixels(page) === 0, '下敷きが残っている');
  assert(await page.evaluate(() => window.__overlay.hasSlide) === false, '状態が戻っていない');
  await ctx.close();
});

await t('ブラウザ側で共有を止めても固まったまま映らない', async () => {
  // Chrome の「共有を停止」を押した場合。video に最後のフレームが残ると、
  // 止めたはずのスライドが固まって映り続ける。
  const { page, ctx } = await openCapturing(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 20000 });
  await page.evaluate(() => document.getElementById('pick').click());
  await page.waitForFunction(() => document.getElementById('slide').videoWidth > 0, { timeout: 20000 });
  await sleep(400);
  assert(await drawnPixels(page) > 100000, '下敷きが描かれていない');

  // トラックを止める = ブラウザの「共有を停止」と同じ
  await page.evaluate(() => {
    for (const t of document.getElementById('slide').srcObject.getVideoTracks()) t.stop();
    document.getElementById('slide').srcObject.getVideoTracks()[0]
      .dispatchEvent(new Event('ended'));
  });
  await sleep(600);
  assert(await drawnPixels(page) === 0, '止めた後も映り続けている');
  assert(/止まった/.test(await page.textContent('#hud')), `知らせていない: ${await page.textContent('#hud')}`);
  await ctx.close();
});

// --- 帯で浮かせる（Document PiP）---------------------------------------
await t('帯で浮かせると弾幕が別の窓へ移る', async () => {
  const { page, errors } = await open(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 20000 });

  const supported = await page.evaluate(() => window.__overlay.pip.isSupported());
  assert(supported, 'Document PiP に対応していない');

  await page.evaluate(() => document.getElementById('float').click());
  await page.waitForFunction(() => window.__overlay.isFloating === true, { timeout: 15000 });

  // canvas が元のページから抜けて、行数も新しい窓の高さで測り直されている
  const moved = await page.evaluate(() => ({
    inPage: document.getElementById('stage') !== null,
    lanes: window.__overlay.flow.laneCount,
  }));
  assert(!moved.inPage, 'canvas が元のページに残っている');
  assert(moved.lanes >= 1, `行数が取れていない: ${moved.lanes}`);
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close();
});

await t('浮かせた帯にも投稿が流れる', async () => {
  const tA = 'pip-track';
  const sp = await actor(tA);
  await sp.createTrack({ name: 'PiP Track' });

  const { page } = await open(`${HOST}/overlay.html?emu=1&track=${tA}`);
  await page.waitForFunction(
    () => /PiP Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 20000 });
  await page.evaluate(() => document.getElementById('float').click());
  await page.waitForFunction(() => window.__overlay.isFloating === true, { timeout: 15000 });

  const po = await actor(tA);
  await po.post('帯にも流れる');
  await page.waitForFunction(() => (window.__overlay?.flow?.activeCount ?? 0) > 0, { timeout: 20000 });
  await page.close();
});

await t('帯をやめると弾幕が元のページへ戻る', async () => {
  const { page } = await open(`${HOST}/overlay.html?emu=1&track=${TRACK}`);
  await page.waitForFunction(
    () => /Browser Track/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 20000 });
  await page.evaluate(() => document.getElementById('float').click());
  await page.waitForFunction(() => window.__overlay.isFloating === true, { timeout: 15000 });
  await page.evaluate(() => window.__overlay.unfloat());
  await page.waitForFunction(() => window.__overlay.isFloating === false, { timeout: 15000 });
  assert(await page.evaluate(() => document.getElementById('stage') !== null),
    'canvas が戻っていない');
  await page.close();
});

await browser.close();
await capBrowser.close();
for (const [st, name, msg] of rows) console.log(`  ${st} ${name}${msg ? '\n         -> ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
