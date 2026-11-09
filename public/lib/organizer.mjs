// 運営者の画面。2つの面に分かれる。
//
//   一覧（e なし）… 「今日」の受付の開け閉め。当日その場で押す操作だけ
//   詳細（e つき）… 配り物の準備。QR とリンク、トラックの出し入れ
//
// 分けているのは、同じ日に2つイベントが走ると当日の操作が届かなくなるため。
// 1つの詳細ページに混ぜていると、運営はまず「どのイベントか」を選ばされ、
// 開いた先には当日使わない配り物が並ぶ。止めたいときに止められない。
// 弾幕そのものやコメントの中身は出さない。運営が見たいのは「配れているか」だけ。
import { watchOrganizer, signInOrganizer, signOutOrganizer } from './app.mjs';
import { createEventBus, createBus } from './bus.mjs';
import { QRCode } from '../vendor/entry.js';
import {
  newEventId, newTrackId, newHandoffCode, slugFromName,
  stageUrlFor, postUrlFor, eventUrlFor, formatDate, withEnv, nextTrackName,
} from './ids.mjs';

/** 今日の日付。「今日」の判定と見出しで同じものを使う。 */
const todayIso = () => new Date().toISOString().slice(0, 10);

/** 受付中か。stopped が無いものも受付中として扱う（作った直後がこれ）。 */
const isOpen = (t) => t.stopped !== true;

