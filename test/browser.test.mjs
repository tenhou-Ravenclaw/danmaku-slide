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
    permissions: ['clipboard-read', 'clipboard-write'],
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
/**
 * 運営としてサインインする。匿名では作れない（Rules で拒んでいる）。
 * 同じブラウザの2枚目以降はセッションが復元されるので、門は出ない。
 */
async function signInAsOrganizer(page) {
  await page.waitForFunction(() =>
    document.querySelector('#signIn')?.offsetParent !== null ||
    document.querySelector('#newEventName')?.offsetParent !== null, { timeout: 25000 });
  if (await page.isVisible('#signIn')) await page.click('#signIn');
  await page.waitForSelector('#newEventName', { state: 'visible', timeout: 25000 });
}

/**
 * 運営の画面で「登壇用リンクをコピー」を押して、そのリンクを受け取る。
 *
 * 合言葉は持たない。登壇者に操作権が無いので、渡すのは画面へのリンクだけ。
 */
async function speakerLink(orgPage, row = 0) {
  // 前回の値を読まないよう、いったん空にしてから押す
  await orgPage.evaluate(() => navigator.clipboard.writeText(''));
  await orgPage.locator('#tracks tr').nth(row).locator('.btn.toSpeaker').click();
  await orgPage.waitForFunction(async () => {
    const v = await navigator.clipboard.readText();
    return /stage\.html/.test(v);
  }, { timeout: 20000 });
  const url = await orgPage.evaluate(() => navigator.clipboard.readText());
  return url.replace(/^https?:\/\/[^/]+/, HOST) + '&emu=1';
}

/** 今日。「今日」の面に出るイベントは、この日付で作る必要がある。 */
const TODAY = new Date().toISOString().slice(0, 10);

/**
 * イベントとトラックを作り、準備の画面を返す。
 *
 * ctx を渡すと、同じ運営として2つめのイベントを作れる。渡さなければ
 * 別のブラウザ文脈になり、別の運営アカウントになる（エミュレータは毎回作る）。
 */
async function makeEventInBrowser(
  name, trackNames = ['Track A'], heldOn = '2026-12-12', scheme = null, ctx = null) {
  const r = await open(`${HOST}/organizer.html?emu=1`,
    ctx ? { ctx } : (scheme ? { scheme } : {}));
  // 運営が作ったものを同じ人として触れるよう、ctx を返して使い回す
  await signInAsOrganizer(r.page);
  await r.page.fill('#newEventName', name);
  await r.page.fill('#newEventDate', heldOn);
  await r.page.click('#createEvent');
  await r.page.waitForFunction(
    () => new URL(location.href).searchParams.get('e') !== null, { timeout: 20000 });
  const eventId = new URL(r.page.url()).searchParams.get('e');
  for (const [i, n] of trackNames.entries()) {
    await r.page.fill('#newTrackName', n);
    // Enter では足さない作りなので、必ず押す
    await r.page.click('#addTrack');
    await r.page.waitForFunction(
      (want) => document.querySelectorAll('#tracks tr').length >= want, i + 1, { timeout: 20000 });
  }
  return { ...r, eventId };
}

/**
 * 今日ひらくイベントを作る。作った時点で受付中なので、そのまま投稿できる。
 *
 * makeEventInBrowser との違いは開催日だけ。今日にすると当日の面（一覧の「今日」）に出て、
 * 受付の開け閉めができるようになる。
 *
 * 以前はここで詳細の `#tracks .pill.good` が出るのを待っていた。受付の表示が
 * 当日の面へ移ったので、同じものを待つなら毎回もう1枚ページを開くことになる。
 * 待っていたのは「作った直後は受付中」で、それは createTrack が stopped:false で
 * 書くことそのもの。別の試験（作ったらすぐ送れる／受付状況がトラックの数とともに出る）が
 * 見ているので、ここでは行が届くところまでで足りる。
 */
async function makeLiveEvent(name, trackNames = ['Track A'], scheme = null) {
  return makeEventInBrowser(name, trackNames, TODAY, scheme);
}

/**
 * そのイベントの面を、もう1枚開く。
 *
 * 配るのと開け閉めするのは同じ面にある。分けるのをやめたので、
 * 「当日の面」という別の場所はもう無い。
 *
 * 作った運営と同じ ctx で開く。別の文脈で開くと別の運営になり、
 * 自分のイベントが1つも無い面が出る。
 */
async function openEvent(org) {
  const r = await open(`${HOST}/organizer.html?e=${org.eventId}&emu=1`, { ctx: org.page.context() });
  await r.page.waitForSelector('#tracks .pill', { state: 'visible', timeout: 25000 });
  return r;
}

/** 操作は必ずそのイベントの表から押す。「全部」もそのイベントにしか効かない。 */
const eventPane = (page) => page.locator('#detailView');

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

await t('見出しの下にトラック数が出る', async () => {
  // イベントとトラックは別々に届く。イベントのほうが先に来るので、
  // 片方だけで書くと「0 トラック」で固まる。
  const org = await makeEventInBrowser('件数表示の会', ['Track A', 'Track B']);
  await org.page.waitForFunction(
    () => /2 トラック/.test(document.getElementById('evMeta')?.textContent ?? ''), { timeout: 20000 });
  // 足したら増える
  await org.page.fill('#newTrackName', 'Track C');
  await org.page.click('#addTrack');
  await org.page.waitForFunction(
    () => /3 トラック/.test(document.getElementById('evMeta')?.textContent ?? ''), { timeout: 20000 });
  await org.page.close();
});

await t('登壇用リンクの説明が合言葉を名乗らない', async () => {
  // 合言葉は廃止した。「渡した人だけが操作できます」と書いたままにすると、
  // 運営が安全性を誤解する。
  const org = await makeEventInBrowser('説明の会', ['Track A']);
  const foot = await org.page.textContent('.foot');
  assert(!/渡した人だけ|新しい合言葉/.test(foot), `古い説明が残っている: ${foot}`);
  assert(/止めたり開けたりすることはできません/.test(foot), foot);
  await org.page.close();
});

await t('登壇用リンクは合言葉を持たない', async () => {
  // 登壇者に操作権が無いので、鍵を配る必要がない。
  // 何も開けない鍵を渡すと、持っている側が権限があると思い込む。
  const org = await makeEventInBrowser('リンクの会', ['Track A']);
  const a = await speakerLink(org.page);
  assert(/stage\.html/.test(a), a);
  assert(new URL(a).searchParams.get('k') === null, `合言葉が付いている: ${a}`);
  await org.page.close();
});

