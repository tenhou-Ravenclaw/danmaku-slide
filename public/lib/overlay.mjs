// 弾幕ページの組み立て。貼り方 A / B / C で共通して使う。
//
// 配置は DanmakuFlow、描画は Renderer、Firestore は bus。ここはそれらを繋ぐだけ。
import { DanmakuFlow } from './danmaku.mjs';
import { Renderer } from './renderer.mjs';
import { connect } from './app.mjs';
import * as capture from './capture.mjs';
import * as screens from './screens.mjs';

export function createOverlay({ canvas, hud, video = null, eventId, trackId }) {
  const flow = new DanmakuFlow();
  const renderer = new Renderer(canvas);
  const state = { status: '接続中', track: null, error: null, dropped: 0 };

  // 貼り方B（キャプチャ合成）のための状態。使わないときは触らない。
  let stream = null;
  let backdrop = null;
  let crop = null;          // 取り込んだ枠のうち、中身がある範囲
  let probe = null;         // 余白検出のための縮小用 canvas
  let lastProbeAt = 0;
  let autoCrop = true;

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
      if (autoCrop) updateCrop(tMs);
      const src = crop ?? { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
      // 画面の大きさもスライドの大きさも変わり得るので、毎フレーム出し直す
      const fit = capture.fitRect(src.width, src.height, window.innerWidth, window.innerHeight);
      backdrop = { source: video, crop: src, ...fit };
    }
    renderer.draw(flow.step(tMs), backdrop);
    if (state.dropped !== flow.dropped) {
      state.dropped = flow.dropped;
      paintHud();
    }
    raf = requestAnimationFrame(frame);
  }

  /**
   * 余白を測り直す。毎フレームやる必要はないし、重い。
   * スライドが切り替わっても余白は変わらないので、1秒に1回で足りる。
   */
  function updateCrop(tMs) {
    if (tMs - lastProbeAt < 1000 && crop) return;
    lastProbeAt = tMs;
    try {
      if (!probe) probe = document.createElement('canvas');
      const W = 160;
      const H = Math.max(2, Math.round(W * video.videoHeight / video.videoWidth));
      probe.width = W; probe.height = H;
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      pctx.drawImage(video, 0, 0, W, H);
      const r = capture.detectContentRect(pctx.getImageData(0, 0, W, H));
      const sx = video.videoWidth / W, sy = video.videoHeight / H;
      crop = {
        x: Math.round(r.x * sx), y: Math.round(r.y * sy),
        width: Math.round(r.width * sx), height: Math.round(r.height * sy),
      };
    } catch {
      crop = null;   // 測れなくても描画は続ける
    }
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
    if (!eventId || !trackId) { fail('リンクが正しくない（運営からのリンクを開く）'); return; }
    try {
      bus = await connect(eventId, trackId);
    } catch (e) {
      fail(`接続できない: ${e.code ?? e.message}`);
      return;
    }
    state.status = '接続';
    paintHud();

    unwatchTrack = bus.watchTrack((track) => {
      if (!track) { fail(`トラックが無い: ${trackId}`); return; }
      // 登壇者の画面に「重なった」と知らせる。手順1を完了にするため。
      try { window.opener?.postMessage({ type: 'danmaku:overlay-ready' }, location.origin); } catch {}
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
        stream = null; backdrop = null; crop = null;
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

  /**
   * 親ウィンドウが取り込んだ映像をそのまま受け取る。
   *
   * 取り込みの選択画面は登壇者の手元で出したい。プロジェクタ側の窓で出すと
   * 客席に選択画面が映るし、そもそも登壇者がその窓を触れない。
   * 同一オリジンなら MediaStream はそのまま渡せる。
   */
  async function adoptStream(next) {
    capture.stop(stream);
    stream = next;
    await capture.attach(stream, video);
    capture.onEnded(stream, () => {
      stream = null; backdrop = null; crop = null; video.srcObject = null;
      state.status = 'スライドの取り込みが止まった';
      paintHud();
      onCaptureChange?.(false);
    });
    state.status = '接続';
    paintHud();
    onCaptureChange?.(true);
  }

  function dropSlide() {
    capture.stop(stream);
    stream = null;
    backdrop = null;
    crop = null;
    if (video) video.srcObject = null;   // 最後のフレームを残さない
    onCaptureChange?.(false);
    paintHud();
  }

  let onCaptureChange = null;


  return {
    flow, renderer,
    pickSlide, dropSlide, adoptStream,
    /** 余白の自動切り取り。うまく切れないスライドのために切れるようにしておく。 */
    setAutoCrop(on) { autoCrop = on; if (!on) crop = null; lastProbeAt = 0; },
    get autoCrop() { return autoCrop; },
    get cropRect() { return crop; },
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
