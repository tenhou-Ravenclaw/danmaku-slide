// Chrome 拡張を実際に読み込んで、発表ページに弾幕が差し込まれるかを見る。
//
// 実物の Google スライドは自動で開けないので、同じ URL 構造の模擬ページを使う。
// 確かめたいのは「差し込めるか」と「クリックが透けるか」で、
// どちらも相手が Google のページかどうかには依存しない。
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as sdk from 'firebase/firestore';
import { initializeApp } from 'firebase/app';
import {
  getAuth, signInAnonymously, connectAuthEmulator, createUserWithEmailAndPassword,
} from 'firebase/auth';
import { createBus, createEventBus } from '../../public/lib/bus.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, '../../.ext-test');   // 本番向けの extension/ を上書きしない
const CONFIG = JSON.parse(await readFile(join(here, '../../.firebase-config.json'), 'utf8'));

let pass = 0, fail = 0;
const rows = [];
async function t(name, fn) {
  try { await fn(); pass++; rows.push(['ok  ', name, '']); }
  catch (e) { fail++; rows.push([' NG ', name, String(e?.message ?? e).slice(0, 200)]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 発表ページと同じ形の URL で模擬ページを配る
const PORT = 5097;
const srv = createServer(async (req, res) => {
  if (/\/presentation\/d\/[^/]+\/present/.test(req.url)) {
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    // 本物の Google スライドは厳しい CSP を返す。content script からの通信が
    // それに縛られるなら、ここで再現して落ちるはず。
    if (/strict/.test(req.url)) {
      headers['Content-Security-Policy'] =
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
        "frame-ancestors 'self'";
    }
    res.writeHead(200, headers);
    res.end(await readFile(join(here, 'fake-slides.html')));
    return;
  }
  if (/\/presentation\/d\/[^/]+\/edit/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>編集画面</title><body>編集中</body>');
    return;
  }
  res.writeHead(404); res.end('x');
}).listen(PORT);
const PRESENT = `http://127.0.0.1:${PORT}/presentation/d/deck1/present`;
const PRESENT_STRICT = `http://127.0.0.1:${PORT}/presentation/d/deck2/present?strict=1`;
const EDIT = `http://127.0.0.1:${PORT}/presentation/d/deck1/edit`;

// --- エミュレータ側にトラックを作る --------------------------------------
let seq = 0;
/**
 * @param {boolean} staff 運営は匿名では作れない（Rules で拒んでいる）。
 */
async function person(staff = false) {
  const app = initializeApp({ ...CONFIG, authDomain: 'localhost' }, `x${++seq}`);
  const db = sdk.initializeFirestore(app, {});
  sdk.connectFirestoreEmulator(db, '127.0.0.1', 8181);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const { user } = staff
    ? await createUserWithEmailAndPassword(auth, `staff-${seq}-${Date.now()}@example.test`, 'pass1234')
    : await signInAnonymously(auth);
  return { db, uid: user.uid, events: createEventBus(sdk, { db, uid: user.uid }) };
}
const EVENT = 'ext-event', TRACK = 'a';
const staff = await person(true);
await staff.events.createEvent(EVENT, { name: 'Extension Event' });
await staff.events.createTrack(EVENT, TRACK, { name: 'Extension Track' });
// 開始していないトラックには投稿できない
await createBus(sdk, { db: staff.db, eventId: EVENT, trackId: TRACK, uid: staff.uid }).startSession();
const actor = async (trackId = TRACK) => {
  const p = await person();
  return createBus(sdk, { db: p.db, eventId: EVENT, trackId, uid: p.uid });
};

// --- 拡張を読み込んだブラウザ --------------------------------------------
const profile = await mkdtemp(join(tmpdir(), 'danmaku-ext-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,   // 拡張は headless では読み込まれない
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 720 },
});

const sw = ctx.serviceWorkers()[0]
  ?? await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const EXT_ID = new URL(sw.url()).host;

/** popup を実際に操作してトラックを入れる。本番と同じ道を通す。 */
async function setTrack(link) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await page.fill('#track', link);
  await page.click('#save');
  await page.waitForFunction(() => document.getElementById('msg').dataset.kind === 'ok',
    { timeout: 10000 });
  await page.close();
}

await t('拡張が読み込まれている', async () => {
  assert(EXT_ID.length > 10, `拡張IDが変: ${EXT_ID}`);
});

await t('版にビルド時刻が入っている（古いものを見ていないか分かる）', async () => {
  const m = await sw.evaluate(() => chrome.runtime.getManifest());
  assert(m.version !== '0.1.0', `版が固定されている: ${m.version}`);
  assert(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(m.version_name ?? ''),
    `版に時刻が入っていない: ${m.version_name}`);
});

await t('popup で運営のリンクを貼ると2つのIDを拾う', async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await page.fill('#track', 'https://example.test/stage.html?e=evzz&t=fromurl');
  await page.click('#save');
  await page.waitForFunction(() => /fromurl/.test(document.getElementById('msg').textContent),
    { timeout: 10000 });
  await page.close();
});