await t('チラシ用QRが読み取れる', async () => {
  // QR は画面に出さなくなった。刷られる紙のほうを読む。
  // 運営が実際に配るのはこの紙で、画面の絵は誰も読み取らない。
  const { page, eventId } = await makeEventInBrowser('QRの会', []);
  const [sheet] = await Promise.all([
    page.context().waitForEvent('page'),
    page.click('#printEvQr'),
  ]);
  await sheet.waitForFunction(() => document.querySelector('svg') !== null, { timeout: 20000 });
  assert(/QRの会/.test(await sheet.title()), await sheet.title());
  const rgba = await sheet.evaluate(async () => {
    const svg = document.querySelector('svg').outerHTML;
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
  // 配る URL は画面にも出ている。読み上げて渡すことがある。
  assert((await page.textContent('#evUrl')).endsWith(`/e/${eventId}`), await page.textContent('#evUrl'));
  await sheet.close(); await page.close();
});

await t('受付状況はイベントの面で、トラックごとに出る', async () => {
  // 一覧の表には「受付中 2 / 2」という要約を出していた。表ごと無くなったので、
  // 要約ではなくトラック1本ずつの状態で見る。数えるより正確で、押す場所と同じ所にある。
  const { page } = await makeLiveEvent('状況の会', ['Track A', 'Track B']);
  await page.waitForFunction(
    () => document.querySelectorAll('#tracks .pill.good').length === 2, { timeout: 25000 });
  assert(/2 トラック/.test(await page.textContent('#evMeta')), await page.textContent('#evMeta'));
  await page.close();
});

await t('冷えた状態で ?e= を開いても「見つからない」と出ない', async () => {
  // onSnapshot は最初にキャッシュ由来の空スナップショットを届けることがある。
  // それを「無い」と扱うと、存在するイベントを初めて開いた人に
  // 「イベントが見つからない」が一瞬出る。サーバーが無いと言うまで待つ。
  const org = await makeLiveEvent('初見の会', ['Track A']);
  const fresh = await open(`${HOST}/organizer.html?e=${org.eventId}&emu=1`,
    { ctx: org.page.context() });
  await fresh.page.waitForSelector('#tracks .pill', { timeout: 25000 });
  assert(!/見つからない/.test(await fresh.page.textContent('#msg')),
    await fresh.page.textContent('#msg'));
  await fresh.page.close(); await org.page.close();
});

await t('イベントのタブが並び、開いている1本だけに印が付く', async () => {
  const mine = await makeLiveEvent('こっちの会', ['Track A']);
  const other = await makeEventInBrowser(
    'となりの会', ['Track A'], TODAY, null, mine.page.context());

  // 同じ日に2本あるので、日付だけでは見分けられない。名前で選べること。
  await mine.page.waitForFunction(
    () => document.querySelectorAll('#tabs .tab').length === 2, { timeout: 25000 });
  const text = await mine.page.textContent('#tabs');
  assert(/こっちの会/.test(text) && /となりの会/.test(text), text);

  const current = await mine.page.locator('#tabs .tab[aria-current="page"]');
  assert(await current.count() === 1, '開いている1本が分からない');
  assert(/こっちの会/.test(await current.textContent()), await current.textContent());

  // タブは本物のリンク。`?e=` がそのまま残る。
  const href = await mine.page.locator(`#tabs .tab[data-event="${other.eventId}"]`).getAttribute('href');
  assert(href.includes(`e=${other.eventId}`), href);
  await other.page.close(); await mine.page.close();
});

await t('全トラックの投稿を止められる', async () => {
  const org = await makeLiveEvent('非常停止の会', ['Track A', 'Track B']);
  const day = await openEvent(org);
  await day.page.locator('#evActs .btn.stopAll').click();
  await day.page.waitForFunction((id) =>
    document.querySelectorAll('#tracks .pill.bad').length === 2,
  org.eventId, { timeout: 20000 });

  // 実際に投稿が拒否される
  const po = await actor();
  let denied = false;
  try { await busFor(po, org.eventId, 'a').post('止まったはず'); } catch { denied = true; }
  assert(denied, '止めたのに投稿が通った');
  await day.page.close(); await org.page.close();
});

await t('「全部止める」は同じ日の別のイベントに届かない', async () => {
  // 当日の操作をイベントごとに分けた理由そのもの。日付でまとめると、
  // 隣でやっている別のイベントの受付まで閉じてしまう。
  const mine = await makeLiveEvent('止めるほうの会', ['Track A']);
  const other = await makeEventInBrowser(
    'となりの会', ['Track A'], TODAY, null, mine.page.context());
  const day = await openEvent(mine);

  await day.page.locator('#evActs .btn.stopAll').click();
  await day.page.waitForFunction(() =>
    document.querySelectorAll('#tracks .pill.bad').length === 1, { timeout: 20000 });

  // となりは受付中のまま。面が1イベントぶんになったので、となりの面で見る。
  // その面は作ったときから開きっぱなしなので、開き直さない。
  await other.page.waitForSelector('#tracks .pill', { timeout: 25000 });
  assert(await other.page.locator('#tracks .pill.bad').count() === 0,
    '別のイベントまで止まった');
  const po = await actor();
  await busFor(po, other.eventId, 'a').post('となりはまだ送れる');
  await day.page.close(); await other.page.close(); await mine.page.close();
});

await t('次に足すトラック名が入っている', async () => {
  // 固定の例を置くと、空のイベントで「Track D」のような嘘を出すことになる
  const org = await makeEventInBrowser('名前の会', []);
  await org.page.waitForFunction(
    () => document.getElementById('newTrackName').value === 'Track A', { timeout: 20000 });
  await org.page.click('#addTrack');
  await org.page.waitForFunction(
    () => document.getElementById('newTrackName').value === 'Track B', { timeout: 20000 });
  await org.page.click('#addTrack');
  await org.page.waitForFunction(
    () => document.querySelectorAll('#tracks tr').length === 2, { timeout: 20000 });
  const names = await org.page.evaluate(() =>
    [...document.querySelectorAll('#tracks tr td:first-child')].map((td) => td.textContent.trim()));
  assert(names.join(',') === 'Track A,Track B', names.join(','));
  await org.page.close();
});

await t('イベント名と開催日をその場で直せる', async () => {
  const org = await makeEventInBrowser('直す前の会', []);
  await org.page.fill('#evNameInput', '直した後の会');
  await org.page.press('#evNameInput', 'Tab');
  await org.page.waitForFunction(
    () => /直した後の会/.test(document.getElementById('evName')?.textContent ?? ''), { timeout: 20000 });
  await org.page.fill('#evDateInput', '2027-03-03');
  await org.page.press('#evDateInput', 'Tab');
  await org.page.waitForFunction(
    () => /2027\/03\/03/.test(document.getElementById('evMeta')?.textContent ?? ''), { timeout: 20000 });
  await org.page.close();
});

await t('イベント名は空にできない', async () => {
  const org = await makeEventInBrowser('空にできない会', []);
  await org.page.fill('#evNameInput', '   ');
  await org.page.press('#evNameInput', 'Tab');
  await org.page.waitForFunction(
    () => /空にできません/.test(document.getElementById('msg')?.textContent ?? ''), { timeout: 20000 });
  assert(/空にできない会/.test(await org.page.textContent('#evName')), '消えてしまった');
  await org.page.close();
});

await t('イベントをトラックごと削除できる', async () => {
  const org = await makeEventInBrowser('消す会', ['Track A', 'Track B']);
  org.page.on('dialog', (d) => d.accept());
  await org.page.click('#deleteEvent');
  // 一覧へ戻る
  await org.page.waitForFunction(
    () => new URL(location.href).searchParams.get('e') === null, { timeout: 20000 });
  await org.page.waitForSelector('#newEventName', { state: 'visible', timeout: 20000 });
  await org.page.waitForFunction(
    () => !document.getElementById('tabs').textContent.includes('消す会'), { timeout: 20000 });
  await org.page.close();
});

await t('消す操作は、よく押す操作から離れている', async () => {
  // 守りたいのは「戻せない操作を、よく押す操作の隣に置かない」。
  //
  // 面を分けていたころは置き場所で守れた。分けるのをやめたので、
  // いまは距離だけが頼り。だから画面ではなく座標で測る。
  //
  // 止めるは戻せる操作なので赤くしない。この面の赤は削除だけ。
  const org = await makeLiveEvent('距離の会', ['Track A']);
  await org.page.waitForSelector('#tracks .btn.stop', { timeout: 25000 });

  const m = await org.page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const table = document.querySelector('#tracks').closest('table').getBoundingClientRect();
    return {
      // イベントの削除は、いちばんよく押す表から離れている
      evDelete: Math.round(r('#deleteEvent').top - table.bottom),
      // 行の中では「止める」と「削除」が隣り合わない
      rowGap: Math.round(r('#tracks .btn.remove').left - r('#tracks .btn.stop').right),
    };
  });
  assert(m.evDelete > 150, `イベントの削除が表に近すぎる: ${m.evDelete}px`);
  assert(m.rowGap > 100, `止めると削除が近すぎる: ${m.rowGap}px`);

  // 止めるは戻せる操作なので、削除と同じ見た目にしない。
  // 文字色では測れない（primary も danger も文字は白）ので、地の色で見る。
  const look = await org.page.evaluate(() => {
    const paint = (sel) => {
      const cs = getComputedStyle(document.querySelector(sel));
      return `${cs.backgroundColor}|${cs.borderColor}|${cs.color}`;
    };
    return { stop: paint('#tracks .btn.stop'), stopAll: paint('#evActs .btn.stopAll'),
             rowDelete: paint('#tracks .btn.remove'), evDelete: paint('#deleteEvent') };
  });
  assert(look.stop !== look.evDelete, '「止める」が削除と同じ見た目をしている');
  assert(look.stopAll !== look.evDelete, '「全部止める」が削除と同じ見た目をしている');
  await org.page.close();
});

