// 運営者の画面。イベントを作り、トラックを並べ、登壇者にリンクを配る。
//
// 事前に落ち着いて使う画面なので、一覧性と編集のしやすさを優先する。
// 弾幕そのものやコメントの中身は出さない。運営が見たいのは「配れているか」だけ。
import { watchOrganizer, signInOrganizer, signOutOrganizer } from './app.mjs';
import { createEventBus, createBus } from './bus.mjs';
import { QRCode } from '../vendor/entry.js';
import {
  newEventId, newTrackId, newHandoffCode, slugFromName,
  stageUrlFor, postUrlFor, eventUrlFor, shortUrl, formatDate, withEnv, nextTrackName,
} from './ids.mjs';

export async function createOrganizer({ eventId, random = () => Math.random() } = {}) {
  const el = (id) => document.getElementById(id);
  const msg = el('msg');
  const say = (text, kind = '') => { msg.textContent = text; msg.dataset.kind = kind; };
  const fail = (text) => say(text, 'bad');

  // 運営は匿名では入れない。イベントは当日まで残るので、端末を変えても
  // 同じものを開ける必要がある。Rules 側でも匿名の作成・削除を拒んでいる。
  let uid, db, sdk, events, booted = false;

  el('signIn').addEventListener('click', async () => {
    el('signIn').disabled = true;
    try { await signInOrganizer(); }
    catch (e) { fail(`サインインできない: ${e.code ?? e.message}`); }
    finally { el('signIn').disabled = false; }
  });
  el('signOut').addEventListener('click', () => signOutOrganizer().then(() => location.reload()));

  await watchOrganizer((user) => {
    const inside = user !== null;
    el('gateView').classList.toggle('hidden', inside);
    el('signOut').classList.toggle('hidden', !inside);
    el('who').textContent = inside ? user.name : '';
    if (!inside || booted) return;
    booted = true;
    ({ uid, db, sdk } = user);
    events = createEventBus(sdk, { db, uid });
    if (eventId) detail(eventId); else list();
  });

  return { kind: 'gate' };

  // --- イベント一覧 -----------------------------------------------------
  function list() {
    el('listView').classList.remove('hidden');

    const unwatch = events.watchMyEvents(async (rows) => {
      // トラック数は一覧には入っていないので、イベントごとに数える
      const withCounts = await Promise.all(rows.map(async (ev) => {
        try {
          const snap = await events.getTracksOnce(ev.id);
          const tracks = snap.docs.map((d) => d.data());
          return { ...ev, trackCount: tracks.length,
            openCount: tracks.filter((t) => t.stopped !== true).length };
        } catch (e) {
          // 握りつぶすと「—」が出るだけで原因が見えない
          fail(`トラック数を数えられない: ${e.code ?? e.message}`);
          return { ...ev, trackCount: null, openCount: 0 };
        }
      }));
      paintList(withCounts);
    }, (e) => fail(`イベントを読めない: ${e.code ?? e.message}`));

    el('createEvent').addEventListener('click', async () => {
      const name = el('newEventName').value.trim();
      if (!name) { fail('イベント名を入れる'); el('newEventName').focus(); return; }
      el('createEvent').disabled = true;
      try {
        const id = newEventId(random);
        await events.createEvent(id, { name, heldOn: el('newEventDate').value || '' });
        await events.setEventHandoff(id, newHandoffCode(random));
        location.href = withEnv(`./organizer.html?e=${encodeURIComponent(id)}`);
      } catch (e) {
        fail(`作れない: ${e.code ?? e.message}`);
        el('createEvent').disabled = false;
      }
    });
    // Enter では作らない。押し間違いでイベントが増えると消す手間になる。
    el('newEventName').focus();

    return { kind: 'list', stop: () => unwatch?.() };
  }

  /** 開催日で「これから」と「終わった」に分ける。日付が無いものは「これから」に置く。 */
  function splitByDate(rows, today = new Date().toISOString().slice(0, 10)) {
    const upcoming = [], past = [];
    for (const ev of rows) (ev.heldOn && ev.heldOn < today ? past : upcoming).push(ev);
    upcoming.sort((a, b) => String(a.heldOn ?? '9999').localeCompare(String(b.heldOn ?? '9999')));
    past.sort((a, b) => String(b.heldOn ?? '').localeCompare(String(a.heldOn ?? '')));
    return { upcoming, past };
  }

  /**
   * 押すと開く行。
   *
   * 1か所にまとめてある。前は開催予定と終了済みで別に書いていて、
   * 終了済みのほうだけ tabIndex と Enter が抜けていた（マウスしか使えなかった）。
   */
  function openableRow(eventId, className) {
    const tr = document.createElement('tr');
    tr.className = className;
    tr.tabIndex = 0;
    const go = () => { location.href = withEnv(`./organizer.html?e=${encodeURIComponent(eventId)}`); };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return tr;
  }

  function paintList(rows) {
    const { upcoming, past } = splitByDate(rows);

    const up = el('upcoming');
    up.replaceChildren();
    for (const ev of upcoming) {
      const tr = openableRow(ev.id, 'clickable');

      const name = cell(tr); name.style.fontWeight = '600'; name.textContent = ev.name;
      cell(tr).textContent = formatDate(ev.heldOn) || '—';
      cell(tr).textContent = ev.trackCount == null ? '—' : `${ev.trackCount} トラック`;

      const st = cell(tr);
      const pill = document.createElement('span');
      if (!ev.trackCount) { pill.className = 'pill mute'; pill.textContent = '準備中'; }
      else if (ev.openCount > 0) {
        pill.className = 'pill good';
        pill.textContent = `受付中 ${ev.openCount} / ${ev.trackCount}`;
      } else { pill.className = 'pill mute'; pill.textContent = '受付前'; }
      st.append(pill);

      const chev = cell(tr); chev.className = 'chev'; chev.textContent = '›';
      up.append(tr);
    }
    el('noUpcoming').classList.toggle('hidden', upcoming.length > 0);
    up.closest('.card').classList.toggle('hidden', upcoming.length === 0);

    const pastBody = el('past');
    pastBody.replaceChildren();
    for (const ev of past) {
      const tr = openableRow(ev.id, 'clickable done');
      cell(tr).textContent = ev.name;
      const right = cell(tr);
      right.style.textAlign = 'right';
      right.textContent = `${formatDate(ev.heldOn)} · ${ev.trackCount} トラック`;
      pastBody.append(tr);
    }
    el('noPast').classList.toggle('hidden', past.length > 0);
    pastBody.closest('.card').classList.toggle('hidden', past.length === 0);
  }

  // --- イベント詳細 -----------------------------------------------------
  async function detail(id) {
    el('detailView').classList.remove('hidden');

    let tracks = [];
    let heldOn = null;
    let painted = false;

    /**
     * 見出しの下の一行。
     *
     * イベントとトラックは別々に届く。たいていイベントのほうが先に来るので、
     * そのとき tracks はまだ空。片方だけで書くと「0 トラック」で固まる。
     */
    const paintMeta = () => {
      el('evMeta').textContent =
        [formatDate(heldOn), `${tracks.length} トラック`].filter(Boolean).join(' · ');
    };

    events.watchEvent(id, (ev) => {
      if (!ev) { fail(`イベントが見つからない: ${id}`); return; }
      el('evName').textContent = ev.name;
      heldOn = ev.heldOn;
      paintMeta();
      // 打っている最中に上書きしない
      if (document.activeElement !== el('evNameInput')) el('evNameInput').value = ev.name ?? '';
      if (document.activeElement !== el('evDateInput')) el('evDateInput').value = ev.heldOn ?? '';
      if (!painted) { painted = true; paintEventQr(id); }
    }, (e) => fail(`読めない: ${e.code ?? e.message}`));

    // 名前と日付はその場で直せる。作り直させない。
    const saveEvent = async () => {
      const name = el('evNameInput').value.trim();
      if (!name) { fail('イベント名は空にできません'); return; }
      try {
        await events.renameEvent(id, { name, heldOn: el('evDateInput').value || '' });
        say('保存しました', 'ok');
      } catch (e) { fail(`保存できない: ${e.code ?? e.message}`); }
    };
    el('evNameInput').addEventListener('change', saveEvent);
    el('evDateInput').addEventListener('change', saveEvent);

    el('deleteEvent').addEventListener('click', async () => {
      const name = el('evNameInput').value.trim() || 'このイベント';
      if (!confirm(`${name} を削除します。トラック ${tracks.length} 件も消えます。`
        + '\n配ったQRとリンクはすべて使えなくなります。')) return;
      el('deleteEvent').disabled = true;
      try {
        // トラックを先に消す。親だけ消すと辿れない行が残る。
        for (const t of tracks) {
          await sdk.deleteDoc(sdk.doc(db, 'events', id, 'tracks', t.id));
        }
        await sdk.deleteDoc(sdk.doc(db, 'events', id));
        location.href = withEnv('./organizer.html');
      } catch (e) {
        fail(`削除できない: ${e.code ?? e.message}`);
        el('deleteEvent').disabled = false;
      }
    });

    events.watchTracks(id, (rows) => {
      tracks = rows;
      paintMeta();
      paintTracks(id, rows);
      suggestTrackName(rows);
    }, (e) => fail(`トラックを読めない: ${e.code ?? e.message}`));

    // Enter では足さない。打ち終わりに Enter を押す癖で増えてしまう。
    el('addTrack').addEventListener('click', () => addTrack(id, tracks));

    // まとめて開ける／止める。当日の朝に1トラックずつ押させない。
    const allTracks = (fn) => Promise.all(tracks.map((t) =>
      fn(createBus(sdk, { db, eventId: id, trackId: t.id, uid }))));

    el('openAll').addEventListener('click', async () => {
      if (!tracks.length) { fail('トラックがありません'); return; }
      el('openAll').disabled = true;
      try {
        await allTracks((b) => b.open());
        say('全トラックで投稿を受け付けます', 'ok');
      } catch (e) {
        fail(`開けられない: ${e.code ?? e.message}`);
      } finally { el('openAll').disabled = false; }
    });

    el('stopAll').addEventListener('click', async () => {
      if (!tracks.length) { fail('トラックがありません'); return; }
      el('stopAll').disabled = true;
      try {
        await allTracks((b) => b.close());
        say('全トラックの投稿を止めました', 'ok');
      } catch (e) {
        fail(`止められない: ${e.code ?? e.message}`);
      } finally { el('stopAll').disabled = false; }
    });

    el('copyEvUrl').addEventListener('click', () => copy(eventUrlFor(id)));
    el('printEvQr').addEventListener('click', () =>
      printQr(el('evQr').innerHTML, el('evName').textContent, eventUrlFor(id),
        'スマホで読み取ると、トラックを選んでコメントを送れます'));

    return { kind: 'detail', eventId: id, get tracks() { return tracks; } };
  }

  async function paintEventQr(id) {
    const url = eventUrlFor(id);
    el('evUrl').textContent = `/e/${id}`;
    el('evQr').innerHTML = await QRCode.toString(url,
      { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 168 });
  }

  function paintTracks(eventId, rows) {
    const body = el('tracks');
    body.replaceChildren();
    for (const t of rows) {
      const tr = document.createElement('tr');

      const name = cell(tr);
      name.style.fontWeight = '700';
      name.textContent = t.name;

      // 受付中か、そうでないか。状態はこの2つだけ。
      const st = cell(tr);
      const pill = document.createElement('span');
      if (t.stopped) { pill.className = 'pill bad'; pill.textContent = '停止中'; }
      else { pill.className = 'pill good'; pill.textContent = '受付中'; }
      st.append(pill);

      const count = cell(tr);
      count.className = 'count';
      count.textContent = '—';
      countComments(eventId, t, count);

      // 渡す相手ごとに分ける。取り違えると、観客に登壇者用の画面を配ることになる。
      const toSpeaker = cell(tr);
      toSpeaker.className = 'link';
      toSpeaker.append(button('登壇用リンクをコピー', 'btn toSpeaker', async () => {
        try {
          await copy(stageUrlFor(eventId, t.id));
          say('登壇用リンクをコピーしました', 'ok');
        } catch (e) { fail(`リンクを作れない: ${e.code ?? e.message}`); }
      }));

      const toAudience = cell(tr);
      toAudience.className = 'link';
      const audRow = document.createElement('div');
      audRow.className = 'row tight';
      audRow.append(
        button('投稿URLをコピー', 'btn toAudience', async () => {
          await copy(postUrlFor(eventId, t.id));
          say('投稿URLをコピーしました', 'ok');
        }),
        button('QRを印刷', 'btn toAudience', async () => {
          const svg = await QRCode.toString(postUrlFor(eventId, t.id),
            { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 360 });
          printQr(svg, t.name, postUrlFor(eventId, t.id), 'スマホで読み取るとコメントを送れます');
        }));
      toAudience.append(audRow);

      // 受付の開け閉めは運営だけの操作。登壇者には押す場所が無い。
      const guard = cell(tr);
      guard.className = 'link';
      const trackBus = () => createBus(sdk, { db, eventId, trackId: t.id, uid });
      guard.append(t.stopped
        ? button('投稿を受け付ける', 'btn resume', async () => {
            try { await trackBus().open(); say(`${t.name} で投稿を受け付けます`, 'ok'); }
            catch (e) { fail(`開けられない: ${e.code ?? e.message}`); }
          })
        : button('投稿を止める', 'btn stop', async () => {
            try { await trackBus().close(); say(`${t.name} の投稿を止めました`, 'ok'); }
            catch (e) { fail(`止められない: ${e.code ?? e.message}`); }
          }));

      const del = cell(tr);
      del.append(button('削除', 'btn remove', async () => {
        if (!confirm(`${t.name} を削除します。届いたコメントは見られなくなります。`)) return;
        try {
          await sdk.deleteDoc(sdk.doc(db, 'events', eventId, 'tracks', t.id));
          say(`${t.name} を削除しました`, 'ok');
        } catch (e) { fail(`削除できない: ${e.code ?? e.message}`); }
      }));

      body.append(tr);
    }
  }

  /**
   * いま届いている件数。
   * 一覧のために全件読むのは重いので、新しい順に上限50件だけ数える。
   */
  async function countComments(eventId, track, cellEl) {
    try {
      const { collection, query, orderBy, limit, getDocs } = sdk;
      const snap = await getDocs(query(
        collection(db, 'events', eventId, 'tracks', track.id, 'comments'),
        orderBy('createdAt', 'desc'), limit(50)));
      cellEl.textContent = snap.size >= 50 ? '50+' : String(snap.size);
    } catch (e) {
      cellEl.textContent = '—';
      fail(`件数を数えられない: ${e.code ?? e.message}`);
    }
  }

  /**
   * 次の名前を入れておく。打たずに押せるし、何が足されるかが見える。
   * 打っている最中は触らない。
   */
  function suggestTrackName(rows) {
    const input = el('newTrackName');
    if (document.activeElement === input) return;
    if (input.value.trim() && input.value !== input.dataset.suggested) return;
    const next = nextTrackName(rows.map((t) => t.name));
    input.value = next;
    input.dataset.suggested = next;
  }

  async function addTrack(eventId, tracks) {
    const name = el('newTrackName').value.trim();
    if (!name) { fail('トラック名を入れる'); el('newTrackName').focus(); return; }
    // Track A → a。読める ID のほうが運営が扱いやすい。衝突したら乱数に落とす。
    const used = new Set(tracks.map((t) => t.id));
    let id = slugFromName(name);
    if (!id || used.has(id)) id = newTrackId(random);
    el('addTrack').disabled = true;
    // 押した瞬間に次の候補へ差し替える。await の後だと、続けて打ち始めた文字まで消える。
    const nextName = nextTrackName([...tracks.map((t) => t.name), name]);
    el('newTrackName').value = nextName;
    el('newTrackName').dataset.suggested = nextName;
    try {
      await events.createTrack(eventId, id, { name });
      say(`${name} を足しました`, 'ok');
    } catch (e) {
      el('newTrackName').value = name;   // 失敗したら戻す
      delete el('newTrackName').dataset.suggested;
      fail(`足せない: ${e.code ?? e.message}`);
    } finally {
      el('addTrack').disabled = false;
      el('newTrackName').focus();
    }
  }

  // --- 小物 -------------------------------------------------------------
  function cell(tr) { const td = document.createElement('td'); tr.append(td); return td; }
  function button(text, cls, onClick) {
    const b = document.createElement('button');
    b.className = cls; b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); say('コピーしました', 'ok'); }
    catch { fail('コピーできませんでした'); }
  }
}

/**
 * QR だけの印刷用ウィンドウ。机に置ける紙にするのが目的なので、
 * スクリーンに QR を出して登壇を邪魔する必要がなくなる。
 */
function printQr(svg, heading, url, note) {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(heading)} のQR</title>
<style>
  @page { margin: 12mm; }
  body { margin:0; font:16px/1.6 -apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;
         display:grid; place-items:center; min-height:100vh; text-align:center; color:#111; }
  h1 { font-size:1.7rem; margin:0 0 .2rem; }
  p { margin:0 0 1.2rem; color:#555; }
  svg { width:76mm; height:76mm; }
  .url { margin-top:1rem; font:500 .85rem ui-monospace,Menlo,monospace; color:#333; word-break:break-all; }
</style>
<body><div><h1>${esc(heading)}</h1><p>${esc(note)}</p>${svg}
<div class="url">${esc(url)}</div></div></body>`);
  w.document.close();
  w.focus();
  w.print();
}

const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
