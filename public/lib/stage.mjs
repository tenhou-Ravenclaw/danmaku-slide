// 登壇者の画面。登壇中に見るので、焦って探す要素が無い状態にする。
//
// 決めることは1つだけ。コメントをスライドのどこに流すか。
// 決め終わると上のバーに畳まれ、画面はコメント一覧だけになる。
//
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
  const statebox = el('statebox');

  /**
   * 状態を出す。
   *
   * reason（止まっている理由）は変わらないので読み上げの中に置く。
   * sub（最後のコメント何秒前）は毎秒変わるので読み上げの外に置く。
   * 見た目は同じ場所に出るが、読み上げでの扱いが違う。
   */
  let stickyError = null, errorTimer = 0;
  const say = (text, { reason = '', sub = '', kind = '' } = {}) => {
    if (stickyError) return;
    el('stateText').textContent = text;
    el('stateReason').textContent = reason;
    el('stateSub').textContent = sub;
    statebox.dataset.kind = kind;
  };
  const fail = (text) => {
    stickyError = text;
    el('stateText').textContent = text;
    el('stateReason').textContent = '';
    el('stateSub').textContent = '';
    statebox.dataset.kind = 'error';
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
  const seen = new Set();

  el('openApp').href = appUrlFor(eventId, trackId);
  el('browserWay').href = withEnv(`${overlayUrlFor(eventId, trackId)}&capture=1`);

  // --- どこに流しているか ------------------------------------------------
  // idle    まだ決めていない
  // handoff アプリに渡した。開いたかどうかはこちらからは分からない
  // live    こちらが開いた窓から合図が返ってきた
  const FLOW = {
    idle: {
      title: 'スライドにまだ流していません',
      sub: '観客のコメントがスライドの上を流れます',
      mark: circle(),
    },
    handoff: {
      title: 'アプリに渡しました',
      sub: 'アプリの窓を確かめてください。開かないときはアプリを入手してください',
      mark: circle(),
    },
    live: {
      title: 'ブラウザでスライドに流しています',
      sub: 'このまま発表できます',
      mark: check(),
    },
  };

  function circle() {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>';
  }
  function check() {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="10" fill="currentColor"/>'
      + '<path d="M7.5 12.4l3 3 6-6.4" stroke="var(--surface)" stroke-width="2.2"'
      + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  let flow = 'idle';
  function setFlow(next, { showActs = false } = {}) {
    flow = next;
    const f = FLOW[next];
    el('flowbox').dataset.state = next;
    if (showActs) el('flowbox').dataset.acts = '1';
    else el('flowbox').removeAttribute('data-acts');
    el('flowTitle').textContent = f.title;
    el('flowSub').textContent = f.sub;
    el('flowMark').innerHTML = f.mark;
    el('flowMark').style.color = next === 'live' ? 'var(--good)' : 'var(--muted)';
  }
  setFlow('idle');

  // アプリに渡したかどうかは、こちらからは確かめられない。
  // Electron は別の窓で開くので opener が無く、合図が返らない。
  // 分かるのは「渡した」ところまでなので、そこまでを出す。
  el('openApp').addEventListener('click', () => {
    if (flow !== 'live') setFlow('handoff');
  });

  // 同じタブで遷移するとこの画面が消え、合図も返らなくなる。
  // 別の窓で開いて opener を残す。
  el('browserWay').addEventListener('click', (e) => {
    e.preventDefault();
    window.open(el('browserWay').href, 'danmaku-overlay');
  });

  el('changeWay').addEventListener('click', () => setFlow(flow, { showActs: true }));

  // --- 画面の出し分け ---------------------------------------------------
  function render() {
    if (!track) { say('トラックが見つかりません', '', 'error'); return; }

    el('trackName').textContent = track.name;
    el('eventName').textContent = eventNameText;

    // 止めたのは運営。登壇者には何が起きているかと、誰に言えばいいかを伝える。
    if (track.stopped) {
      say('停止中', { reason: '運営が止めています。再開は運営へ', kind: 'stopped' });
    } else {
      say('受付中', {
        sub: lastAt ? `最後のコメント ${ago(lastAt, now())}` : 'まだ届いていません',
        kind: 'live',
      });
    }
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

  // こちらが開いた窓からだけ合図が返る。返ってきたら「流している」に変える。
  addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === 'danmaku:overlay-ready') setFlow('live');
  });

  render();
  return {
    bus, eventId, trackId,
    get received() { return received; },
    get track() { return track; },
    get flow() { return flow; },
    stop() { clearInterval(ticker); unwatchComments(); },
  };
}