await t('イベント詳細で受付を止めると、観客が投稿できなくなる', async () => {
  // 配るのと開け閉めするのが運営のやること全部。両方が同じ面にあることを、
  // 画面ではなく実際に投稿が弾かれるかどうかで確かめる。
  const org = await makeLiveEvent('詳細で止める会', ['Track A']);
  await org.page.waitForSelector('#tracks .btn.stop', { timeout: 25000 });
  await org.page.click('#tracks .btn.stop');
  await org.page.waitForSelector('#tracks .pill.bad', { timeout: 20000 });

  const po = await actor();
  let denied = false;
  try { await busFor(po, org.eventId, 'a').post('止まったはず'); } catch { denied = true; }
  assert(denied, '止めたのに投稿が通った');

  // 戻せること。止めるのが戻せる操作であることが、赤くしない理由そのもの。
  await org.page.click('#tracks .btn.resume');
  await org.page.waitForSelector('#tracks .pill.good', { timeout: 20000 });
  await org.page.close();
});

await t('イベント詳細のまとめ操作は、表から離れている', async () => {
  // 1トラックだけ止めるつもりで全部止める事故は、距離でしか防げない。
  const org = await makeLiveEvent('まとめの会', ['Track A', 'Track B']);
  await org.page.waitForSelector('#evActs .btn.stopAll', { timeout: 25000 });
  const sep = await org.page.evaluate(() => {
    const acts = document.querySelector('#evActs .btn.stopAll').getBoundingClientRect();
    const row = document.querySelector('#tracks tr .btn.stop').getBoundingClientRect();
    return row.top - acts.bottom;
  });
  assert(sep > 20, `まとめ操作が行の操作に近すぎる: ${Math.round(sep)}px`);

  await org.page.click('#evActs .btn.stopAll');
  await org.page.waitForFunction(
    () => document.querySelectorAll('#tracks .pill.bad').length === 2, { timeout: 20000 });
  await org.page.close();
});