await t('popup は不正な入力を弾く', async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await page.fill('#track', 'a b c d');
  await page.click('#save');
  await page.waitForFunction(() => document.getElementById('msg').dataset.kind === 'bad',
    { timeout: 10000 });
  await page.close();
});

await setTrack(`${EVENT} ${TRACK}`);

await t('発表ページに弾幕の canvas が差し込まれる', async () => {
  const page = await ctx.newPage();
  await page.goto(PRESENT);
  await page.waitForFunction(() => document.getElementById('danmaku-slide-overlay') !== null,
    { timeout: 15000 });
  const css = await page.evaluate(() => {
    const el = document.getElementById('danmaku-slide-overlay');
    const c = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { pe: c.pointerEvents, pos: c.position, z: c.zIndex, disp: c.display,
             parent: el.parentElement.tagName, w: Math.round(r.width), h: Math.round(r.height),
             x: Math.round(r.left), y: Math.round(r.top) };
  });
  // 模擬ページは canvas { display:none !important } と body の transform を持っている。
  // 相手の指定に負けていないことを確かめる。
  assert(css.pe === 'none', `クリックが透けない: pointer-events=${css.pe}`);
  assert(css.pos === 'fixed', `position=${css.pos}`);
  assert(css.disp === 'block', `相手の display:none に負けている: ${css.disp}`);
  assert(Number(css.z) > 1000000, `z-index が低い: ${css.z}`);
  assert(css.parent === 'HTML', `body の transform に閉じ込められる置き方: ${css.parent}`);
  assert(css.w >= 1200 && css.h >= 600, `画面を覆えていない: ${css.w}x${css.h}`);
  assert(css.x === 0 && css.y === 0, `位置がずれている: ${css.x},${css.y}`);
  await page.close();
});

await t('編集画面には差し込まない', async () => {
  const page = await ctx.newPage();
  await page.goto(EDIT);
  await sleep(1200);
  assert(await page.evaluate(() => document.getElementById('danmaku-slide-overlay') === null),
    '編集画面に差し込んでいる');
  await page.close();
});

await t('弾幕の上からクリックがスライドに届く', async () => {
  const page = await ctx.newPage();
  await page.goto(PRESENT);
  await page.waitForFunction(() => document.getElementById('danmaku-slide-overlay') !== null,
    { timeout: 15000 });
  // canvas の真ん中を押す。透けていればスライド側が数える。
  await page.mouse.click(640, 360);
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => window.__clicks === 2, { timeout: 5000 });
  assert(/クリック回数: 2/.test(await page.textContent('#count')), await page.textContent('#count'));
  await page.close();
});

