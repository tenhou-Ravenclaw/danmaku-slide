// 弾幕ページの組み立て。貼り方 A / B / C で共通して使う。
//
// 配置は DanmakuFlow、描画は Renderer、Firestore は bus。ここはそれらを繋ぐだけ。
import { DanmakuFlow } from './danmaku.mjs';
import { Renderer } from './renderer.mjs';
import { connect } from './app.mjs';
import * as capture from './capture.mjs';
import * as screens from './screens.mjs';

export function createOverlay({ canvas, hud, video = null, eventId, trackId, test = false }) {
  const flow = new DanmakuFlow();
  const renderer = new Renderer(canvas);
  const state = { status: '接続中', track: null, error: null, dropped: 0 };

  // 貼り方B（キャプチャ合成）のための状態。使わないときは触らない。
  let stream = null;
  let backdrop = null;

  let unwatchTrack = null;
  let unwatchComments = null;
  let bus = null;
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
      // 取り込んだ映像はそのまま下敷きにする。余白の自動切り取りはしない。
      // 一様な背景のページ（ブラウザのタブなど）で中身の帯だけを拡大してしまい、
      // 一部しか映らない不具合になっていた（#147）。映したものがそのまま出る。
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
      if (t.stopped) bits.push('コメントを停止中');
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

    // 開いた時点で溜まっている分は流さない。重ねた直後に過去が一斉に飛ぶと
    // いま来ているコメントが見えなくなる。
    unwatchComments = bus.watchComments((c, { isBacklog }) => {
      if (isBacklog) { flow.markSeen(c.id); return; }
      flow.add({ id: c.id, text: c.text, width: renderer.measure(c.text) }, performance.now());
    }, (e) => fail(`購読できない: ${e.code ?? e.message}`));

    unwatchTrack = bus.watchTrack((track) => {
      if (!track) { fail(`トラックが無い: ${trackId}`); return; }
      // 登壇者の画面に「重なった」と知らせる。手順1を完了にするため。
      try { window.opener?.postMessage({ type: 'danmaku:overlay-ready' }, location.origin); } catch {}
      state.track = track;
      state.error = null;
      state.status = '接続';
      paintHud();
    }, (e) => fail(`トラックを読めない: ${e.code ?? e.message}`));
  }

  /**
   * 起動直後に確認用の弾を一度だけ流す。
   *
   * 投稿が来るまで画面は空なので、透過・最前面・投影先・位置が合っているかを
   * 登壇者が自分だけで確かめられない。重ね始めに数本だけ流して、見えることを示す。
   * 本物の投稿と混同しないよう「テスト表示」と分かる文面にする。実データが来たら
   * 自然に混ざって流れ去る。描画はシェルに持たせない原則があるので、ここで流す。
   */
  function runTestBurst() {
    const lines = [
      'テスト表示 ✓ ここに弾幕が流れます',
      '最前面に出ていますか？',
      '位置とサイズは合っていますか？',
      'このテストは数秒で消えます',
      '投稿が届くと本物のコメントに変わります',
    ];
    lines.forEach((text, i) => {
      // 少しずつ間を空けて入れる。一斉だと行が足りず重なって読めない。
      setTimeout(() => {
        flow.add({ id: `__test-${i}`, text, width: renderer.measure(text) }, performance.now());
      }, i * 450);
    });
  }

  fit();
  window.addEventListener('resize', fit);
  raf = requestAnimationFrame(frame);
  paintHud();
  if (test) runTestBurst();
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
      stream = null; backdrop = null; video.srcObject = null;
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
    if (video) video.srcObject = null;   // 最後のフレームを残さない
    onCaptureChange?.(false);
    paintHud();
  }

  let onCaptureChange = null;


  return {
    flow, renderer,
    pickSlide, dropSlide, adoptStream,
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