await t('終わったイベントはタブに並ばない', async () => {
  // 開く理由が無いものを並べ続けると、使うほどタブが溢れる。
  // ただし消しもしない。「終わった」は開催日から導いているだけなので、
  // 日付を打ち間違えたイベントが黙って消えると作り直すしかなくなる。
  const past = await makeEventInBrowser('去年の会', [], '2020-01-01');
  const soon = await makeEventInBrowser('来年の会', [], '2027-12-12', null, past.page.context());
  const list = await open(`${HOST}/organizer.html?emu=1`, { ctx: past.page.context() });

  await list.page.waitForFunction(
    () => document.querySelectorAll('#tabs .tab').length === 1, { timeout: 25000 });
  assert(/来年の会/.test(await list.page.textContent('#tabs')), await list.page.textContent('#tabs'));
  assert(!/去年の会/.test(await list.page.textContent('#tabs')), '終わったものが並んでいる');

  // 戻り口から開ける。日付を直して戻せる道が残っていること。
  const back = list.page.locator('#showPast');
  assert(/終わったもの（1）/.test(await back.textContent()), await back.textContent());
  await back.click();
  await list.page.waitForFunction(
    () => document.querySelectorAll('#tabs .tab').length === 2, { timeout: 20000 });
  assert(/去年の会/.test(await list.page.textContent('#tabs')), '戻り口から出てこない');
  await list.page.close(); await soon.page.close(); await past.page.close();
});

// --- 登壇者の画面 -------------------------------------------------------
await t('リンクが不完全なら理由が出る', async () => {
  const { page } = await open(`${HOST}/stage.html?emu=1`);
  await page.waitForFunction(
    () => /リンクが正しくありません/.test(document.getElementById('stateText')?.textContent ?? ''),
    { timeout: 20000 });
  await page.close();
});

await t('登壇者ページは「まだ流していない」から始まる', async () => {
  const org = await makeEventInBrowser('手順の会', ['Track A']);
  const { page, errors } = await open(await speakerLink(org.page));
  await page.waitForFunction(
    () => /受付中|停止中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });
  assert(await page.getAttribute('#flowbox', 'data-state') === 'idle', 'はじめから流れている扱いになっている');
  assert(/まだ流していません/.test(await page.textContent('#flowTitle')), await page.textContent('#flowTitle'));
  assert(await page.isVisible('#openApp') && await page.isVisible('#browserWay'), '流し方を選べない');
  assert(/Track A/.test(await page.textContent('#trackName')), await page.textContent('#trackName'));
  assert(/手順の会/.test(await page.textContent('#eventName')), await page.textContent('#eventName'));
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close(); await org.page.close();
});

await t('ブラウザで流すと「流しています」に変わり、選択肢は畳まれる', async () => {
  // 同じタブで遷移するとこの画面が消え、合図も返らない。別の窓で開く。
  const org = await makeLiveEvent('流すの会', ['Track A']);
  const { page } = await open(await speakerLink(org.page));
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });

  const [ovl] = await Promise.all([
    page.context().waitForEvent('page'),
    page.click('#browserWay'),
  ]);
  await ovl.waitForLoadState('load');

  await page.waitForFunction(
    () => document.getElementById('flowbox')?.dataset.state === 'live', { timeout: 25000 });
  assert(/流しています/.test(await page.textContent('#flowTitle')), await page.textContent('#flowTitle'));
  // 決め終わったら選択肢は引っ込む
  assert(!await page.isVisible('#openApp'), '流し方の選択肢が出たまま');
  assert(await page.isVisible('#changeWay'), '変える道が無い');

  // 変えたい人は戻せる
  await page.click('#changeWay');
  await page.waitForFunction(() => document.getElementById('openApp')?.offsetParent !== null,
    { timeout: 20000 });
  await ovl.close(); await page.close(); await org.page.close();
});

await t('アプリに渡したら、渡したことだけを言う', async () => {
  // Electron は別の窓で開くので opener が無く、合図が返らない。
  // こちらから分かるのは「渡した」ところまでなので、そこまでを出す。
  const org = await makeLiveEvent('渡すの会', ['Track A']);
  const { page } = await open(await speakerLink(org.page));
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });
  await page.evaluate(() => document.getElementById('openApp').click());
  await page.waitForFunction(
    () => document.getElementById('flowbox')?.dataset.state === 'handoff', { timeout: 20000 });
  const title = await page.textContent('#flowTitle');
  assert(/渡しました/.test(title), title);
  assert(!/流しています/.test(title), `確かめられないのに流していると言っている: ${title}`);
  // 開かなかった人のために、入手と別の道を残す
  assert(await page.isVisible('#getApp') && await page.isVisible('#browserWay'), '逃げ道が無い');
  await page.close(); await org.page.close();
});

await t('「アプリで開く」は danmaku:// を指す', async () => {
  const org = await makeEventInBrowser('アプリの会', ['Track A']);
  const { page } = await open(await speakerLink(org.page));
  await page.waitForFunction(
    () => document.getElementById('openApp')?.getAttribute('href')?.startsWith('danmaku:'),
    { timeout: 20000 });
  const href = await page.getAttribute('#openApp', 'href');
  const u = new URL(href);
  assert(u.searchParams.get('e') === org.eventId, href);
  assert(u.searchParams.get('t') === 'a', href);
  assert(u.searchParams.get('k') === null, `合言葉が付いている: ${href}`);
  await page.close(); await org.page.close();
});

await t('登壇者の画面に状態を変える操作が無い', async () => {
  // 流し方は選べるが、登壇の開始・終了も投稿の開け閉めも持たない。
  // 壇上で押し間違える場所を作らない。
  const org = await makeLiveEvent('手ぶらの会', ['Track A']);
  const { page, errors } = await open(await speakerLink(org.page));
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });
  for (const id of ['startBtn', 'endBtn', 'stopBtn', 'resumeBtn']) {
    assert(await page.locator(`#${id}`).count() === 0, `${id} がある`);
  }
  const words = await page.evaluate(() =>
    [...document.querySelectorAll('a, button')].map((b) => b.textContent.trim()).join(' / '));
  assert(!/はじめる|終える|投稿を止める|投稿を受け付ける/.test(words), `操作が残っている: ${words}`);
  // コメント一覧の側には何も置かない。
  //
  // 以前は main 全体を見ていた。「どこに流すか」が上バーの隅の箱にあり、
  // main はコメント一覧だけだったため、それで同じ意味になっていた。
  // いまは流し方の選択が main の主役なので（登壇前にそれが画面の仕事）、
  // 見張る範囲をコメント一覧そのものに寄せる。
  // 守りたいのは「読んでいる最中に押し間違える場所を作らない」ほう。
  assert(await page.evaluate(() =>
    document.querySelectorAll('.feedcard button, .feedcard input, .feedcard a').length) === 0,
    'コメント欄に操作がある');
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close(); await org.page.close();
});

