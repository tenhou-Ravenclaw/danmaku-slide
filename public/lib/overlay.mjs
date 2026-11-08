// 弾幕ページの組み立て。貼り方 A / B / C で共通して使う。
//
// 配置は DanmakuFlow、描画は Renderer、Firestore は bus。ここはそれらを繋ぐだけ。
import { DanmakuFlow } from './danmaku.mjs';
import { Renderer } from './renderer.mjs';
import { connect } from './app.mjs';
import * as capture from './capture.mjs';
import * as screens from './screens.mjs';

export function createOverlay({ canvas, hud, video = null, trackId, capturing = false }) {
  const flow = new DanmakuFlow();
  const renderer = new Renderer(canvas);
  const state = { status: '接続中', track: null, error: null, dropped: 0 };

  // 貼り方B（キャプチャ合成）のための状態。使わないときは触らない。
  let stream = null;
  let backdrop = null;

  let unwatchTrack = null;
  let unwatchComments = null;
  let bus = null;
  let sessionKey = null;   // sessionStartedAt が変わったら購読を張り替える
  let raf = 0;

  function fit() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.resize(w, h, window.devicePixelRatio || 1);
    flow.resize(w, h);
  }

  function frame(tMs) {
    // stream を見る。video.srcObject だけ見ていると、共有を止めた後も
    // 最後のフレームが残って videoWidth > 0 のままになり、止めたはずの
    // スライドが固まって映り続ける。
    if (stream && video && video.videoWidth > 0) {
      // 画面の大きさもスライドの大きさも変わり得るので、毎フレーム出し直す
      const fit = capture.fitRect(video.videoWidth, video.videoHeight,
        window.innerWidth, window.innerHeight);
      backdrop = { source: video, ...fit };
    }
    renderer.draw(flow.step(tMs), backdrop);
    if (state.dropped !== flow.dropped) {
      state.dropped = flow.dropped;
      paintHud();
    }
    raf = requestAnimationFrame(frame);
  }

  function paintHud() {
    if (!hud) return;
    const t = state.track;
    const bits = [state.status];
    if (t) {
      bits.push(t.name);
      if (t.title) bits.push(t.title);
      if (t.stopped) bits.push('停止中');
    }
    if (state.dropped > 0) bits.push(`流しきれず ${state.dropped}`);
    // textContent なので、トラック名や演題を DOM に入れても解釈されない
    hud.textContent = bits.join(' · ');
    hud.dataset.kind = state.error ? 'error' : (state.track?.stopped ? 'stopped' : 'ok');
    if (state.error) hud.textContent = `エラー: ${state.error}`;
  }

  /** 画面に出す。握りつぶすと PoC のときのように黙って死ぬ。 */
  function fail(message) {
    state.error = String(message);
    state.status = 'エラー';
    paintHud();
    console.error('[overlay]', message);
  }

  function watchSession(startedAt) {
    const key = startedAt?.toMillis?.() ?? String(startedAt);
    if (key === sessionKey) return;
    sessionKey = key;

    unwatchComments?.();
    flow.resetFlow();
    unwatchComments = bus.watchComments(startedAt, (c, { isBacklog }) => {
      if (isBacklog) { flow.markSeen(c.id); return; }
      flow.add({ id: c.id, text: c.text, width: renderer.measure(c.text) }, performance.now());
    }, (e) => fail(`購読できない: ${e.code ?? e.message}`));
  }

  async function start() {
    if (!trackId) { fail('トラックが指定されていない（?track=... が必要）'); return; }
    try {
      bus = await connect(trackId);
    } catch (e) {
      fail(`接続できない: ${e.code ?? e.message}`);
      return;
    }
    state.status = '接続';
    paintHud();

    unwatchTrack = bus.watchTrack((track) => {
      if (!track) { fail(`トラックが無い: ${trackId}`); return; }
      state.track = track;
      state.error = null;
      state.status = '接続';
      if (track.sessionStartedAt) watchSession(track.sessionStartedAt);
      paintHud();
    }, (e) => fail(`トラックを読めない: ${e.code ?? e.message}`));
  }

  fit();
  window.addEventListener('resize', fit);
  raf = requestAnimationFrame(frame);
  paintHud();
  start();

  // --- 貼り方B: スライドを取り込む --------------------------------------
  const CAPTURE_REASON = {
    unsupported: 'このブラウザは画面の取り込みに対応していない。Chrome か Edge で開く',
    cancelled:   '選ばれなかった。もう一度「スライドを選ぶ」を押す',
    none:        '取り込めるものが無かった',
    failed:      '取り込めなかった',
  };

  async function pickSlide() {
    if (!video) return { ok: false, reason: 'この画面では使えない' };
    try {
      const next = await capture.pickSlide();
      capture.stop(stream);
      stream = next;
      await capture.attach(stream, video);
      capture.onEnded(stream, () => {
        // 共有を止められた。黙って黒くしない。
        stream = null; backdrop = null;
        video.srcObject = null;   // 最後のフレームを残さない
        state.status = 'スライドの取り込みが止まった';
        paintHud();
        onCaptureChange?.(false);
      });
      state.status = '接続';
      state.error = null;
      paintHud();
      onCaptureChange?.(true);
      return { ok: true };
    } catch (e) {
      const reason = CAPTURE_REASON[e.kind] ?? CAPTURE_REASON.failed;
      // 選択画面を閉じただけなら、エラー扱いにして赤くしない
      if (e.kind !== 'cancelled') fail(reason); else { state.status = reason; paintHud(); }
      return { ok: false, reason };
    }
  }

  function dropSlide() {
    capture.stop(stream);
    stream = null;
    backdrop = null;
    if (video) video.srcObject = null;   // 最後のフレームを残さない
    onCaptureChange?.(false);
    paintHud();
  }

  let onCaptureChange = null;

  return {
    flow, renderer,
    pickSlide, dropSlide,
    get hasSlide() { return stream !== null; },
    onCaptureChange(fn) { onCaptureChange = fn; },
    screens,
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
      unwatchComments?.();
      unwatchTrack?.();
      capture.stop(stream);
    },
    fail,
  };
}
