// 登壇者コンソールの組み立て。
//
// 停止のワンクリックがこのページの中心。残っている安全上の穴
// （匿名UIDは使い捨てなのでレート制限を抜けられる）を運用で受けるための要なので、
// 迷わず押せるところに置き、押した結果が即見えるようにする。
import { connect } from './app.mjs';
import { QRCode } from '../vendor/lib.js';

/** トラックIDを作る。QRを印刷するので、読み上げても間違えにくい文字だけ使う。 */
export function newTrackId(random = () => Math.random()) {
  // 0/O、1/l/I のような紛れる文字を外す
  const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return s;
}

/** 引き継ぎコード。口頭で伝えることがあるので同じ文字集合を使う。 */
export function newHandoffCode(random = () => Math.random()) {
  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return s;
}

export function postUrlFor(trackId, origin = location.origin) {
  return `${origin}/post.html?track=${encodeURIComponent(trackId)}`;
}
export function overlayUrlFor(trackId, origin = location.origin) {
  return `${origin}/overlay.html?track=${encodeURIComponent(trackId)}`;
}

export async function createConsole({ trackId, random = () => Math.random() } = {}) {
  const el = (id) => document.getElementById(id);
  const stateText = el('stateText');
  const state = el('state');
  const toggle = (id, on) => el(id).classList.toggle('hidden', !on);

  // Firestore は書き込みをまずローカルに適用し、サーバに拒否されると巻き戻す。
  // 巻き戻しのスナップショットが購読から届くので、素直に書くとエラー表示が
  // 「受付中」で上書きされ、押しても何も起きなかったように見える。
  // エラーは残す側に倒し、次に成功したときか一定時間で消す。
  let stickyError = null;
  let errorTimer = 0;

  const say = (msg, kind = '') => {
    if (stickyError) return;          // エラーを消さない
    stateText.textContent = msg;
    state.dataset.kind = kind;
  };
  function fail(msg) {
    stickyError = msg;
    stateText.textContent = msg;
    state.dataset.kind = 'error';
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { stickyError = null; render(); }, 6000);
  }
  function clearError() {
    stickyError = null;
    clearTimeout(errorTimer);
  }

  // トラックが指定されていなければ、その場で1本作る流れに入る（登壇者スタート）
  const isNew = !trackId;
  const id = trackId ?? newTrackId(random);
  let bus;
  try {
    bus = await connect(id);
  } catch (e) {
    fail(`つながらない: ${e.code ?? e.message}`);
    return null;
  }

  let track = null;

  // --- 画面の出し分け ---------------------------------------------------
  function render() {
    const exists = track !== null;
    toggle('createBox', !exists);
    toggle('idBox', exists);
    toggle('liveBox', exists);
    toggle('stopBox', exists);
    toggle('qrBox', exists);
    toggle('overlayBox', exists);
    toggle('handoffBox', exists);

    if (!exists) { say('トラックがまだない', ''); return; }

    toggle('stop', !track.stopped);
    toggle('resume', track.stopped);
    if (track.stopped) say(`${track.name} · 投稿を止めている`, 'stopped');
    else say(`${track.name} · 受付中`, 'live');
  }

  bus.watchTrack((t) => {
    track = t;
    if (t) {
      // 入力中の内容を上書きしない
      if (document.activeElement !== el('title')) el('title').value = t.title ?? '';
      if (document.activeElement !== el('speaker')) el('speaker').value = t.speaker ?? '';
    }
    render();
    if (t) paintQr();
  }, (e) => fail(`読めない: ${e.code ?? e.message}`));

  // --- QR ---------------------------------------------------------------
  let painted = false;
  async function paintQr() {
    if (painted) return;
    painted = true;
    const url = postUrlFor(id);
    el('postUrl').textContent = url;
    el('trackId').textContent = id;
    // SVG で持つ。印刷しても潰れないし、拡大しても粗くならない。
    const svg = await QRCode.toString(url, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 360,
    });
    el('qrSlot').innerHTML = svg;
  }

  // --- 操作 -------------------------------------------------------------
  el('create').addEventListener('click', async () => {
    const name = el('newName').value.trim() || 'Track';
    el('create').disabled = true;
    try {
      await bus.createTrack({ name });
      clearError();
      // URL に trackId を残す。再読み込みしても同じトラックに戻れる。
      history.replaceState(null, '', `?track=${encodeURIComponent(id)}`);
    } catch (e) {
      fail(`作れない: ${e.code ?? e.message}`);
    } finally {
      el('create').disabled = false;
    }
  });

  el('start').addEventListener('click', async () => {
    el('start').disabled = true;
    try {
      await bus.startSession({ title: el('title').value.trim(), speaker: el('speaker').value.trim() });
      clearError();
    } catch (e) {
      fail(`開始できない: ${e.code ?? e.message}`);
    } finally {
      el('start').disabled = false;
    }
  });

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

  el('copyId').addEventListener('click', () => copy(id, say, fail));
  // アプリが入っていれば danmaku:// で立ち上がる。入っていなければ何も起きない。
  // アンカーにしてあるのは、素直だし、呼び先を確かめられるから。
  el('openApp').href = `danmaku://track/${encodeURIComponent(id)}`;
  el('copy').addEventListener('click', () => copy(postUrlFor(id), say, fail));
  el('copyOverlay').addEventListener('click', () => copy(overlayUrlFor(id), say, fail));
  el('openPost').addEventListener('click', () => window.open(postUrlFor(id), '_blank', 'noopener'));
  el('openOverlay').addEventListener('click', () => window.open(overlayUrlFor(id), '_blank', 'noopener'));
  el('print').addEventListener('click', () => printQr(id, track, el('qrSlot').innerHTML));

  el('issue').addEventListener('click', async () => {
    const code = newHandoffCode(random);
    el('issue').disabled = true;
    try {
      await bus.setHandoffCode(code);
      clearError();
      // 保存したものは誰も読めないので、ここで見せるしかない
      el('handoffCode').textContent = code;
      el('handoffCode').classList.remove('hidden');
      el('issue').textContent = '発行しなおす';
    } catch (e) {
      fail(`発行できない: ${e.code ?? e.message}`);
    } finally {
      el('issue').disabled = false;
    }
  });

  // render より後に当てる。隠れている要素にフォーカスは乗らない。
  render();
  if (isNew) el('newName').focus();
  return { bus, trackId: id, isNew };
}

