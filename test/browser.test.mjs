// 実ブラウザで画面が動くかを見る。
//
// ユニットテストは計算を見るだけで、「ページが立ち上がるか」は見ない。
// PoC では module が黙って死んで原因が分からなかったので、そこを機械で押さえる。
import { chromium } from 'playwright';
import * as sdk from 'firebase/firestore';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import { readFileSync } from 'node:fs';
import { createBus, createEventBus } from '../public/lib/bus.mjs';

const HOST = process.env.HOSTING_URL ?? 'http://127.0.0.1:5055';
const CONFIG = JSON.parse(readFileSync(new URL('../.firebase-config.json', import.meta.url), 'utf8'));

let pass = 0, fail = 0;
const rows = [];
async function t(name, fn) {
  try { await fn(); pass++; rows.push(['ok  ', name, '']); }
  catch (e) { fail++; rows.push([' NG ', name, String(e?.message ?? e).slice(0, 220)]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 投稿者ごとに別の匿名ユーザーが要る。Rules が posters/{uid} と
// request.auth.uid の一致を求めるので、uid を文字列で渡すだけでは通らない。
let seq = 0;
async function actor() {
  const app = initializeApp({ ...CONFIG, authDomain: 'localhost' }, `a${++seq}`);
  const db = sdk.initializeFirestore(app, {});
  sdk.connectFirestoreEmulator(db, '127.0.0.1', 8181);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const { user } = await signInAnonymously(auth);
  return { db, uid: user.uid, events: createEventBus(sdk, { db, uid: user.uid }) };
}
const busFor = (a, eventId, trackId) =>
  createBus(sdk, { db: a.db, eventId, trackId, uid: a.uid });

const browser = await chromium.launch();

// 画面共有の選択ダイアログを出さずに、自動で擬似スクリーンを選ばせる。
const capBrowser = await chromium.launch({
  args: [
    '--auto-select-desktop-capture-source=Entire screen',
    '--use-fake-ui-for-media-stream',
    // 実スクリーンが無い環境では擬似ソースに落とす
    '--use-fake-device-for-media-stream',
  ],
});

/**
 * ページを開く。
 *
 * 同じ ctx を渡すと同じ匿名ユーザーになる。渡さないと別人になるので、
 * 運営が作ったイベントを別人として開くことになり、本来の流れと変わる。
 */
async function open(url, { b = browser, ctx = null, scheme = null } = {}) {
  const context = ctx ?? await b.newContext({
    viewport: { width: 1280, height: 800 },
    ...(scheme ? { colorScheme: scheme } : {}),
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  return { page, errors, ctx: context };
}
const openCapturing = (url) => open(url, { b: capBrowser });

/** Canvas に実際に何か描かれているかを数える。 */
const drawnPixels = (page) => page.evaluate(() => {
  const c = document.getElementById('stage');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});

/** 運営の画面を開いて、イベントとトラックを作らせる。 */
async function makeEventInBrowser(name, trackNames = ['Track A']) {
  const r = await open(`${HOST}/organizer.html?emu=1`);
  // 運営が作ったものを同じ人として触れるよう、ctx を返して使い回す
  await r.page.waitForSelector('#newEventName', { state: 'visible', timeout: 20000 });
  await r.page.fill('#newEventName', name);
  await r.page.fill('#newEventDate', '2026-12-12');
  await r.page.click('#createEvent');
  await r.page.waitForFunction(
    () => new URL(location.href).searchParams.get('e') !== null, { timeout: 20000 });
  const eventId = new URL(r.page.url()).searchParams.get('e');
  for (const [i, n] of trackNames.entries()) {
    await r.page.fill('#newTrackName', n);
    await r.page.click('#addTrack');
    await r.page.waitForFunction(
      (want) => document.querySelectorAll('#tracks tr').length >= want, i + 1, { timeout: 20000 });
  }
  return { ...r, eventId };
}

// --- 運営の画面 ---------------------------------------------------------
await t('イベントを作ると詳細へ移り、URLにIDが残る', async () => {
  const { page, errors, eventId } = await makeEventInBrowser('テスト大会', []);
  assert(/^[23456789a-z]{8}$/.test(eventId), `IDの形が変: ${eventId}`);
  assert(/テスト大会/.test(await page.textContent('#evName')), await page.textContent('#evName'));
  assert(/2026\/12\/12（土）/.test(await page.textContent('#evMeta')), await page.textContent('#evMeta'));
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close();
});

await t('トラックを並べると名前順で表に出る', async () => {
  const { page, errors } = await makeEventInBrowser('並び順の会', ['Track C', 'Track A', 'Track B']);
  await page.waitForFunction(() => document.querySelectorAll('#tracks tr').length === 3, { timeout: 20000 });
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('#tracks tr td:first-child')].map((td) => td.textContent.trim()));
  assert(names.join(',') === 'Track A,Track B,Track C', `順番が違う: ${names}`);
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close();
});

await t('トラックごとに登壇者へ渡すリンクが出る', async () => {
  const { page } = await makeEventInBrowser('リンクの会', ['Track A']);
  const link = await page.textContent('#tracks tr td:nth-child(5)');
  assert(/stage\.html\?e=/.test(link), `リンクが出ていない: ${link}`);
  assert(/t=/.test(link), link);
  await page.close();
});

await t('チラシ用QRが読み取れる', async () => {
  const { page, eventId } = await makeEventInBrowser('QRの会', []);
  await page.waitForFunction(() => document.querySelector('#evQr svg') !== null, { timeout: 20000 });
  const rgba = await page.evaluate(async () => {
    const svg = document.querySelector('#evQr svg').outerHTML;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const size = 480, c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, size, size);
    x.drawImage(img, 0, 0, size, size);
    return { data: Array.from(x.getImageData(0, 0, size, size).data), size };
  });
  const jsQR = (await import('jsqr')).default;
  const dec = jsQR(new Uint8ClampedArray(rgba.data), rgba.size, rgba.size);
  assert(dec !== null, 'QR を読み取れなかった');
  assert(dec.data.endsWith(`/e/${eventId}`), `読み取り結果が違う: ${dec.data}`);
  await page.close();
});

await t('受付状況がトラックの数とともに出る', async () => {
  const { page, eventId } = await makeEventInBrowser('状況の会', ['Track A', 'Track B']);
  const list = await open(`${HOST}/organizer.html?emu=1`, { ctx: page.context() });
  // トラック数は一覧に入っていないので、イベントごとに数え直している。
  // 数え終わるまでは「—」なので、出そろうのを待つ。
  await list.page.waitForFunction(
    () => [...document.querySelectorAll('#upcoming tr')]
      .some((tr) => tr.textContent.includes('状況の会') && /\d+ トラック/.test(tr.textContent)),
    { timeout: 20000 });
  const text = await list.page.textContent('#upcoming');
  assert(/2 トラック/.test(text), text);
  assert(/受付中 2 \/ 2/.test(text), text);
  await list.page.close(); await page.close();
});

await t('全トラックの投稿を止められる', async () => {
  const { page, eventId } = await makeEventInBrowser('非常停止の会', ['Track A', 'Track B']);
  await page.click('#stopAll');
  await page.waitForFunction(
    () => document.querySelectorAll('#tracks .pill.bad').length === 2, { timeout: 20000 });

  // 実際に投稿が拒否される
  const po = await actor();
  let denied = false;
  try { await busFor(po, eventId, 'a').post('止まったはず'); } catch { denied = true; }
  assert(denied, '止めたのに投稿が通った');
  await page.close();
});

// --- 登壇者の画面 -------------------------------------------------------
await t('リンクが不完全なら理由が出る', async () => {
  const { page } = await open(`${HOST}/stage.html?emu=1`);
  await page.waitForFunction(
    () => /リンクが正しくありません/.test(document.getElementById('stateText')?.textContent ?? ''),
    { timeout: 20000 });
  await page.close();
});

await t('登壇者ページは手順1から始まる', async () => {
  const org = await makeEventInBrowser('手順の会', ['Track A']);
  const { page, errors } = await open(`${HOST}/stage.html?emu=1&e=${org.eventId}&t=a`, { ctx: org.ctx });
  await page.waitForFunction(
    () => /受付中|停止中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });
  assert(await page.getAttribute('#step1', 'data-state') === 'now', '手順1が「いま」でない');
  assert(/Track A/.test(await page.textContent('#trackName')), await page.textContent('#trackName'));
  assert(/手順の会/.test(await page.textContent('#eventName')), await page.textContent('#eventName'));
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close(); await org.page.close();
});

await t('「アプリで開く」は danmaku:// を指す', async () => {
  const org = await makeEventInBrowser('アプリの会', ['Track A']);
  const { page } = await open(`${HOST}/stage.html?emu=1&e=${org.eventId}&t=a&k=CODE2345`, { ctx: org.ctx });
  await page.waitForFunction(
    () => document.getElementById('openApp')?.getAttribute('href')?.startsWith('danmaku:'),
    { timeout: 20000 });
  const href = await page.getAttribute('#openApp', 'href');
  const u = new URL(href);
  assert(u.searchParams.get('e') === org.eventId, href);
  assert(u.searchParams.get('t') === 'a', href);
  assert(u.searchParams.get('k') === 'CODE2345', href);
  await page.close(); await org.page.close();
});

await t('演題を入れて開始すると、いまの登壇として出る', async () => {
  const org = await makeEventInBrowser('開始の会', ['Track A']);
  const { page, errors } = await open(`${HOST}/stage.html?emu=1&e=${org.eventId}&t=a`, { ctx: org.ctx });
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });
  await page.fill('#title', 'はじめてのLT');
  await page.fill('#speaker', '佐藤 葵');
  await page.click('#startBtn');
  await page.waitForFunction(
    () => !document.getElementById('afterStart').classList.contains('hidden'), { timeout: 20000 });
  assert(/はじめてのLT/.test(await page.textContent('#nowTitle')), await page.textContent('#nowTitle'));
  assert(/佐藤 葵/.test(await page.textContent('#nowMeta')), await page.textContent('#nowMeta'));
  // 開始時刻はサーバが決めるので、確定するまで少し待つ
  await page.waitForFunction(
    () => /\d{2}:\d{2} 開始/.test(document.getElementById('nowMeta')?.textContent ?? ''),
    { timeout: 20000 });
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close(); await org.page.close();
});