await t('作ったらすぐ送れる（運営の開け忘れで止まらない）', async () => {
  // 止めた状態で作ると、開け忘れたときに本番中に観客が投稿できない。
  // いちばん困るときに、いちばん気づきにくい形で壊れる。
  const org = await makeEventInBrowser('できたての会', ['Track A']);
  const po = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await po.page.waitForFunction(
    () => /受付中/.test(document.getElementById('title')?.textContent ?? ''), { timeout: 20000 });
  await po.page.fill('#text', 'もう送れる');
  await po.page.waitForFunction(() => !document.getElementById('send').disabled, { timeout: 20000 });
  await po.page.click('#send');
  await po.page.waitForFunction(
    () => /送信しました/.test(document.getElementById('note')?.textContent ?? ''), { timeout: 20000 });
  await po.page.close(); await org.page.close();
});

await t('全トラックを止めてから、まとめて開け直せる', async () => {
  const org = await makeLiveEvent('開け直しの会', ['Track A', 'Track B']);
  const day = await openEvent(org);
  await day.page.locator('#evActs .btn.stopAll').click();
  await day.page.waitForFunction((id) =>
    document.querySelectorAll('#tracks .pill.bad').length === 2,
  org.eventId, { timeout: 20000 });
  const po = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await po.page.waitForFunction(
    () => /受付を待っています/.test(document.getElementById('title')?.textContent ?? ''),
    { timeout: 20000 });
  await po.page.fill('#text', 'いまは無理');
  await po.page.waitForTimeout(400);
  assert(await po.page.isDisabled('#send'), '止めたのに押せる');

  await day.page.locator('#evActs .btn.openAll').click();
  await po.page.waitForFunction(
    () => /受付中/.test(document.getElementById('title')?.textContent ?? ''), { timeout: 20000 });
  await po.page.waitForFunction(() => !document.getElementById('send').disabled, { timeout: 20000 });
  await po.page.close(); await day.page.close(); await org.page.close();
});

await t('届いたコメントが手元に出て、件数が増える', async () => {
  const org = await makeLiveEvent('コメントの会', ['Track A']);
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

await t('投稿を止めるのは運営だけ（登壇者の画面に操作はない）', async () => {
  const org = await makeLiveEvent('止める会', ['Track A']);
  const day = await openEvent(org);
  const sp = await open(await speakerLink(org.page));
  await sp.page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });
  // 登壇者には止める手段を持たせない。間違って押せる場所に置かないこと自体を見る。
  assert(await sp.page.locator('#stopBtn').count() === 0, '登壇者に停止ボタンがある');
  assert(await sp.page.locator('#resumeBtn').count() === 0, '登壇者に再開ボタンがある');
  assert(await sp.page.locator('#startBtn').count() === 0, '登壇者に開始ボタンがある');
  assert(await sp.page.locator('#endBtn').count() === 0, '登壇者に終了ボタンがある');

  const aud = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await aud.page.waitForFunction(
    () => /受付中/.test(document.getElementById('title')?.textContent ?? ''), { timeout: 20000 });

  await day.page.locator('#tracks .btn.stop').click();

  await aud.page.waitForFunction(
    () => /投稿を受け付けていません/.test(document.getElementById('note')?.textContent ?? ''),
    { timeout: 20000 });
  await aud.page.fill('#text', 'いま送れないはず');
  assert(await aud.page.isDisabled('#send'), '止めたのに送れる');

  // 登壇者にも理由と、誰に言えばいいかが出る
  await sp.page.waitForFunction(
    () => /運営が止めています/.test(document.getElementById('stateReason')?.textContent ?? ''),
    { timeout: 20000 });
  assert(/停止中/.test(await sp.page.textContent('#stateText')), await sp.page.textContent('#stateText'));
  assert(/再開は運営へ/.test(await sp.page.textContent('#stateReason')), await sp.page.textContent('#stateReason'));
  // 見出しと理由は別の行。横に繋げると読めない。
  assert(await sp.page.evaluate(() => {
    const t = document.getElementById('stateText').getBoundingClientRect();
    const r = document.getElementById('stateReason').getBoundingClientRect();
    return r.top >= t.bottom - 1;
  }), '停止の理由が見出しと同じ行に出ている');

  // サーバも拒む（画面だけの制限にしない）
  const po = await actor();
  let denied = false;
  try { await busFor(po, org.eventId, 'a').post('直接でも通らない'); } catch { denied = true; }
  assert(denied, '止めたのにサーバが受けた');

  // 運営が戻せば送れる
  await day.page.locator('#tracks .btn.resume').click();
  await aud.page.waitForFunction(
    () => document.getElementById('send')?.disabled === false, { timeout: 20000 });
  await aud.page.close(); await sp.page.close();
  await day.page.close(); await org.page.close();
});

await t('Enter では足さない（押し間違いで増やさない）', async () => {
  const org = await makeEventInBrowser('Enterの会', []);
  await org.page.fill('#newTrackName', 'Track Z');
  await org.page.press('#newTrackName', 'Enter');
  await org.page.waitForTimeout(1200);
  const n = await org.page.evaluate(() => document.querySelectorAll('#tracks tr').length);
  assert(n === 0, `Enter で増えた: ${n}`);
  await org.page.click('#addTrack');
  await org.page.waitForFunction(() => document.querySelectorAll('#tracks tr').length === 1, { timeout: 20000 });
  await org.page.close();
});

await t('トラックを削除できる', async () => {
  const org = await makeEventInBrowser('削除の会', ['Track A', 'Track B']);
  org.page.on('dialog', (d) => d.accept());
  await org.page.locator('#tracks tr').first().locator('.btn.remove').click();
  await org.page.waitForFunction(
    () => document.querySelectorAll('#tracks tr').length === 1, { timeout: 20000 });
  const left = await org.page.textContent('#tracks');
  assert(/Track B/.test(left) && !/Track A/.test(left), `残り方が変: ${left}`);
  await org.page.close();
});