async function copy(text, say, fail) {
  try { await navigator.clipboard.writeText(text); say('コピーした', 'live'); }
  catch { fail('コピーできなかった。URLを手で選んで'); }
}

/**
 * QRだけの印刷用ウィンドウを開く。
 * スクリーンにQRを出さずに配れるようにするのが目的なので、机に置ける紙にする。
 */
function printQr(trackId, track, svg) {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(track?.name ?? trackId)} の弾幕QR</title>
<style>
  @page { margin: 12mm; }
  body { margin: 0; font: 16px/1.6 -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
         display: grid; place-items: center; min-height: 100vh; text-align: center; color: #111; }
  h1 { font-size: 1.6rem; margin: 0 0 .2rem; }
  p  { margin: 0 0 1.2rem; color: #555; }
  svg { width: 72mm; height: 72mm; }
  .url { margin-top: 1rem; font: 500 .9rem ui-monospace, Menlo, monospace; color: #333; word-break: break-all; }
</style>
<body><div>
  <h1>${escapeHtml(track?.name ?? trackId)}</h1>
  <p>スマホで読み取るとコメントを送れます</p>
  ${svg}
  <div class="url">${escapeHtml(`${location.origin}/post.html?track=${trackId}`)}</div>
</div></body>`);
  w.document.close();
  w.focus();
  w.print();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