await t('届いたコメントが手元に出て、件数が増える', async () => {
  const org = await makeEventInBrowser('コメントの会', ['Track A']);
  const { page } = await open(`${HOST}/stage.html?emu=1&e=${org.eventId}&t=a`, { ctx: org.ctx });
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });
  await sleep(600);
  const po = await actor();
  await busFor(po, org.eventId, 'a').post('手元に出るはず');
  await page.waitForFunction(
    () => document.querySelectorAll('#feed li').length > 0, { timeout: 20000 });
  assert(/手元に出るはず/.test(await page.textContent('#feed')), await page.textContent('#feed'));
  assert((await page.textContent('#count')) === '1', await page.textContent('#count'));
  assert(/最後のコメント/.test(await page.textContent('#stateSub')), await page.textContent('#stateSub'));
  await page.close(); await org.page.close();
});

await t('登壇を終えると投稿が止まる', async () => {
  const org = await makeEventInBrowser('終了の会', ['Track A']);
  const { page } = await open(`${HOST}/stage.html?emu=1&e=${org.eventId}&t=a`, { ctx: org.ctx });
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });
  await page.fill('#title', 'おわる登壇');
  await page.click('#startBtn');
  await page.waitForFunction(
    () => !document.getElementById('afterStart').classList.contains('hidden'), { timeout: 20000 });
  await page.click('#endBtn');
  await page.waitForFunction(
    () => /停止中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });

  const po = await actor();
  let denied = false;
  try { await busFor(po, org.eventId, 'a').post('おそい'); } catch { denied = true; }
  assert(denied, '終えたのに投稿が通った');
  await page.close(); await org.page.close();
});