await t('渡す相手ごとにボタンが分かれている', async () => {
  // 取り違えると、観客に操作用のリンクを配ることになる
  const org = await makeEventInBrowser('リンク区別の会', ['Track A']);
  const row = org.page.locator('#tracks tr').first();
  assert(await row.locator('.btn.toSpeaker').count() === 1, '登壇用が無い');
  assert(await row.locator('.btn.toAudience').count() === 2, '観客用が足りない');
  assert(await row.locator('input').count() === 0, '演題の入力欄が残っている');
  // 見える文字は列見出しに任せて短い。区別は読み上げ用の名前が持つ。
  const spoken = await row.locator('.btn.toSpeaker').getAttribute('aria-label');
  assert(/登壇用リンク/.test(spoken ?? ''), spoken);
  for (const i of [0, 1]) {
    const a = await row.locator('.btn.toAudience').nth(i).getAttribute('aria-label');
    assert(/投稿(URL|QR)/.test(a ?? ''), a);
  }
  await org.page.close();
});

await t('サインインしていないと作る画面を出さない', async () => {
  const r = await open(`${HOST}/organizer.html?emu=1`);
  await r.page.waitForSelector('#signIn', { state: 'visible', timeout: 20000 });
  assert(await r.page.isHidden('#newEventName'), 'サインイン前に作れる');
  await r.page.close();
});

// --- 観客の画面 ---------------------------------------------------------
await t('/e/<id> の形でも開ける', async () => {
  // rewrite で tracks.html が返る。相対パスで読むと /e/lib/... を探しに行く。
  const org = await makeEventInBrowser('パスの会', ['Track A', 'Track B']);
  const { page, errors } = await open(`${HOST}/e/${org.eventId}?emu=1`);
  await page.waitForFunction(
    () => document.querySelectorAll('#list a').length === 2, { timeout: 20000 });
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close(); await org.page.close();
});

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
  const org = await makeLiveEvent('フォーカスの会', ['Track A']);
  const { page, errors } = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });
  assert(await page.evaluate(() => document.activeElement?.id) === 'text', 'フォーカスが無い');
  assert(errors.length === 0, `エラー: ${errors.join(' / ')}`);
  await page.close(); await org.page.close();
});