await t('投稿するとスライドの上に描かれる', async () => {
  const page = await ctx.newPage();
  await page.goto(PRESENT);
  await page.waitForFunction(() => document.getElementById('danmaku-slide-overlay') !== null,
    { timeout: 15000 });
  await sleep(1500);   // 匿名サインインと購読

  const before = await page.evaluate(() => {
    const c = document.getElementById('danmaku-slide-overlay');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  assert(before === 0, `投稿前から描かれている: ${before}`);

  const po = await actor();
  await po.post('拡張から流れる');
  await page.waitForFunction(() => {
    const c = document.getElementById('danmaku-slide-overlay');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }, { timeout: 25000 });
  await page.close();
});

await t('ページに消されても canvas を付け直す', async () => {
  // Google スライドは SPA なので、描き直しでこちらの要素ごと消えることがある
  const page = await ctx.newPage();
  await page.goto(PRESENT);
  await page.waitForFunction(() => document.getElementById('danmaku-slide-overlay') !== null,
    { timeout: 15000 });
  // 消してから付け直されるまでを見る。印を付けておけば、別物に入れ替わったと分かる。
  await page.evaluate(() => {
    const c = document.getElementById('danmaku-slide-overlay');
    c.dataset.old = '1';
    c.remove();
  });
  await page.waitForFunction(() => {
    const c = document.getElementById('danmaku-slide-overlay');
    return c !== null && c.isConnected;
  }, { timeout: 5000 });
  await page.close();
});

await t('全画面になったらその中へ移る', async () => {
  const page = await ctx.newPage();
  await page.goto(PRESENT);
  await page.waitForFunction(() => document.getElementById('danmaku-slide-overlay') !== null,
    { timeout: 15000 });
  // ユーザー操作からでないと全画面にできないので、クリックに乗せる
  await page.evaluate(() => {
    document.getElementById('deck').addEventListener('click', () => {
      document.getElementById('deck').requestFullscreen();
    }, { once: true });
  });
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => document.fullscreenElement !== null, { timeout: 8000 });
  await page.waitForFunction(() => {
    const c = document.getElementById('danmaku-slide-overlay');
    return c && c.parentElement === document.fullscreenElement;
  }, { timeout: 8000 });
  await page.close();
});

await t('popup が動いている状態を見分ける', async () => {
  const page = await ctx.newPage();
  await page.goto(PRESENT);
  await page.waitForFunction(() => document.getElementById('danmaku-slide-overlay') !== null,
    { timeout: 15000 });
  await sleep(2500);
  await page.bringToFront();

  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await pop.waitForFunction(
    () => document.getElementById('verdict').dataset.kind === 'ok', { timeout: 15000 });
  const text = await pop.textContent('#verdictText');
  assert(/動いています/.test(text), text);
  // 詳細にトラック名とビルド時刻が出る
  const d = await pop.textContent('#detail');
  assert(/Extension Track/.test(d), `トラック名が無い: ${d}`);
  assert(d.length > 0, '詳細が空');
  // popup の先頭に版が出ている
  assert(/^版 /.test((await pop.textContent('#ver')).trim()), await pop.textContent('#ver'));
  await pop.close(); await page.close();
});

await t('ショートカットで状態を出し直せる（全画面でも使える道）', async () => {
  // 発表中は全画面でツールバーが出ず、アイコンを押せない。
  // OS のキー入力は再現できないので、background が送る合図から先を確かめる。
  const page = await ctx.newPage();
  await page.goto(PRESENT);
  await page.waitForFunction(() => document.getElementById('danmaku-slide-badge') !== null,
    { timeout: 15000 });

  const toggle = () => sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => /\/present/.test(x.url ?? ''));
    return chrome.tabs.sendMessage(t.id, { type: 'danmaku:toggle' });
  });

  // 1回目で出しっぱなしに、2回目で消える、3回目でまた出る
  assert((await toggle())?.pinned === true, '1回目で出しっぱなしにならない');
  assert((await toggle())?.pinned === false, '2回目で消えない');
  assert((await toggle())?.pinned === true, '3回目で出ない');
  // 実際に見えていることも確かめる
  await page.waitForFunction(() => {
    const b = document.getElementById('danmaku-slide-badge');
    return b && getComputedStyle(b).opacity === '1';
  }, { timeout: 8000 });
  await page.close();
});

await t('最初のコメントが届くまで状態は消えない', async () => {
  // 登壇が始まる前に「繋がっている」と分かることが大事
  const page = await ctx.newPage();
  await page.goto(PRESENT);
  await page.waitForFunction(
    () => /受付中/.test(document.getElementById('danmaku-slide-badge')?.textContent ?? ''),
    { timeout: 20000 });
  await sleep(11000);   // 自動で消える時間を超えて待つ
  const op = await page.evaluate(() =>
    getComputedStyle(document.getElementById('danmaku-slide-badge')).opacity);
  assert(op === '1', `コメントが来ていないのに消えた: opacity=${op}`);
  await page.close();
});

await t('厳しい CSP のページでも差し込める', async () => {
  const page = await ctx.newPage();
  await page.goto(PRESENT_STRICT);
  await page.waitForFunction(() => document.getElementById('danmaku-slide-overlay') !== null,
    { timeout: 15000 });
  await page.close();
});

await t('厳しい CSP のページでも Firestore に繋がって流れる', async () => {
  // content script からの通信がページの CSP に縛られるなら、ここで落ちる。
  // 落ちたら Firestore を background か offscreen に移す必要がある。
  const page = await ctx.newPage();
  const blocked = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to connect|CSP/i.test(t)) blocked.push(t.slice(0, 160));
  });
  await page.goto(PRESENT_STRICT);
  await page.waitForFunction(() => document.getElementById('danmaku-slide-overlay') !== null,
    { timeout: 15000 });
  await sleep(2000);

  const po = await actor();
  await po.post('CSPごしに流れる');
  try {
    await page.waitForFunction(() => {
      const c = document.getElementById('danmaku-slide-overlay');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    }, { timeout: 25000 });
  } catch (e) {
    throw new Error(`CSP に阻まれている可能性: ${blocked.join(' | ') || '（CSPのログは無し）'}`);
  }
  await page.close();
});

await t('スライドのタブが無いときは、そう言う', async () => {
  // 最後にやる。ここでしか「スライドのタブが1つも無い」状態を作れない。
  for (const p of ctx.pages()) {
    if (!p.url().startsWith('chrome-extension://')) await p.close().catch(() => {});
  }
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await pop.waitForFunction(
    () => document.getElementById('verdict').dataset.kind !== '', { timeout: 10000 });
  const text = await pop.textContent('#verdictText');
  assert(/見つかりません/.test(text), text);
});

await ctx.close();
await rm(profile, { recursive: true, force: true });
srv.close();
for (const [st, name, msg] of rows) console.log(`  ${st} ${name}${msg ? '\n         -> ' + msg : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