// --- 観客の画面 ---------------------------------------------------------
await t('トラックが複数あれば選ばせる', async () => {
  const org = await makeEventInBrowser('選択の会', ['Track A', 'Track B']);
  const { page, errors } = await open(`${HOST}/tracks.html?emu=1&e=${org.eventId}`);
  await page.waitForFunction(
    () => document.querySelectorAll('#list a').length === 2, { timeout: 20000 });
  assert(/選択の会/.test(await page.textContent('#event')), await page.textContent('#event'));
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('#list a')].map((a) => a.getAttribute('href')));
  assert(hrefs.every((h) => /post\.html\?e=/.test(h)), `リンクが変: ${hrefs}`);
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close(); await org.page.close();
});

await t('トラックが1つなら選ばせず投稿ページへ送る', async () => {
  const org = await makeEventInBrowser('一本の会', ['Track A']);
  const { page } = await open(`${HOST}/tracks.html?emu=1&e=${org.eventId}`);
  await page.waitForFunction(() => /post\.html/.test(location.href), { timeout: 20000 });
  await page.close(); await org.page.close();
});

await t('投稿ページは開いた時点で入力欄にフォーカスが当たる', async () => {
  const org = await makeEventInBrowser('フォーカスの会', ['Track A']);
  const { page, errors } = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });
  assert(await page.evaluate(() => document.activeElement?.id) === 'text', 'フォーカスが無い');
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close(); await org.page.close();
});