await t('文字数超過でも入力は止めず、削る文字数を出す', async () => {
  // 貼り付けを黙って切ると、何を消されたか分からない
  const org = await makeLiveEvent('文字数の会', ['Track A']);
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
  const org = await makeLiveEvent('連投の会', ['Track A']);
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

await t('停止中は理由が出て、再スキャンが要らないと伝える', async () => {
  const org = await makeLiveEvent('停止表示の会', ['Track A']);
  const day = await openEvent(org);
  await day.page.locator('#tracks .btn.stop').click();
  await day.page.waitForFunction((id) =>
    document.querySelectorAll('#tracks .pill.bad').length === 1,
  org.eventId, { timeout: 20000 });
  const { page } = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /投稿を受け付けていません/.test(document.getElementById('note')?.textContent ?? ''),
    { timeout: 20000 });
  assert(/受付を待っています/.test(await page.textContent('#title')), await page.textContent('#title'));
  await page.close(); await day.page.close(); await org.page.close();
});

await t('投稿が弾幕ページに流れる（通し）', async () => {
  const org = await makeLiveEvent('通しの会', ['Track A']);
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
  const org = await makeLiveEvent('溜まりの会', ['Track A']);
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

/**
 * その画面の主な文字が地から十分浮いているか。
 *
 * 地は半透明のことがある（状態の pill は surface の上に .14 の色を重ねている）。
 * 重ねた結果の色で測らないと、文字色をほぼ同じ薄い色と比べてしまって
 * 1.00 のような嘘の値が出る。下から順に合成する。
 */
async function readable(page, selectors) {
  const got = await page.evaluate((sels) => {
    const parse = (v) => {
      const n = (v ?? '').match(/[\d.]+/g)?.map(Number) ?? [];
      if (n.length < 3) return null;
      return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
    };
    /** 上を下に重ねる。a は上の不透明度。 */
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    return sels.map((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      // 自分から上に向かって、不透明な地に当たるまで層を集める
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (!c || c.a === 0) continue;
        layers.push(c);
        if (c.a === 1) break;
      }
      // 最後まで不透明が無ければ白を敷く
      let bg = layers.pop() ?? { r: 255, g: 255, b: 255, a: 1 };
      while (layers.length) bg = over(layers.pop(), bg);
      const fg = parse(getComputedStyle(el).color);
      // 文字色自体が半透明なら、合成後の地に重ねる
      const text = fg.a < 1 ? over(fg, bg) : fg;
      const fmt = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
      return { sel, fg: fmt(text), bg: fmt(bg) };
    });
  }, selectors);
  return got.filter(Boolean);
}

/**
 * ボタンが押す前と、マウスを乗せたときの両方で読めるか。
 *
 * 前は地だけを差し替えるホバーがあり、塗りつぶしのボタンは
 * 文字が元の色のまま残って読めなくなっていた。
 * 止まっている絵だけを見ていると見つからないので、両方の状態で測る。
 */
async function readableWhileHovering(page, sel) {
  const out = [];
  const rest = (await readable(page, [sel]))[0];
  if (rest) out.push({ ...rest, state: '押す前' });
  await page.hover(sel);
  await page.waitForTimeout(120);
  const hot = (await readable(page, [sel]))[0];
  if (hot) out.push({ ...hot, state: 'ホバー' });
  // 次の計測に残さない
  await page.mouse.move(0, 0);
  return out;
}

for (const scheme of ['light', 'dark']) {
  await t(`ボタンはホバーしても読める（運営・${scheme}）`, async () => {
    const org = await makeLiveEvent(`ボタンの会 ${scheme}`, ['Track A'], scheme);
    const day = await openEvent(org);
    // 塗りつぶし・枠線・文字だけ、種類をひととおり見る。
    // 止めるボタンは当日の面、配り物と消すボタンは準備の面にある。
    const targets = [
      [day.page, '#evActs .btn.stopAll', 'caution'],
      [org.page, '#addTrack', 'primary'],
      [org.page, '#copyEvUrl', 'quiet'],
      [org.page, '#tracks tr .btn.toSpeaker', '既定'],
      [org.page, '#tracks tr .btn.remove', '消す'],
    ];
    for (const [page, sel, kind] of targets) {
      for (const { fg, bg, state } of await readableWhileHovering(page, sel)) {
        const ratio = contrast(rgb(fg), rgb(bg));
        assert(ratio >= 4.5,
          `${kind}（${sel}）の${state}が読めない: ${ratio.toFixed(2)} (${fg} / ${bg})`);
      }
    }
    await day.page.close(); await org.page.close();
  });

  await t(`送信ボタンはホバーしても読める（${scheme}）`, async () => {
    const org = await makeLiveEvent(`送信配色の会 ${scheme}`, ['Track A']);
    const r = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`, { scheme });
    await r.page.waitForFunction(
      () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });
    await r.page.fill('#text', 'よめるか');
    await r.page.waitForFunction(() => !document.getElementById('send').disabled, { timeout: 20000 });
    for (const { fg, bg, state } of await readableWhileHovering(r.page, '#send')) {
      const ratio = contrast(rgb(fg), rgb(bg));
      assert(ratio >= 4.5, `送信の${state}が読めない: ${ratio.toFixed(2)} (${fg} / ${bg})`);
    }
    await r.page.close(); await org.page.close();
  });

  await t(`運営の画面が ${scheme} で読める`, async () => {
    const r = await open(`${HOST}/organizer.html?emu=1`, { scheme });
    await signInAsOrganizer(r.page);
    // 一覧の見出し（h2.section）はタブになった。タブは常にある `＋` で見る。
    const pairs = await readable(r.page, ['h1.title', '.lead', '#newTab', '#createEvent']);
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

  await t(`状態の表示が ${scheme} で読める`, async () => {
    // 状態は色だけでなく文字でも示している。その文字が地から浮いていないと
    // 「受付中なのか停止中なのか」が読めない。--muted の 4.11:1 もここで見つけた。
    // 2本にして、受付中と停止中を同じ画面に並べる。片方だけでは、
    // 並んだときに見分けが付くかどうかを測れない。
    const org = await makeLiveEvent(`状態配色の会 ${scheme}`, ['Track A', 'Track B'], scheme);
    const day = await openEvent(org);
    await day.page.locator('#tracks .btn.stop').nth(0).click();
    await day.page.waitForFunction((id) =>
      document.querySelectorAll('#tracks .pill.bad').length === 1,
    org.eventId, { timeout: 20000 });
    for (const { sel, fg, bg } of await readable(day.page,
      ['#tracks .pill.bad', '#tracks .pill.good', '.pill.mute'])) {
      const ratio = contrast(rgb(fg), rgb(bg));
      assert(ratio >= 4.5, `${sel} のコントラストが低い: ${ratio.toFixed(2)} (${fg} / ${bg})`);
    }
    await day.page.close(); await org.page.close();
  });

  await t(`投稿ページが ${scheme} で読める`, async () => {
    const org = await makeLiveEvent(`配色の会 ${scheme}`, ['Track A']);
    const r = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`, { scheme });
    await r.page.waitForFunction(
      () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });
    await r.page.fill('#text', 'よめるか');
    await r.page.waitForFunction(() => !document.getElementById('send').disabled, { timeout: 10000 });
    for (const { sel, fg, bg } of await readable(r.page,
      ['#track', '#title', '#text', '#send', 'label[for="text"] > span'])) {
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

// --- 読み上げと指で押せる大きさ -----------------------------------------
await t('入力欄のラベルが見えている', async () => {
  // placeholder は打ち始めた瞬間に消える。それだけに頼ると
  // 「何の欄だったか」が分からなくなる。
  const org = await makeLiveEvent('ラベルの会', ['Track A']);
  const { page } = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });

  const label = page.locator('label[for="text"]');
  assert(await label.count() === 1, 'ラベルが無い');
  assert(await label.isVisible(), 'ラベルが見えていない');
  assert((await label.textContent()).trim().length > 0, 'ラベルが空');

  // 打ち始めてもラベルは残る（placeholder との違いはここ）
  await page.fill('#text', 'うってみる');
  assert(await label.isVisible(), '打ったらラベルが消えた');

  // 入力欄と結びついていること
  assert(await page.evaluate(() => {
    const t = document.getElementById('text');
    return t.labels.length === 1 && t.labels[0].textContent.trim() === 'コメント';
  }), 'ラベルが入力欄に結びついていない');

  // 横幅が親から縮んでいない（flex の子から label の中へ移したので）
  assert(await page.evaluate(() => {
    const t = document.getElementById('text');
    return t.getBoundingClientRect().width > t.parentElement.getBoundingClientRect().width - 2;
  }), '入力欄が縮んでいる');
  await page.close(); await org.page.close();
});

await t('送れない理由が入力欄に紐づいている', async () => {
  // 離れた場所に出すと、何が悪いのか結びつかない
  const org = await makeLiveEvent('読み上げの会', ['Track A']);
  const { page } = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });

  const described = await page.getAttribute('#text', 'aria-describedby');
  assert(/\bnote\b/.test(described ?? ''), `note に紐づいていない: ${described}`);
  assert(await page.getAttribute('#note', 'role') === 'status', '状態として読み上げられない');

  await page.fill('#text', 'あ'.repeat(61));
  await page.waitForFunction(
    () => document.getElementById('text').getAttribute('aria-invalid') === 'true', { timeout: 10000 });
  await page.fill('#text', 'みじかい');
  await page.waitForFunction(
    () => document.getElementById('text').getAttribute('aria-invalid') === 'false', { timeout: 10000 });
  await page.close(); await org.page.close();
});

await t('送信ボタンは指で押せる大きさがある', async () => {
  const org = await makeLiveEvent('大きさの会', ['Track A']);
  const { page } = await open(`${HOST}/post.html?emu=1&e=${org.eventId}&t=a`);
  await page.waitForFunction(
    () => /Track A/.test(document.getElementById('track')?.textContent ?? ''), { timeout: 20000 });
  const box = await page.locator('#send').boundingBox();
  assert(box.height >= 44, `高さが足りない: ${box.height}`);
  await page.close(); await org.page.close();
});

await t('件数は数字だけでなく文になっている', async () => {
  // 「3」とだけ読まれても何のことか分からない
  const org = await makeLiveEvent('件数の会', ['Track A']);
  const { page } = await open(await speakerLink(org.page));
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });
  const label = await page.locator('#countLabel');
  assert(/件 届いています/.test((await label.textContent()).trim()), await label.textContent());
  await page.close(); await org.page.close();
});

