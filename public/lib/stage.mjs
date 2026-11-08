// 登壇者の画面。登壇中に見るので、焦って探す要素が無い状態にする。
//
// やることは1つだけ。スライドに重ねる。
// 登壇の開始・終了も投稿の開け閉めもここには無い。前者はこの道具の仕事ではなく、
// 後者は運営の判断なので、壇上で押せる場所に置かない。
import { start } from './app.mjs';
import { createBus } from './bus.mjs';
import { overlayUrlFor, ago, withEnv } from './ids.mjs';

/** 運営のリンクをアプリに渡す形。アプリが入っていなければ何も起きない。 */
export function appUrlFor(eventId, trackId) {
  const u = new URL('danmaku://track');
  u.searchParams.set('e', eventId);
  u.searchParams.set('t', trackId);
  return u.toString();
}

export async function createStage({ eventId, trackId, now = () => Date.now() } = {}) {
  const el = (id) => document.getElementById(id);
  const state = el('state');

  // Firestore はローカルに楽観適用してからサーバの判定が返るので、
  // 巻き戻しのスナップショットでエラー表示が消えないようにする。
  let stickyError = null, errorTimer = 0;
  const say = (text, sub = '', kind = '') => {
    if (stickyError) return;
    el('stateText').textContent = text;
    el('stateSub').textContent = sub;
    state.dataset.kind = kind;
  };
  const fail = (text) => {
    stickyError = text;
    el('stateText').textContent = text;
    el('stateSub').textContent = '';
    state.dataset.kind = 'error';
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { stickyError = null; render(); }, 6000);
  };

  if (!eventId || !trackId) {
    fail('リンクが正しくありません（運営からのリンクを開く）');
    return null;
  }

  const { uid, db, sdk } = await start();
  const bus = createBus(sdk, { db, eventId, trackId, uid, now });

  let track = null;
  let received = 0;
  let lastAt = null;
  let appConnected = false;
  const seen = new Set();

  el('openApp').href = appUrlFor(eventId, trackId);
  el('browserWay').href = withEnv(`${overlayUrlFor(eventId, trackId)}&capture=1`);

  // --- 画面の出し分け ---------------------------------------------------
  function render() {
    if (!track) { say('トラックが見つかりません', '', 'error'); return; }

    el('trackName').textContent = track.name;
    el('eventName').textContent = eventNameText;

    el('step1').dataset.state = appConnected ? 'done' : 'now';
    el('appOk').classList.toggle('hidden', !appConnected);

    // 止めたのは運営。登壇者には何が起きているかだけ伝える。
    el('stoppedNote').classList.toggle('hidden', !track.stopped);

    if (track.stopped) say('停止中', '運営が投稿を止めています', 'stopped');
    else say('受付中', lastAt ? `最後のコメント ${ago(lastAt, now())}` : 'まだ届いていません', 'live');
  }

  let eventNameText = '';
  (async () => {
    try {
      const snap = await sdk.getDoc(sdk.doc(db, 'events', eventId));
      eventNameText = snap.exists() ? (snap.data().name ?? '') : '';
      render();
    } catch { /* 名前が出ないだけなので続ける */ }
  })();

  // --- 購読 -------------------------------------------------------------
  bus.watchTrack((t) => {
    track = t;
    if (!t) { fail(`トラックが見つかりません: ${trackId}`); return; }
    render();
  }, (e) => fail(`読めない: ${e.code ?? e.message}`));

  const unwatchComments = bus.watchComments((c) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    addToFeed(c);
  }, (e) => fail(`購読できない: ${e.code ?? e.message}`));

  function addToFeed(c) {
    const ms = c.createdAt?.toMillis?.() ?? now();
    lastAt = Math.max(lastAt ?? 0, ms);
    received++;
    el('count').textContent = String(received);
    el('feedEmpty').classList.add('hidden');

    const li = document.createElement('li');
    const at = document.createElement('span');
    at.className = 'at';
    at.dataset.at = String(ms);
    at.textContent = ago(ms, now());
    const tx = document.createElement('span');
    tx.className = 'tx';
    // コメントは外から来る。textContent で入れる。
    tx.textContent = c.text;
    li.append(at, tx);
    el('feed').prepend(li);
    while (el('feed').children.length > 80) el('feed').lastElementChild.remove();
    render();
  }

  // 相対時刻は放っておくと古いまま。毎秒書き換える。
  const ticker = setInterval(() => {
    const t = now();
    for (const at of el('feed').querySelectorAll('.at')) {
      at.textContent = ago(Number(at.dataset.at), t);
    }
    if (track && !track.stopped && lastAt) {
      el('stateSub').textContent = `最後のコメント ${ago(lastAt, t)}`;
    }
  }, 1000);

  // アプリが開いたかどうかは直接は分からない。
  // 弾幕ページを開いたという合図を受け取って、手順1を完了にする。
  addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === 'danmaku:overlay-ready') { appConnected = true; render(); }
  });

  render();
  return {
    bus, eventId, trackId,
    get received() { return received; },
    get track() { return track; },
    stop() { clearInterval(ticker); unwatchComments(); },
  };
}