await t('文字数超過でも入力は止めず、削る文字数を出す', async () => {
  // 貼り付けを黙って切ると、何を消されたか分からない
  const org = await makeEventInBrowser('文字数の会', ['Track A']);
  const { page } = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });
  await page.fill('#text', 'あ'.repeat(61));
  await page.waitForFunction(() => document.getElementById('count').dataset.over === '1', { timeout: 10000 });
  assert(await page.evaluate(() => document.getElementById('text').value.length) === 61, '勝手に切られた');
  assert((await page.textContent('#count')) === '61 / 60', await page.textContent('#count'));
  assert(/あと1文字削って/.test(await page.textContent('#note')), await page.textContent('#note'));
  assert(await page.isDisabled('#send'), '超えているのに押せる');
  await page.close(); await org.page.close();
});

await t('連投すると残り秒数がボタンと状態行の両方に出る', async () => {
  const org = await makeEventInBrowser('連投の会', ['Track A']);
  const { page } = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });
  await page.fill('#text', 'いちど');
  await page.click('#send');
  await page.waitForFunction(() => document.getElementById('text').value === '', { timeout: 20000 });
  await page.fill('#text', 'にかいめ');
  await page.waitForFunction(
    () => /あと\d+秒/.test(document.getElementById('send').textContent), { timeout: 10000 });
  assert(/あと\d+秒で次を送れます/.test(await page.textContent('#note')), await page.textContent('#note'));
  assert(await page.isDisabled('#send'), '待機中なのに押せる');
  await page.close(); await org.page.close();
});

await t('登壇終了中は理由が出て、再スキャンが要らないと伝える', async () => {
  const org = await makeEventInBrowser('終了表示の会', ['Track A']);
  // 運営本人として終える（運営はイベント配下のトラックを操作できる）
  const sp = await open(`${HOST}/stage.html?emu=1&e=${org.eventId}&t=a`, { ctx: org.ctx });
  await sp.page.waitForFunction(
    () => /受付中|停止中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });
  await sp.page.evaluate(() => window.__stage.bus.endSession());
  await sp.page.close();
  const { page } = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /次の登壇が始まると送れます/.test(document.getElementById('note')?.textContent ?? ''),
    { timeout: 20000 });
  assert(/次の登壇を待っています/.test(await page.textContent('#title')), await page.textContent('#title'));
  await page.close(); await org.page.close();
});