await t('読み上げる場所は画面にひとつだけ', async () => {
  // 登壇者の画面には毎秒書き換わる文字がある（最後のコメント N秒前）。
  // それを読み上げ対象に入れると、登壇中ずっと喋り続けることになる。
  const org = await makeLiveEvent('読み上げの会', ['Track A']);
  const { page } = await open(await speakerLink(org.page));
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('stateText')?.textContent ?? ''), { timeout: 20000 });

  const live = await page.evaluate(() =>
    [...document.querySelectorAll('[role="status"], [aria-live]')]
      .filter((e) => e.closest('[aria-hidden="true"]') === null)
      .map((e) => e.id || e.className));
  assert(live.length === 1, `読み上げ対象が複数ある: ${live.join(' / ')}`);
  assert(live[0] === 'state', `読み上げ対象が状態ではない: ${live[0]}`);

  // 毎秒書き換わる側が読み上げの木から外れていること
  assert(await page.getAttribute('#stateSub', 'aria-hidden') === 'true',
    '毎秒書き換わる文字が読み上げに入っている');
  // 止まっている理由は変わらないので、読み上げの中に残す
  assert(await page.evaluate(() =>
    document.getElementById('state').contains(document.getElementById('stateReason'))),
    '止まっている理由が読み上げから外れている');
  await page.close(); await org.page.close();
});

await t('終了したイベントもキーボードで開ける', async () => {
  // 前は開催予定と終了済みで行の作りが分かれていて、終了済みだけ
  // tabIndex と Enter が抜けていた（マウスでしか開けなかった）。
  // タブは本物のリンクなので、作りが分かれようが無い。それを確かめる。
  const org = await makeEventInBrowser('過去の会', [], '2020-01-01');
  const list = await open(`${HOST}/organizer.html?emu=1`, { ctx: org.page.context() });
  await list.page.waitForSelector('#showPast:not(.hidden)', { timeout: 25000 });
  await list.page.click('#showPast');
  const tab = list.page.locator(`#tabs .tab[data-event="${org.eventId}"]`);
  await tab.waitFor({ state: 'visible', timeout: 20000 });
  await tab.focus();
  await list.page.keyboard.press('Enter');
  await list.page.waitForFunction(
    () => new URL(location.href).searchParams.get('e') !== null, { timeout: 20000 });
  await list.page.close(); await org.page.close();
});

await t('トラックの表が横スクロール無しで収まる', async () => {
  // 列見出しが意味を持っているので、ボタンの文字はそこまで繰り返さない。
  // 「登壇用リンクをコピー」を全列ぶん並べると 1280px でも 115px はみ出していた。
  // 表は1つになったが、代わりに「受付」の列が増えている。いちばん狭い所で見る。
  const org = await makeLiveEvent('幅の会', ['Track A', 'Track B']);
  await org.page.waitForFunction(
    () => document.querySelectorAll('#tracks tr').length === 2, { timeout: 20000 });
  for (const [page, where] of [[org.page, 'イベントの面']]) {
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const over = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.scroller')]
        .filter((s) => s.offsetParent !== null)
        .map((s) => Math.round(s.querySelector('table').scrollWidth - s.clientWidth))));
      assert(over <= 0, `${where}の表が ${width}px で ${over}px はみ出している`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  }
  await org.page.close();
});

await t('短くしたボタンでも何のボタンか読み上げられる', async () => {
  // 見える文字は列見出しに任せて短い。ボタンだけを辿る読み方では
  // 列見出しが付いてこないので、読み上げ用の名前に全部の意味を持たせる。
  // 準備と当日の、どちらの行も同じ決まりで作る。
  const org = await makeLiveEvent('名前の会', ['Track A']);
  const day = await openEvent(org);
  const spoken = (row) => row.evaluate((tr) =>
    [...tr.querySelectorAll('button')].map((b) => ({
      見える: b.textContent.trim(),
      読み上げ: b.getAttribute('aria-label') ?? b.textContent.trim(),
    })));

  const prep = await spoken(org.page.locator('#tracks tr').first());
  const live = await spoken(day.page.locator('#tracks tr').first());
  for (const n of [...prep, ...live]) {
    assert(/Track A/.test(n.読み上げ), `どのトラックか分からない: ${JSON.stringify(n)}`);
    assert(n.読み上げ.length > n.見える.length, `読み上げが短いまま: ${JSON.stringify(n)}`);
  }
  assert(prep.some((n) => n.見える === 'リンクをコピー'), JSON.stringify(prep));
  assert(prep.some((n) => n.見える === 'URLをコピー'), JSON.stringify(prep));
  assert(live.some((n) => n.見える === '止める'), JSON.stringify(live));
  await day.page.close(); await org.page.close();
});

await t('表に見出しの対応と説明がある', async () => {
  // 準備の表と当日の表、どちらも列見出しと説明を持つ。
  const org = await makeLiveEvent('表の会', ['Track A']);
  const day = await openEvent(org);
  const look = (page, sel) => page.evaluate((s) =>
    [...document.querySelectorAll(s)].map((tb) => {
      const table = tb.closest('table');
      return {
        scopes: [...table.querySelectorAll('thead th')].map((th) => th.getAttribute('scope')),
        caption: table.querySelector('caption')?.textContent ?? null,
      };
    }), sel);

  const tables = [...await look(org.page, '#tracks'), ...await look(day.page, '#tracks')];
  assert(tables.length === 2, `表が足りない: ${tables.length}`);
  let cols = 0;
  for (const tb of tables) {
    assert(tb.caption, `表の説明が無い: ${JSON.stringify(tb)}`);
    assert(tb.scopes.every((v) => v === 'col'), `scope の無い列がある: ${tb.scopes}`);
    cols += tb.scopes.length;
  }
  assert(cols >= 5, `列の対応が足りない: ${cols}`);
  await day.page.close(); await org.page.close();
});

await t('狭い画面でも本文が横にずれない', async () => {
  // 表は画面が狭いとはみ出す。本文ごとスクロールさせない。
  // 当日の面も見る。イベント名と表が並ぶぶん、はみ出す余地はこちらのほうが大きい。
  const org = await makeLiveEvent('狭い画面の会', ['Track A']);
  const day = await openEvent(org);
  for (const page of [org.page, day.page]) {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 1, `横にはみ出している: ${overflow}px`);
  }
  await day.page.close(); await org.page.close();
});

await browser.close();
await capBrowser.close();
for (const [st, name, msg] of rows) console.log(`  ${st} ${name}${msg ? '\n         -> ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