export async function createOrganizer({ eventId, random = () => Math.random() } = {}) {
  const el = (id) => document.getElementById(id);
  const msg = el('msg');

  /**
   * 操作の結果を出す。
   *
   * うまくいった知らせは数秒で引っ込める。「コピーしました」が画面に居座ると、
   * 次に押したときコピーできたのかどうかが分からない。
   * 失敗はそのまま残す。消えると、何が起きたのか確かめる手段が無くなる。
   */
  let clearTimer = 0;
  const say = (text, kind = '') => {
    msg.textContent = text;
    msg.dataset.kind = kind;
    clearTimeout(clearTimer);
    if (kind === 'ok') clearTimer = setTimeout(() => { msg.textContent = ''; }, 8000);
  };
  const fail = (text) => say(text, 'bad');

  /**
   * 日付の欄を読む。
   *
   * `<input type="date">` は、打ちかけ・存在しない日・範囲外のとき value が空文字になる。
   * そのまま `value || ''` で拾うと、200666/06/31 と打った人のイベントが
   * 「日付なし」で黙って作られる。打った本人には何も起きていないように見える。
   * 空にしたのか、読めないのかを区別して返す。
   *
   * @returns {string|null} ISO の文字列。空欄なら ''。読めなければ null。
   */
  function readDate(input) {
    if (input.value) return input.value;
    // 空に見えても、中に打ちかけが残っていれば「空欄」ではない
    return input.validity.badInput || input.validity.rangeOverflow
      || input.validity.rangeUnderflow ? null : '';
  }
  const DATE_HELP = '開催日を読めません。日付なしで保存されます（年は4桁、実在する日付で）';

  /**
   * 欄を離れたときに、読めないことだけ伝える。操作は止めない。
   *
   * 開催日は任意で、無くてもイベントは作れるし、あとから詳細画面で直せる。
   * 任意の欄のために「イベントを作る」を止めるほうが損が大きい。
   * change は打ちかけのままだと鳴らないので blur で見る。
   */
  function warnOnBadDate(input) {
    input.addEventListener('blur', () => {
      if (readDate(input) === null) fail(DATE_HELP);
    });
  }

  // 運営は匿名では入れない。イベントは当日まで残るので、端末を変えても
  // 同じものを開ける必要がある。Rules 側でも匿名の作成・削除を拒んでいる。
  let uid, db, sdk, events, booted = false;

  /**
   * 直している最中のトラックID。
   *
   * 準備の表はトラックの購読が届くたびに丸ごと描き直される。直している最中に
   * 誰かが受付を開け閉めすると入力欄ごと消えるので、どこを直していたかは表の外に持つ。
   * サインインの門より手前で宣言する。描き直しは購読が届いたときに走るので、
   * 使う場所より後ろに置くと、先に走った描き直しが未初期化の変数を読む。
   */
  let renaming = null;

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

  // --- イベント一覧と当日の操作 -----------------------------------------
  function list() {
    el('listView').classList.remove('hidden');

    // 今日のイベントだけはトラックの状態まで購読する。
    //
    // 一覧の受付状況は getTracksOnce で一度だけ読んでいる。当日の面はそれでは足りない。
    // 「止める」を押しても pill が変わらなければ、押せたのかどうかが分からない。
    const liveTracks = new Map();   // eventId → いま届いているトラック
    const watching = new Map();     // eventId → 購読を止める関数
    let evRows = [];                // 一覧に出すイベント（トラック数つき）

    /** 今日のイベントは、受付の数も「いま」のものを使う。同じ画面に古い数字を並べない。 */
    const withLive = (ev) => {
      const live = liveTracks.get(ev.id);
      return live
        ? { ...ev, trackCount: live.length, openCount: live.filter(isOpen).length }
        : ev;
    };
    const repaint = () => {
      paintList(evRows.map(withLive));
      paintToday(evRows.filter((ev) => ev.heldOn === todayIso()), liveTracks);
    };

    /** 今日のイベントの購読を、届いた一覧に合わせる。 */
    function syncToday(rows) {
      const want = new Set(rows.filter((ev) => ev.heldOn === todayIso()).map((ev) => ev.id));
      for (const [id, stop] of watching) {
        if (want.has(id)) continue;
        stop();
        watching.delete(id);
        liveTracks.delete(id);
      }
      for (const id of want) {
        if (watching.has(id)) continue;
        watching.set(id, events.watchTracks(id, (tracks) => {
          liveTracks.set(id, tracks);
          repaint();
        }, (e) => fail(`トラックを読めない: ${e.code ?? e.message}`)));
      }
    }

    const unwatch = events.watchMyEvents(async (rows) => {
      // 件数を数える前に購読を始める。当日の面は先に出るほうがいい。
      syncToday(rows);
      // トラック数は一覧には入っていないので、イベントごとに数える
      const withCounts = await Promise.all(rows.map(async (ev) => {
        try {
          const snap = await events.getTracksOnce(ev.id);
          const tracks = snap.docs.map((d) => d.data());
          return { ...ev, trackCount: tracks.length, openCount: tracks.filter(isOpen).length };
        } catch (e) {
          // 握りつぶすと「—」が出るだけで原因が見えない
          fail(`トラック数を数えられない: ${e.code ?? e.message}`);
          return { ...ev, trackCount: null, openCount: 0 };
        }
      }));
      evRows = withCounts;
      repaint();
    }, (e) => fail(`イベントを読めない: ${e.code ?? e.message}`));

    el('createEvent').addEventListener('click', async () => {
      const name = el('newEventName').value.trim();
      if (!name) { fail('イベント名を入れる'); el('newEventName').focus(); return; }
      el('createEvent').disabled = true;
      try {
        const id = newEventId(random);
        await events.createEvent(id, { name, heldOn: readDate(el('newEventDate')) ?? '' });
        await events.setEventHandoff(id, newHandoffCode(random));
        location.href = withEnv(`./organizer.html?e=${encodeURIComponent(id)}`);
      } catch (e) {
        fail(`作れない: ${e.code ?? e.message}`);
        el('createEvent').disabled = false;
      }
    });
    warnOnBadDate(el('newEventDate'));

    // Enter では作らない。押し間違いでイベントが増えると消す手間になる。
    el('newEventName').focus();

    return {
      kind: 'list',
      stop: () => {
        unwatch?.();
        for (const stop of watching.values()) stop();
        watching.clear();
      },
    };
  }

  /** 開催日で「これから」と「終わった」に分ける。日付が無いものは「これから」に置く。 */
  function splitByDate(rows, today = todayIso()) {
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

  // --- 当日 -------------------------------------------------------------
  /**
   * 今日ひらいているイベントの受付を並べる。
   *
   * 今日が無ければ塊ごと出さない。見出しだけが残ると、
   * 毎日ひらく画面の上端が「今日は何も無い」で埋まる。
   */
  function paintToday(todays, liveTracks) {
    const host = el('today');
    host.replaceChildren();
    // トラックが届いていないイベントは出さない。一瞬だけ「トラックがありません」を見せないため。
    const ready = todays.filter((ev) => liveTracks.has(ev.id));
    el('todayLane').classList.toggle('hidden', ready.length === 0);
    el('todayDate').textContent = formatDate(todayIso());
    for (const ev of ready) host.append(todayCard(ev, liveTracks.get(ev.id)));
  }

  /** イベント1つぶんの塊。「全部」の操作はこの中だけに効く。 */
  function todayCard(ev, rows) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.event = ev.id;

    const head = document.createElement('div');
    head.className = 'today-head';
    const title = document.createElement('h3');
    title.textContent = ev.name;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = rows.length
      ? `受付中 ${rows.filter(isOpen).length} / ${rows.length}` : 'トラックがありません';

    // 開けるのと止めるのは対になる操作。片方だけ目立たせると、
    // 止めるほうが常に画面でいちばん強い要素になってしまう。
    // 名前を読み上げに入れる。同じ文字のボタンが、イベントの数だけ並ぶ。
    const acts = document.createElement('span');
    acts.className = 'acts';
    const openAll = button('全部で受け付ける', 'btn sm openAll',
      () => setAll(ev, rows, 'open', openAll), `${ev.name} の全トラックで受け付ける`);
    const stopAll = button('全部止める', 'btn sm caution stopAll',
      () => setAll(ev, rows, 'close', stopAll), `${ev.name} の全トラックを止める`);
    acts.append(openAll, stopAll);
    head.append(title, hint, acts);
    card.append(head);

    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'today-empty';
      p.textContent = '下の一覧からこのイベントを開いて、トラックを足してください。';
      card.append(p);
      return card;
    }

    const scroller = document.createElement('div');
    scroller.className = 'scroller';
    const table = document.createElement('table');
    table.className = 'rows';
    table.innerHTML = `
      <caption class="visually-hidden"></caption>
      <thead><tr>
        <th scope="col">トラック</th><th scope="col">受付</th>
        <th scope="col" style="text-align:right">件数</th>
        <th scope="col">受付の操作</th>
      </tr></thead>
      <tbody></tbody>`;
    // イベント名は運営が打った文字。組み立てた HTML には混ぜない。
    table.querySelector('caption').textContent = `${ev.name} のトラックと受付`;
    const body = table.querySelector('tbody');

    for (const t of rows) {
      const tr = document.createElement('tr');
      const name = cell(tr);
      name.style.fontWeight = '700';
      name.textContent = t.name;
      cell(tr).append(statePill(t));
      const count = cell(tr);
      count.className = 'count';
      count.textContent = '—';
      countComments(ev.id, t, count);
      const act = cell(tr);
      act.className = 'link';
      act.append(guardButton(ev.id, t));
      body.append(tr);
    }
    scroller.append(table);
    card.append(scroller);
    return card;
  }

  /**
   * そのイベントのトラックをまとめて開ける／止める。
   *
   * 日付ではなくイベントで区切る。同じ日に2つ走っているとき、
   * 日付でまとめると関係ないイベントの受付まで閉じてしまう。
   */
  async function setAll(ev, rows, kind, btn) {
    if (!rows.length) { fail('トラックがありません'); return; }
    btn.disabled = true;
    try {
      await Promise.all(rows.map((t) => {
        const bus = createBus(sdk, { db, eventId: ev.id, trackId: t.id, uid });
        return kind === 'open' ? bus.open() : bus.close();
      }));
      say(kind === 'open'
        ? `${ev.name} の全トラックで投稿を受け付けます`
        : `${ev.name} の全トラックの投稿を止めました`, 'ok');
    } catch (e) {
      fail(kind === 'open'
        ? `開けられない: ${e.code ?? e.message}`
        : `止められない: ${e.code ?? e.message}`);
    } finally {
      // 成功すれば購読が届いて塊ごと描き直る。外れたボタンに触っても害は無い。
      btn.disabled = false;
    }
  }

  /**
   * イベント単位のまとめ操作。トラックが1つも無いうちは出さない。
   *
   * 表の中ではなく見出しの行に置く。1トラックだけ止めるつもりで
   * 全部止める事故は、距離でしか防げない。
   */
  function paintEventActs(eventId, rows) {
    const acts = el('evActs');
    acts.replaceChildren();
    if (!rows.length) return;

    const ev = { id: eventId, name: el('evName').textContent };
    // 開けるのと止めるのは対になる操作。片方だけ目立たせると、
    // 止めるほうが常に画面でいちばん強い要素になってしまう。
    const openAll = button('全部で受け付ける', 'btn sm openAll',
      () => setAll(ev, rows, 'open', openAll), `${ev.name} の全トラックで受け付ける`);
    const stopAll = button('全部止める', 'btn sm caution stopAll',
      () => setAll(ev, rows, 'close', stopAll), `${ev.name} の全トラックを止める`);
    acts.append(openAll, stopAll);
  }

  /** 受付中か、そうでないか。状態はこの2つだけ。 */
  function statePill(t) {
    const pill = document.createElement('span');
    if (isOpen(t)) { pill.className = 'pill good'; pill.textContent = '受付中'; }
    else { pill.className = 'pill bad'; pill.textContent = '停止中'; }
    return pill;
  }

  /** 受付の開け閉め。運営だけの操作で、登壇者の画面には押す場所が無い。 */
  function guardButton(eventId, t) {
    const bus = () => createBus(sdk, { db, eventId, trackId: t.id, uid });
    return isOpen(t)
      ? button('止める', 'btn sm stop', async () => {
          try { await bus().close(); say(`${t.name} の投稿を止めました`, 'ok'); }
          catch (e) { fail(`止められない: ${e.code ?? e.message}`); }
        }, `${t.name} の投稿を止める`)
      : button('受け付ける', 'btn sm resume', async () => {
          try { await bus().open(); say(`${t.name} で投稿を受け付けます`, 'ok'); }
          catch (e) { fail(`開けられない: ${e.code ?? e.message}`); }
        }, `${t.name} の投稿を受け付ける`);
  }

  // --- イベント詳細 -------------------------------------------------------
  //
  // 配るのと開け閉めするのが、運営のやること全部。両方ここにある。
  // 分けていたころは「当日の操作をどっちのページに置くか」が問題だったが、
  // 分けるのをやめたので問いごと消えた。
  async function detail(id) {
    el('detailView').classList.remove('hidden');

    let tracks = [];
    let heldOn = null;

    // 配る URL はイベントの中身に依らない。届くのを待たずに出す。
    el('evUrl').textContent = eventUrlFor(id);

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
      // まとめ操作の読み上げはイベント名を含む。トラックのほうが先に届くと
      // 名前がまだ無いので、イベントが届いた時点で書き直す。
      paintEventActs(id, tracks);
      // 打っている最中に上書きしない
      if (document.activeElement !== el('evNameInput')) el('evNameInput').value = ev.name ?? '';
      if (document.activeElement !== el('evDateInput')) el('evDateInput').value = ev.heldOn ?? '';
    }, (e) => fail(`読めない: ${e.code ?? e.message}`));

    // 名前と日付はその場で直せる。作り直させない。
    //
    // 見出しがそのまま入力欄になっているので、空のまま離れると見出しが消えたように
    // 見える。保存できなかったときは、入力欄のほうを元に戻す。
    const saveEvent = async () => {
      const name = el('evNameInput').value.trim();
      if (!name) {
        fail('イベント名は空にできません');
        el('evNameInput').value = el('evName').textContent;
        return;
      }
      try {
        await events.renameEvent(id, { name, heldOn: readDate(el('evDateInput')) ?? '' });
        say('保存しました', 'ok');
      } catch (e) {
        fail(`保存できない: ${e.code ?? e.message}`);
        el('evNameInput').value = el('evName').textContent;
      }
    };
    el('evNameInput').addEventListener('change', saveEvent);
    el('evDateInput').addEventListener('change', saveEvent);
    warnOnBadDate(el('evDateInput'));

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

    el('copyEvUrl').addEventListener('click', () => copy(eventUrlFor(id)));
    // QR は押したときに作る。画面には出さないので、持っておく理由が無い。
    el('printEvQr').addEventListener('click', async () => {
      try {
        const url = eventUrlFor(id);
        printQr(await qrSvg(url, 360), el('evName').textContent, url,
          'スマホで読み取ると、トラックを選んでコメントを送れます');
      } catch (e) { fail(`QRを作れない: ${e.code ?? e.message}`); }
    });

    return { kind: 'detail', eventId: id, get tracks() { return tracks; } };
  }

  /**
   * 準備の表。配るものと、トラックの出し入れだけ。
   *
   * 受付の状態も件数も出さない。当日の面が持っている数字をここにも並べると、
   * どちらを見て判断するのかが決まらない。
   */
  function paintTracks(eventId, rows) {
    const body = el('tracks');
    // 名前を直している最中に購読が届くと、表ごと描き直されて打ちかけが消える。
    // 持って行って入れ直す。他の運営が受付を開け閉めしただけで打ち直しになるのを防ぐ。
    const typed = renaming ? body.querySelector('.renaming')?.value : null;
    body.replaceChildren();
    paintEventActs(eventId, rows);
    // 1つも無いときだけ、トラックが何なのかを出す。
    // 並んでいれば見れば分かるので、ずっと出しておく必要はない。
    el('noTracks').classList.toggle('hidden', rows.length > 0);
    for (const t of rows) {
      const tr = document.createElement('tr');

      cell(tr).append(trackNameCell(eventId, t));

      // 受付。いまどうなっているか（pill）と、変える手（ボタン）を同じマスに置く。
      // pill は押せないので、「止める」と「削除」が隣り合う形にはならない。
      const guard = cell(tr);
      guard.className = 'guard';
      guard.append(statePill(t), guardButton(eventId, t));

      // 渡す相手ごとに分ける。取り違えると、観客に登壇者用の画面を配ることになる。
      const toSpeaker = cell(tr);
      toSpeaker.className = 'link';
      toSpeaker.append(button('リンクをコピー', 'btn sm toSpeaker', async () => {
        try {
          await copy(stageUrlFor(eventId, t.id));
          say(`${t.name} の登壇用リンクをコピーしました`, 'ok');
        } catch (e) { fail(`リンクを作れない: ${e.code ?? e.message}`); }
      }, `${t.name} の登壇用リンクをコピー`));

      // 観客に配るものは繋げて1つの塊にする。登壇者用の単独ボタンと形が違えば、
      // 色が見えなくても取り違えない。
      const toAudience = cell(tr);
      toAudience.className = 'link';
      const audRow = document.createElement('div');
      audRow.className = 'seg';
      audRow.append(
        button('URLをコピー', 'btn sm toAudience', async () => {
          await copy(postUrlFor(eventId, t.id));
          say(`${t.name} の投稿URLをコピーしました`, 'ok');
        }, `${t.name} の投稿URLをコピー`),
        button('QRを作る', 'btn sm toAudience', async () => {
          try {
            const url = postUrlFor(eventId, t.id);
            printQr(await qrSvg(url, 360), t.name, url, 'スマホで読み取るとコメントを送れます');
          } catch (e) { fail(`QRを作れない: ${e.code ?? e.message}`); }
        }, `${t.name} の投稿QRを作って印刷`));
      toAudience.append(audRow);

      const del = cell(tr);
      del.append(button('削除', 'btn sm remove', async () => {
        if (!confirm(`${t.name} を削除します。届いたコメントは見られなくなります。`)) return;
        try {
          await sdk.deleteDoc(sdk.doc(db, 'events', eventId, 'tracks', t.id));
          say(`${t.name} を削除しました`, 'ok');
        } catch (e) { fail(`削除できない: ${e.code ?? e.message}`); }
      }, `${t.name} を削除`));

      body.append(tr);
    }
    // 直していた行が残っていれば、打ちかけと入力の位置を戻す。
    const back = renaming ? body.querySelector('.renaming') : null;
    if (back) {
      if (typed != null) back.value = typed;
      back.focus();
    }
  }

  /**
   * 準備の表のトラック名。押すと入力欄になる。
   *
   * 入力欄を出したままにはしない。配り物のボタンを探す手が名前の欄に当たるし、
   * 行の中に常に入力欄があると「ここに演題を書くのか」と読まれる。
   * イベント名と同じ直し方に揃える（change で保存、空なら元に戻す）。
   */
  function trackNameCell(eventId, t) {
    if (renaming === t.id) return nameInput(eventId, t);
    // 見える文字は名前だけ。何のボタンかは読み上げ用の名前が持つ。
    return button(t.name, 'rename', (e) => {
      renaming = t.id;
      const input = nameInput(eventId, t);
      e.currentTarget.replaceWith(input);
      input.focus();
      input.select();
    }, `${t.name} の名前を変える`);
  }

  function nameInput(eventId, t) {
    const input = document.createElement('input');
    input.className = 'renaming';
    input.value = t.name;
    input.maxLength = 40;            // Rules 側の上限と同じ
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `${t.name} の名前`);

    // Tab で離れると change と blur が続けて飛ぶ。保存を2回投げない。
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      renaming = null;
      const name = input.value.trim();
      const revert = () => input.replaceWith(trackNameCell(eventId, t));
      if (!save || name === t.name) { revert(); return; }
      if (!name) {
        // 空のまま離れると、行から名前が消えたように見える。欄のほうを元に戻す。
        fail('トラック名は空にできません');
        revert();
        return;
      }
      try {
        // 購読が届けば表ごと描き直されるので、ここでは欄を戻さない。
        await events.renameTrack(eventId, t.id, { name });
        say(`${t.name} を ${name} に変えました。配ったQRとリンクはそのまま使えます`, 'ok');
      } catch (e) {
        fail(`名前を変えられない: ${e.code ?? e.message}`);
        revert();
      }
    };
    input.addEventListener('change', () => finish(true));
    input.addEventListener('blur', () => finish(true));
    // 押し間違えて開いたときの出口。打った分は捨てる。
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(false); });
    return input;
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
  /**
   * ボタン。
   *
   * label は読み上げ用の名前。表の中では列見出しが意味を持つので、
   * 見える文字は「リンクをコピー」まで削れる。ただしボタンだけを辿る読み方では
   * 列見出しが付いてこないので、そのときのために全部の意味を持たせる。
   */
  function button(text, cls, onClick, label = '') {
    const b = document.createElement('button');
    b.className = cls; b.textContent = text;
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); say('コピーしました', 'ok'); }
    catch { fail('コピーできませんでした'); }
  }
}

/**
 * QR の絵。刷る直前にだけ作る。
 *
 * 画面に置いておく必要がない。読み取るのは観客で、運営がこの絵から読めることは何も無い。
 * 誤り訂正は M のまま。紙に刷って貼る前提なので、汚れに強い H まで上げる必要はない。
 */
const qrSvg = (url, width) =>
  QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width });

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