await t('投稿が弾幕ページに流れる（通し）', async () => {
  const org = await makeEventInBrowser('通しの会', ['Track A']);
  const ov = await open(`${HOST}/overlay.html?emu=1&e=${org.eventId}&t=a`);
  await ov.page.waitForFunction(
    () => /Track A/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 20000 });
  assert(await drawnPixels(ov.page) === 0, '最初から描かれている');

  const po = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await po.page.waitForFunction(
    () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });
  await po.page.fill('#text', '通しで流れた');
  await po.page.click('#send');
  await po.page.waitForFunction(() => document.getElementById('text').value === '', { timeout: 20000 });

  await ov.page.waitForFunction(
    () => (window.__overlay?.flow?.activeCount ?? 0) > 0, { timeout: 25000 });
  await sleep(400);
  assert(await drawnPixels(ov.page) > 500, '描かれていない');
  assert(ov.errors.length === 0, `弾幕側: ${ov.errors.join(' / ')}`);
  assert(po.errors.length === 0, `投稿側: ${po.errors.join(' / ')}`);
  await po.page.close(); await ov.page.close(); await org.page.close();
});

// --- 弾幕ページ ---------------------------------------------------------
await t('透過シェルから開いたときは操作バーを出さない', async () => {
  const org = await makeEventInBrowser('透過の会', ['Track A']);
  const { page } = await open(`${HOST}/overlay.html?emu=1&transparent=1&e=${org.eventId}&t=a`);
  await page.waitForSelector('#bar', { state: 'attached' });
  assert(await page.evaluate(() => getComputedStyle(document.getElementById('bar')).display) === 'none',
    'バーが出ている');
  assert(await page.evaluate(() => document.documentElement.classList.contains('transparent')),
    'html に透過が当たっていない');
  await page.close(); await org.page.close();
});

await t('再読み込みしても溜まっていた分は流れない', async () => {
  const org = await makeEventInBrowser('溜まりの会', ['Track A']);
  for (let i = 0; i < 3; i++) {
    const po = await actor();
    await busFor(po, org.eventId, 'a').post(`溜まっていた ${i}`);
    await sleep(60);
  }
  await sleep(500);
  const { page, errors } = await open(`${HOST}/overlay.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /Track A/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 20000 });
  await sleep(1200);
  assert(await page.evaluate(() => window.__overlay.flow.activeCount) === 0, '溜まっていた分が流れた');
  assert(await drawnPixels(page) === 0, '描かれている');
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close(); await org.page.close();
});

await t('スライドを取り込むと下敷きとして描かれる', async () => {
  const org = await makeEventInBrowser('合成の会', ['Track A']);
  const { page, ctx } = await openCapturing(`${HOST}/overlay.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /Track A/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 20000 });
  assert(await drawnPixels(page) === 0, '取り込む前から描かれている');
  await page.evaluate(() => document.getElementById('pick').click());
  await page.waitForFunction(() => document.getElementById('slide').videoWidth > 0, { timeout: 25000 });
  await sleep(700);
  assert(await drawnPixels(page) > 100000, '下敷きが描かれていない');
  await ctx.close(); await org.page.close();
});

