// 登壇者の画面。登壇中に見るので、焦って探す要素が無い状態にする。
//
// やることは3つだけ。重ねる、開始する、止める。
// 「投稿を止める」は荒らしへの最終手段なので、常に目に入る位置に置いたまま動かさない。
import { start } from './app.mjs';
import { createBus } from './bus.mjs';
import { stageUrlFor, overlayUrlFor, ago, withEnv } from './ids.mjs';

/** 運営のリンクをアプリに渡す形。アプリが入っていなければ何も起きない。 */
export function appUrlFor(eventId, trackId, code) {
  const u = new URL('danmaku://track');
  u.searchParams.set('e', eventId);
  u.searchParams.set('t', trackId);
  if (code) u.searchParams.set('k', code);
  return u.toString();
}

export async function createStage({ eventId, trackId, code, now = () => Date.now() } = {}) {
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
  const clearError = () => { stickyError = null; clearTimeout(errorTimer); };

  if (!eventId || !trackId) {
    fail('リンクが正しくありません（運営からのリンクを開く）');
    return null;
  }

  const { uid, db, sdk } = await start();
  const bus = createBus(sdk, { db, eventId, trackId, uid, now });

  // 運営のリンクに合言葉が付いていれば、このトラックの登壇者として登録する。
  // 失敗しても読むことはできるので、黙って続ける。
  if (code) {
    try { await bus.claim(code); }
    catch { /* すでに登録済みか、合言葉が古い */ }
  }

  let track = null;
  let received = 0;
  let lastAt = null;
  let appConnected = false;
  const seen = new Set();

  el('openApp').href = appUrlFor(eventId, trackId, code);
  el('browserWay').href = withEnv(`${overlayUrlFor(eventId, trackId)}&capture=1`);

  // --- 画面の出し分け ---------------------------------------------------
  function render() {
    if (!track) { say('トラックが見つかりません', '', 'error'); return; }

    el('trackName').textContent = track.name;
    el('eventName').textContent = eventNameText;

    // 演題の有無では判定しない。運営が先に入れておくので。
    const started = track.live && !track.stopped;
    el('beforeStart').classList.toggle('hidden', started);
    el('afterStart').classList.toggle('hidden', !started);
    el('step2').dataset.state = started ? 'done' : (appConnected ? 'now' : '');
    el('step1').dataset.state = appConnected ? 'done' : 'now';
    el('appOk').classList.toggle('hidden', !appConnected);

    if (started) el('nowMeta').textContent = startedAtText() || '受付中';

    el('stopBtn').classList.toggle('hidden', track.stopped);
    el('resumeBtn').classList.toggle('hidden', !track.stopped);

    if (track.stopped) say('停止中', '投稿は拒否されています', 'stopped');
    else say('受付中', lastAt ? `最後のコメント ${ago(lastAt, now())}` : 'まだ届いていません', 'live');
  }

  function startedAtText() {
    const ms = track?.sessionStartedAt?.toMillis?.();
    if (!ms) return '';
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 開始`;
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
  let unwatchComments = null;
  let sessionKey = null;

  bus.watchTrack((t) => {
    track = t;
    if (!t) { fail(`トラックが見つかりません: ${trackId}`); return; }
    if (t.sessionStartedAt) watchSession(t.sessionStartedAt);
    render();
  }, (e) => fail(`読めない: ${e.code ?? e.message}`));

  function watchSession(startedAt) {
    const key = startedAt?.toMillis?.() ?? String(startedAt);
    if (key === sessionKey) return;
    sessionKey = key;
    unwatchComments?.();
    // 登壇が切り替わったら手元の一覧も切り替える
    seen.clear();
    received = 0;
    lastAt = null;
    el('feed').replaceChildren();
    el('count').textContent = '0';
    el('feedEmpty').classList.remove('hidden');

    unwatchComments = bus.watchComments(startedAt, (c) => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      addToFeed(c);
    }, (e) => fail(`購読できない: ${e.code ?? e.message}`));
  }

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

  // --- 操作 -------------------------------------------------------------
  el('startBtn').addEventListener('click', async () => {
    el('startBtn').disabled = true;
    try {
      await bus.startSession();
      clearError();
    } catch (e) { fail(`開始できない: ${e.code ?? e.message}`); }
    finally { el('startBtn').disabled = false; }
  });

  el('endBtn').addEventListener('click', async () => {
    el('endBtn').disabled = true;
    try { await bus.endSession(); clearError(); }
    catch (e) { fail(`終えられない: ${e.code ?? e.message}`); }
    finally { el('endBtn').disabled = false; }
  });

  el('stopBtn').addEventListener('click', async () => {
    el('stopBtn').disabled = true;
    try { await bus.stop(); clearError(); }
    catch (e) { fail(`止められない: ${e.code ?? e.message}`); }
    finally { el('stopBtn').disabled = false; }
  });

  el('resumeBtn').addEventListener('click', async () => {
    el('resumeBtn').disabled = true;
    try { await bus.resume(); clearError(); }
    catch (e) { fail(`再開できない: ${e.code ?? e.message}`); }
    finally { el('resumeBtn').disabled = false; }
  });

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
    stop() { clearInterval(ticker); unwatchComments?.(); },
  };
}
