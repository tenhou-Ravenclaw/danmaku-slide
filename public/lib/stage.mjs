// 登壇者のコントロール画面。
//
// 登壇者が触るのはノートPC側だけにする。プロジェクタ側の窓は、開いたあと
// 全画面にする1クリックを除いて二度と触らない。
// 取り込みの選択画面も、プロジェクタ側で出すと客席に映るので必ずこちらで出す。
import { connect } from './app.mjs';
import * as capture from './capture.mjs';
import * as screens from './screens.mjs';
import { QRCode } from '../vendor/lib.js';
import { postUrlFor, overlayUrlFor } from './speaker.mjs';

export async function createStage({ trackId }) {
  const el = (id) => document.getElementById(id);
  const stateText = el('stateText');
  const state = el('state');

  // Firestore はローカルに楽観適用してからサーバの判定が返るので、
  // 巻き戻しのスナップショットでエラー表示が消えないようにする。
  let stickyError = null, errorTimer = 0;
  const say = (msg, kind = '') => {
    if (stickyError) return;
    stateText.textContent = msg; state.dataset.kind = kind;
  };
  const fail = (msg) => {
    stickyError = msg; stateText.textContent = msg; state.dataset.kind = 'error';
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { stickyError = null; render(); }, 6000);
  };
  const clearError = () => { stickyError = null; clearTimeout(errorTimer); };

  if (!trackId) { fail('トラックが指定されていない（運営からのリンクを開く）'); return null; }

  let bus;
  try { bus = await connect(trackId); }
  catch (e) { fail(`つながらない: ${e.code ?? e.message}`); return null; }

  let track = null;
  let stream = null;
  let projector = null;      // プロジェクタ側の窓
  let projectorApi = null;   // その窓の弾幕
  let received = 0;

  // --- 手順の進み具合 ---------------------------------------------------
  function steps() {
    const done = {
      s1: stream !== null,
      s2: projector !== null && !projector.closed,
      s3: projectorApi !== null,
      s4: false,
    };
    const order = ['s1', 's2', 's3', 's4'];
    let now = order.find((k) => !done[k]) ?? null;
    for (const k of order) {
      el(k).dataset.state = done[k] ? 'done' : (k === now ? 'now' : '');
    }
    el('pick').textContent = stream ? 'スライドを選び直す' : 'スライドを取り込む';
    el('pick').classList.toggle('primary', !stream);
    el('project').disabled = !stream || (projector && !projector.closed);
    el('project').classList.toggle('primary', !!stream && !(projector && !projector.closed));
    el('closeProj').classList.toggle('hidden', !(projector && !projector.closed));
  }

  function render() {
    if (!track) { say('トラックが見つからない', 'error'); return; }
    el('stop').classList.toggle('hidden', track.stopped);
    el('resume').classList.toggle('hidden', !track.stopped);
    const where = projector && !projector.closed ? ' · 投影中' : '';
    if (track.stopped) say(`${track.name} · 投稿を止めている${where}`, 'stopped');
    else say(`${track.name}${track.title ? ' · ' + track.title : ''} · 受付中${where}`, 'live');
    steps();
  }

  bus.watchTrack((t) => { track = t; render(); if (t) paintQr(); },
    (e) => fail(`読めない: ${e.code ?? e.message}`));

  // --- 届いているコメント ------------------------------------------------
  const seen = new Set();
  function addToFeed(text) {
    const li = document.createElement('li');
    li.textContent = text;
    el('feed').prepend(li);
    while (el('feed').children.length > 60) el('feed').lastElementChild.remove();
    el('count').textContent = String(++received);
  }
  function watchComments(startedAt) {
    bus.watchComments(startedAt, (c, { isBacklog }) => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      if (!isBacklog) addToFeed(c.text);
    }, (e) => fail(`購読できない: ${e.code ?? e.message}`));
  }
  bus.getTrack().then((snap) => {
    if (snap.exists()) watchComments(snap.data().sessionStartedAt);
  });

  // --- ① スライドを取り込む ---------------------------------------------
  const REASON = {
    unsupported: 'このブラウザは画面の取り込みに対応していない。Chrome か Edge で開く',
    cancelled: '選ばれなかった。もう一度押す',
    none: '取り込めるものが無かった',
    failed: '取り込めなかった',
  };
  el('pick').addEventListener('click', async () => {
    el('pick').disabled = true;
    try {
      const next = await capture.pickSlide();
      capture.stop(stream);
      stream = next;
      capture.onEnded(stream, () => {
        stream = null;
        el('setupHint').textContent = 'スライドの取り込みが止まった。もう一度取り込む';
        steps();
      });
      el('setupHint').textContent = '';
      // すでに投影中なら、開き直さずに差し替える
      projectorApi?.adoptStream(stream);
    } catch (e) {
      el('setupHint').textContent = REASON[e.kind] ?? REASON.failed;
    } finally {
      el('pick').disabled = false;
      steps();
    }
  });

  // --- ② プロジェクタに出す ---------------------------------------------
  let screenList = [];
  (async () => {
    if (!screens.isSupported()) return;
    const r = await screens.listScreens();
    if (r.screens.length < 2) return;
    screenList = r.screens;
    const sel = el('screen');
    sel.classList.remove('hidden');
    for (const s of screenList) {
      const o = document.createElement('option');
      o.value = String(s.index);
      o.textContent = s.label;
      o.selected = !s.raw.isPrimary;   // 既定で投影先を選んでおく
      sel.append(o);
    }
  })();

  // 子の窓から「準備できた」と呼ばれる
  window.__projectorReady = (api, win) => {
    projectorApi = api;
    if (stream) api.adoptStream(stream);
    win.addEventListener('pagehide', () => { projectorApi = null; steps(); });
    steps();
  };

  /**
   * 投影窓の URL を組み立てる。
   * いまの画面に付いているクエリのうち、接続先を決めるものは引き継ぐ。
   * 引き継がないと、親がエミュレータで子が本番、という食い違いが起きる。
   */
  function projectorUrl() {
    const u = new URL(overlayUrlFor(trackId));
    const here = new URLSearchParams(location.search);
    for (const key of ['emu']) {
      const v = here.get(key);
      if (v !== null) u.searchParams.set(key, v);
    }
    u.searchParams.set('stage', '1');
    u.searchParams.set('hud', '0');
    return u.toString();
  }

  el('project').addEventListener('click', () => {
    const target = screenList[Number(el('screen').value)]?.raw;
    const url = projectorUrl();
    const features = target
      ? `left=${target.availLeft},top=${target.availTop},width=${target.availWidth},height=${target.availHeight}`
      : 'width=1280,height=720';
    projector = window.open(url, 'danmaku-projector', features);
    if (!projector) { el('setupHint').textContent = 'ポップアップがブロックされた。このサイトを許可する'; return; }
    el('setupHint').textContent = screenList.length
      ? '開いた窓を1回クリックすると全画面になる'
      : '開いた窓をプロジェクタ側へ動かして、1回クリックすると全画面になる';
    const poll = setInterval(() => {
      if (projector?.closed) { clearInterval(poll); projectorApi = null; steps(); }
    }, 800);
    steps();
  });

  el('closeProj').addEventListener('click', () => { projector?.close(); projectorApi = null; steps(); });

  // --- 停止 -------------------------------------------------------------
  el('stop').addEventListener('click', async () => {
    el('stop').disabled = true;
    try { await bus.stop(); clearError(); }
    catch (e) { fail(`止められない: ${e.code ?? e.message}`); }
    finally { el('stop').disabled = false; }
  });
  el('resume').addEventListener('click', async () => {
    el('resume').disabled = true;
    try { await bus.resume(); clearError(); }
    catch (e) { fail(`再開できない: ${e.code ?? e.message}`); }
    finally { el('resume').disabled = false; }
  });

  // --- リハーサル -------------------------------------------------------
  el('testSend').addEventListener('click', async () => {
    el('testSend').disabled = true;
    try { await bus.post(el('testText').value); clearError(); }
    catch (e) { el('setupHint').textContent = `流せない: ${e.kind ?? e.message}`; }
    finally { el('testSend').disabled = false; }
  });

  // --- 配布 -------------------------------------------------------------
  let painted = false;
  async function paintQr() {
    if (painted) return;
    painted = true;
    const url = postUrlFor(trackId);
    el('postUrl').textContent = url;
    el('qrSlot').innerHTML = await QRCode.toString(url,
      { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 140 });
  }
  el('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(postUrlFor(trackId)); say('コピーした', 'live'); }
    catch { fail('コピーできなかった'); }
  });
  el('openPost').addEventListener('click', () => window.open(postUrlFor(trackId), '_blank', 'noopener'));

  steps();
  return { bus, trackId, get hasSlide() { return stream !== null; },
           get isProjecting() { return !!(projector && !projector.closed); } };
}