await t('ブラウザ側で共有を止めても固まったまま映らない', async () => {
  const org = await makeEventInBrowser('停止の会', ['Track A']);
  const { page, ctx } = await openCapturing(`${HOST}/overlay.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /Track A/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 20000 });
  await page.evaluate(() => document.getElementById('pick').click());
  await page.waitForFunction(() => document.getElementById('slide').videoWidth > 0, { timeout: 25000 });
  await sleep(700);
  assert(await drawnPixels(page) > 100000, '下敷きが描かれていない');

  await page.evaluate(() => {
    const v = document.getElementById('slide');
    for (const tr of v.srcObject.getVideoTracks()) tr.stop();
    v.srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended'));
  });
  await sleep(700);
  assert(await drawnPixels(page) === 0, '止めた後も映り続けている');
  await ctx.close(); await org.page.close();
});

// --- 配色 ---------------------------------------------------------------
/** 文字と地のコントラスト比。WCAG の式。 */
function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = c.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);

/** その画面の主な文字が地から十分浮いているか。 */
async function readable(page, selectors) {
  const got = await page.evaluate((sels) => sels.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const c = getComputedStyle(el);
    let bgEl = el, bg = c.backgroundColor;
    while (bgEl && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
      bgEl = bgEl.parentElement;
      bg = bgEl ? getComputedStyle(bgEl).backgroundColor : 'rgb(255,255,255)';
    }
    return { sel, fg: c.color, bg };
  }), selectors);
  return got.filter(Boolean);
}

for (const scheme of ['light', 'dark']) {
  await t(`運営の画面が ${scheme} で読める`, async () => {
    const r = await open(`${HOST}/organizer.html?emu=1`, { scheme });
    await r.page.waitForSelector('#newEventName', { state: 'visible', timeout: 20000 });
    const pairs = await readable(r.page, ['h1.title', '.lead', 'h2.section', '#createEvent']);
    assert(pairs.length === 4, `要素が足りない: ${pairs.length}`);
    for (const { sel, fg, bg } of pairs) {
      const ratio = contrast(rgb(fg), rgb(bg));
      assert(ratio >= 4.5, `${sel} のコントラストが低い: ${ratio.toFixed(2)} (${fg} / ${bg})`);
    }
    // 地が端末の設定に合っているか
    const bodyBg = await r.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = contrast(rgb(bodyBg), [0, 0, 0]) > contrast(rgb(bodyBg), [255, 255, 255]);
    assert(light === (scheme === 'light'), `${scheme} なのに地が逆: ${bodyBg}`);
    assert(r.errors.length === 0, `エラー: ${r.errors.join(' / ')}`);
    await r.page.close();
  });

  await t(`投稿ページが ${scheme} で読める`, async () => {
    const org = await makeEventInBrowser(`配色の会 ${scheme}`, ['Track A']);
    const r = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`, { scheme });
    await r.page.waitForFunction(
      () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });
    await r.page.fill('#text', 'よめるか');
    await r.page.waitForFunction(() => !document.getElementById('send').disabled, { timeout: 10000 });
    for (const { sel, fg, bg } of await readable(r.page, ['#track', '#title', '#text', '#send'])) {
      const ratio = contrast(rgb(fg), rgb(bg));
      assert(ratio >= 4.0, `${sel} のコントラストが低い: ${ratio.toFixed(2)} (${fg} / ${bg})`);
    }
    await r.page.close(); await org.page.close();
  });
}

await t('弾幕本体は端末が明るくても暗いまま', async () => {
  // 客席から見えるものなので、端末の設定に従わせない
  const org = await makeEventInBrowser('投影の会', ['Track A']);
  const r = await open(`${HOST}/overlay.html?emu=1&e=${org.eventId}&t=a`, { scheme: 'light' });
  await r.page.waitForFunction(
    () => /Track A/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 20000 });
  const bg = await r.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert(contrast(rgb(bg), [255, 255, 255]) > 4, `明るい地になっている: ${bg}`);
  assert(await r.page.evaluate(() => document.documentElement.classList.contains('projected')),
    'projected が付いていない');
  await r.page.close(); await org.page.close();
});

await browser.close();
await capBrowser.close();
for (const [st, name, msg] of rows) console.log(`  ${st} ${name}${msg ? '\n         -> ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
