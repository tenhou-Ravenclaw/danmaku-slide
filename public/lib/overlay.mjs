// 弾幕ページの組み立て。貼り方 A / B / C で共通して使う。
//
// 配置は DanmakuFlow、描画は Renderer、Firestore は bus。ここはそれらを繋ぐだけ。
import { DanmakuFlow } from './danmaku.mjs';
import { Renderer } from './renderer.mjs';
import { connect } from './app.mjs';

export function createOverlay({ canvas, hud, trackId }) {
  const flow = new DanmakuFlow();
  const renderer = new Renderer(canvas);
  const state = { status: '接続中', track: null, error: null, dropped: 0 };

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
    renderer.draw(flow.step(tMs));
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

  return {
    flow, renderer,
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
      unwatchComments?.();
      unwatchTrack?.();
    },
    fail,
  };
}
