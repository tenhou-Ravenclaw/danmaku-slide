// Google スライドの発表ページに弾幕を差し込む。
//
// 差し込む先はスライドと同じページなので、最前面もクリック透過も要らない。
// canvas に pointer-events: none を付けるだけで、クリックはスライドへ素通りする。
// niconicomments が <video> の上に canvas を重ねるのと同じ構造。
import { DanmakuFlow } from '../public/lib/danmaku.mjs';
import { Renderer } from '../public/lib/renderer.mjs';
import { createBus } from '../public/lib/bus.mjs';
import * as sdk from './vendor-for-extension.js';

const CONFIG = __FIREBASE_CONFIG__;   // ビルド時に差し込む
const BUILT_AT = __BUILT_AT__;        // どのビルドが動いているか分かるように

/** 発表中のページでだけ動かす。編集画面には出さない。 */
function isPresenting() {
  return /\/presentation\/d\/[^/]+\/present/.test(location.pathname);
}

/** 拡張のアイコンから「いまどうなっているか」を聞けるようにする。 */
function answerReports(getState) {
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'danmaku:report') return;
    reply({ ok: true, builtAt: BUILT_AT, url: location.href, ...getState() });
    return true;
  });
}

async function main() {
  if (!isPresenting()) {
    // 発表ページでなくても、問い合わせには答える
    answerReports(() => ({ presenting: false, reason: '発表ページではない' }));
    return;
  }

  // 状態を短く出す。流れないときに原因が分からないのがいちばん困る。
  const badge = document.createElement('div');
  badge.id = 'danmaku-slide-badge';
  badge.style.cssText = [
    'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483647',
    'padding:6px 12px', 'border-radius:999px', 'pointer-events:none',
    'font:500 13px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif',
    'color:#cfd0dc', 'background:rgba(12,12,18,.78)', 'border:1px solid rgba(255,255,255,.14)',
    'transition:opacity .4s', 'max-width:60vw', 'white-space:nowrap',
    'overflow:hidden', 'text-overflow:ellipsis',
  ].join(';');
  document.body.append(badge);
  let hideTimer = 0;
  let pinned = false;        // ショートカットで出しっぱなしにしているか
  let lastStatus = { text: '読み込み中', ok: true };

  /**
   * 状態を出す。
   *
   * 問題があるときは消さない。正常なら10秒で消すが、最初のコメントが届くまでは
   * 残す。登壇が始まる前に「繋がっている」と分かることが大事なので。
   * 発表中は全画面でアイコンを押せないので、ショートカットで出し直せるようにする。
   */
  function status(text, ok = true, { sticky = false } = {}) {
    lastStatus = { text, ok };
    badge.textContent = `弾幕スライド · ${text}`;
    badge.style.opacity = '1';
    badge.style.color = ok ? '#cfd0dc' : '#ffd2d2';
    badge.style.background = ok ? 'rgba(12,12,18,.78)' : 'rgba(120,20,20,.88)';
    clearTimeout(hideTimer);
    if (ok && !pinned && !sticky) hideTimer = setTimeout(() => { badge.style.opacity = '0'; }, 10000);
  }
  function toggleBadge() {
    pinned = !pinned;
    if (pinned) { clearTimeout(hideTimer); status(lastStatus.text, lastStatus.ok); }
    else badge.style.opacity = '0';
  }
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'danmaku:toggle') return;
    toggleBadge();
    reply({ pinned });
    return true;
  });

  const { trackId } = await chrome.storage.local.get('trackId');
  if (!trackId) {
    answerReports(() => ({ presenting: true, reason: 'トラックが未設定' }));
    status('トラックが未設定。拡張のアイコンから設定する', false);
    console.info('[弾幕スライド] トラックが未設定。拡張のアイコンから設定する');
    return;
  }
  status(`${trackId} に接続中`);

  // --- 重ねる canvas ---------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.id = 'danmaku-slide-overlay';
  /**
   * 相手のページの CSS に負けないよう important で置く。
   * 相手は自分の canvas や全称セレクタに指定を持っていることがある。
   *
   * pointer-events: none がクリック透過の全て。z-index は Google の UI より上。
   */
  const FIXED = {
    position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
    width: '100vw', height: '100vh', margin: '0', padding: '0', border: '0',
    'pointer-events': 'none', 'z-index': '2147483647',
    background: 'transparent', display: 'block', opacity: '1',
    visibility: 'visible', transform: 'none', filter: 'none',
    'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0',
  };
  function applyStyle() {
    for (const [k, v] of Object.entries(FIXED)) canvas.style.setProperty(k, v, 'important');
  }
  applyStyle();

  /**
   * 置き場所を保つ。
   *
   * 相手は SPA なので、描き直しのたびにこちらの canvas ごと消されることがある。
   * 全画面になったときは、その要素の中にいないと描かれない。
   * どちらも静かに起きるので、毎フレーム見て required なら付け直す。
   */
  function hostFor() {
    const fs = document.fullscreenElement;
    // body ではなく html に付ける。body に transform や filter がかかっていると、
    // position: fixed がその中に閉じ込められて、思った場所に出ない。
    if (!fs) return document.documentElement;
    // iframe が全画面になると、こちらからは中へ入れない
    if (fs.tagName === 'IFRAME') return null;
    return fs;
  }
  let lostHost = false;
  function reparent() {
    const host = hostFor();
    if (!host) {
      if (!lostHost) { lostHost = true; status('全画面の中に入れない（別の出し方が要る）', false); }
      return;
    }
    lostHost = false;
    if (canvas.parentElement !== host || !canvas.isConnected) {
      host.append(canvas);
      applyStyle();   // 付け直すたびに当て直す
    }
  }
  document.addEventListener('fullscreenchange', () => { reparent(); fit(); });
  reparent();

  const flow = new DanmakuFlow();
  const renderer = new Renderer(canvas);

  function fit() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.resize(w, h, window.devicePixelRatio || 1);
    flow.resize(w, h);
  }
  window.addEventListener('resize', fit);
  fit();

  let lastHost = null;
  function frame(t) {
    // 消されていないか、全画面の中にいるかを毎フレーム確かめる。
    // 参照の比較だけなので安い。
    const host = hostFor();
    if (!canvas.isConnected || host !== lastHost) { reparent(); lastHost = host; fit(); }
    renderer.draw(flow.step(t));
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // --- Firestore -------------------------------------------------------
  const app = sdk.initializeApp(CONFIG, 'danmaku-ext');
  const db = sdk.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  const auth = sdk.getAuth(app);
  // 条件に直接置く。定数を経由すると最適化で落としきれず、本番の成果物に
  // エミュレータ接続が残る。残っていると「テストを回したら本番が繋がらない」
  // 類の事故に戻る。
  if (__USE_EMULATOR__) {
    sdk.connectFirestoreEmulator(db, '127.0.0.1', 8181);
    sdk.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  }
  const { user } = await sdk.signInAnonymously(auth);
  const bus = createBus(sdk, { db, trackId, uid: user.uid });

  let unwatch = null;
  let sessionKey = null;
  let trackName = null;
  let trackStopped = null;
  let received = 0;
  bus.watchTrack((track) => {
    if (!track) { status(`トラックが見つからない: ${trackId}`, false); return; }
    trackName = track.name; trackStopped = track.stopped;
    if (!track.sessionStartedAt) return;
    const key = track.sessionStartedAt.toMillis?.() ?? String(track.sessionStartedAt);
    if (key === sessionKey) return;
    sessionKey = key;
    unwatch?.();
    flow.resetFlow();
    unwatch = bus.watchComments(track.sessionStartedAt, (c, { isBacklog }) => {
      // 溜まっていた分は流さない。一斉に出ると画面が埋まる。
      if (isBacklog) { flow.markSeen(c.id); return; }
      received++;
      // 最初の1件が届いたら、出しっぱなしをやめる（投影の邪魔になる）
      if (received === 1 && !pinned) status(`${trackName} · 受付中`);
      flow.add({ id: c.id, text: c.text, width: renderer.measure(c.text) }, performance.now());
    }, (e) => { status(`購読できない: ${e.code ?? e.message}`, false); console.warn(e); });
    // 最初のコメントが届くまでは残す。繋がっていることを登壇前に確かめられるように。
    status(`${track.name}${track.stopped ? ' · 停止中' : ' · 受付中'}`,
      true, { sticky: received === 0 });
  }, (e) => { status(`トラックを読めない: ${e.code ?? e.message}`, false); console.warn(e); });

  // 動作確認用。ページのコンソールからは触れない（分離された世界なので）
  const report = () => ({
    presenting: true,
    trackId,
    track: trackName,
    stopped: trackStopped,
    connected: canvas.isConnected,
    parent: canvas.parentElement?.tagName ?? null,
    // 実際に画面のどこに出ているか。0x0 や画面外なら置き場所が効いていない。
    box: (() => { const r = canvas.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`; })(),
    visible: (() => { const c = getComputedStyle(canvas);
      return c.display !== 'none' && c.visibility !== 'hidden' && c.opacity !== '0'; })(),
    fullscreen: document.fullscreenElement?.tagName ?? null,
    size: `${canvas.width}x${canvas.height}`,
    lanes: flow.laneCount,
    active: flow.activeCount,
    received,
    badge: badge.textContent,
  });
  answerReports(report);
  globalThis.__danmaku = { flow, renderer, bus, canvas, status, report };
  console.info('[弾幕スライド] 重ねた:', trackId);
}

main().catch((e) => {
  console.error('[弾幕スライド]', e);
  const b = document.getElementById('danmaku-slide-badge');
  if (b) { b.textContent = `弾幕スライド · ${e?.message ?? e}`; b.style.opacity = '1'; }
});
