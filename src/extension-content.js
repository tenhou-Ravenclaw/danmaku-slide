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
const USE_EMULATOR = __USE_EMULATOR__; // テストでだけ true

/** 発表中のページでだけ動かす。編集画面には出さない。 */
function isPresenting() {
  return /\/presentation\/d\/[^/]+\/present/.test(location.pathname);
}

async function main() {
  if (!isPresenting()) return;

  const { trackId } = await chrome.storage.local.get('trackId');
  if (!trackId) {
    console.info('[弾幕スライド] トラックが未設定。拡張のアイコンから設定する');
    return;
  }

  // --- 重ねる canvas ---------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.id = 'danmaku-slide-overlay';
  // pointer-events: none がクリック透過の全て。z-index は Google の UI より上。
  canvas.style.cssText = [
    'position:fixed', 'inset:0', 'width:100vw', 'height:100vh',
    'pointer-events:none', 'z-index:2147483647', 'background:transparent',
  ].join(';');
  document.body.append(canvas);

  // 全画面になると、その要素の中にいないと描かれない
  function reparent() {
    const host = document.fullscreenElement ?? document.body;
    if (canvas.parentElement !== host) host.append(canvas);
  }
  document.addEventListener('fullscreenchange', () => { reparent(); fit(); });

  const flow = new DanmakuFlow();
  const renderer = new Renderer(canvas);

  function fit() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.resize(w, h, window.devicePixelRatio || 1);
    flow.resize(w, h);
  }
  window.addEventListener('resize', fit);
  fit();

  function frame(t) {
    renderer.draw(flow.step(t));
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // --- Firestore -------------------------------------------------------
  const app = sdk.initializeApp(CONFIG, 'danmaku-ext');
  const db = sdk.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  const auth = sdk.getAuth(app);
  if (USE_EMULATOR) {
    sdk.connectFirestoreEmulator(db, '127.0.0.1', 8181);
    sdk.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  }
  const { user } = await sdk.signInAnonymously(auth);
  const bus = createBus(sdk, { db, trackId, uid: user.uid });

  let unwatch = null;
  let sessionKey = null;
  bus.watchTrack((track) => {
    if (!track?.sessionStartedAt) return;
    const key = track.sessionStartedAt.toMillis?.() ?? String(track.sessionStartedAt);
    if (key === sessionKey) return;
    sessionKey = key;
    unwatch?.();
    flow.resetFlow();
    unwatch = bus.watchComments(track.sessionStartedAt, (c, { isBacklog }) => {
      // 溜まっていた分は流さない。一斉に出ると画面が埋まる。
      if (isBacklog) { flow.markSeen(c.id); return; }
      flow.add({ id: c.id, text: c.text, width: renderer.measure(c.text) }, performance.now());
    }, (e) => console.warn('[弾幕スライド] 購読できない', e));
  }, (e) => console.warn('[弾幕スライド] トラックを読めない', e));

  // 動作確認用。ページのコンソールからは触れない（分離された世界なので）
  globalThis.__danmaku = { flow, renderer, bus, canvas };
  console.info('[弾幕スライド] 重ねた:', trackId);
}

main().catch((e) => console.error('[弾幕スライド]', e));
