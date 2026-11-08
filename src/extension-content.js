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

/** 発表中のページでだけ動かす。編集画面には出さない。 */
function isPresenting() {
  return /\/presentation\/d\/[^/]+\/present/.test(location.pathname);
}

async function main() {
  if (!isPresenting()) return;

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
  /** ok なら少しして消える。問題は残す。投影に出しっぱなしにしない。 */
  function status(text, ok = true) {
    badge.textContent = `弾幕スライド · ${text}`;
    badge.style.opacity = '1';
    badge.style.color = ok ? '#cfd0dc' : '#ffd2d2';
    badge.style.background = ok ? 'rgba(12,12,18,.78)' : 'rgba(120,20,20,.88)';
    clearTimeout(hideTimer);
    if (ok) hideTimer = setTimeout(() => { badge.style.opacity = '0'; }, 4000);
  }

  const { trackId } = await chrome.storage.local.get('trackId');
  if (!trackId) {
    status('トラックが未設定。拡張のアイコンから設定する', false);
    console.info('[弾幕スライド] トラックが未設定。拡張のアイコンから設定する');
    return;
  }
  status(`${trackId} に接続中`);

  // --- 重ねる canvas ---------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.id = 'danmaku-slide-overlay';
  // pointer-events: none がクリック透過の全て。z-index は Google の UI より上。
  canvas.style.cssText = [
    'position:fixed', 'inset:0', 'width:100vw', 'height:100vh',
    'pointer-events:none', 'z-index:2147483647', 'background:transparent',
  ].join(';');
  document.body.append(canvas);

  /**
   * 置き場所を保つ。
   *
   * 相手は SPA なので、描き直しのたびにこちらの canvas ごと消されることがある。
   * 全画面になったときは、その要素の中にいないと描かれない。
   * どちらも静かに起きるので、毎フレーム見て required なら付け直す。
   */
  function hostFor() {
    const fs = document.fullscreenElement;
    if (!fs) return document.body;
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
    if (canvas.parentElement !== host || !canvas.isConnected) host.append(canvas);
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
  bus.watchTrack((track) => {
    if (!track) { status(`トラックが見つからない: ${trackId}`, false); return; }
    if (!track.sessionStartedAt) return;
    const key = track.sessionStartedAt.toMillis?.() ?? String(track.sessionStartedAt);
    if (key === sessionKey) return;
    sessionKey = key;
    unwatch?.();
    flow.resetFlow();
    unwatch = bus.watchComments(track.sessionStartedAt, (c, { isBacklog }) => {
      // 溜まっていた分は流さない。一斉に出ると画面が埋まる。
      if (isBacklog) { flow.markSeen(c.id); return; }
      flow.add({ id: c.id, text: c.text, width: renderer.measure(c.text) }, performance.now());
    }, (e) => { status(`購読できない: ${e.code ?? e.message}`, false); console.warn(e); });
    status(`${track.name}${track.stopped ? ' · 停止中' : ' · 受付中'}`);
  }, (e) => { status(`トラックを読めない: ${e.code ?? e.message}`, false); console.warn(e); });

  // 動作確認用。ページのコンソールからは触れない（分離された世界なので）
  globalThis.__danmaku = {
    flow, renderer, bus, canvas, status,
    /** 困ったときに読む。拡張の世界からしか触れない。 */
    report: () => ({
      trackId,
      connected: canvas.isConnected,
      parent: canvas.parentElement?.tagName ?? null,
      fullscreen: document.fullscreenElement?.tagName ?? null,
      size: `${canvas.width}x${canvas.height}`,
      lanes: flow.laneCount,
      active: flow.activeCount,
      seen: flow.seen.size,
      badge: badge.textContent,
    }),
  };
  console.info('[弾幕スライド] 重ねた:', trackId);
}

main().catch((e) => {
  console.error('[弾幕スライド]', e);
  const b = document.getElementById('danmaku-slide-badge');
  if (b) { b.textContent = `弾幕スライド · ${e?.message ?? e}`; b.style.opacity = '1'; }
});
