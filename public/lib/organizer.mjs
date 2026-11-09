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

export async function createOrganizer({ eventId, wantNew = false, random = () => Math.random() } = {}) {
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
    el('tabBar').classList.remove('hidden');
    tabs();
    if (eventId) detail(eventId);
    else if (wantNew) create();
    else openNearest();
  });

  return { kind: 'gate' };

  // --- イベントのタブ ---------------------------------------------------
  //
  // 一覧と詳細を分けていたころは「当日の操作をどっちのページに置くか」が
  // 問題だった。分けるのをやめたので、問いごと消えた。
  //
  // タブは本物のリンクにする。`?e=` の直リンクがそのまま残り、
  // 中クリックもキーボードも作らずに済む。
  function tabs() {
    // 終わったものは既定で畳む。出す／畳むをここで覚える。
    let showPast = false;
    let rows = [];

    const paint = () => {
      const { upcoming, past } = splitByDate(rows);
      // いま開いているものは、終わっていても必ず出す。
      // 自分が見ているイベントのタブが無いと、どれを開いているのか分からない。
      const shown = showPast ? [...upcoming, ...past]
        : [...upcoming, ...past.filter((ev) => ev.id === eventId)];
      const strip = el('tabs');
      strip.replaceChildren();
      for (const ev of shown) strip.append(tab(ev));

      // 終わったものが無いうちは、戻り口そのものを出さない。
      const back = el('showPast');
      back.classList.toggle('hidden', past.length === 0);
      back.textContent = showPast ? '終わったものを畳む' : `終わったもの（${past.length}）`;
      back.setAttribute('aria-expanded', String(showPast));
    };

    el('showPast').addEventListener('click', () => { showPast = !showPast; paint(); });

    const unwatch = events.watchMyEvents((next) => { rows = next; paint(); },
      (e) => fail(`イベントを読めない: ${e.code ?? e.message}`));

    return { kind: 'tabs', stop: () => unwatch?.() };
  }

  /** タブ1枚。開いている1本だけが aria-current を持つ。 */
  function tab(ev) {
    const a = document.createElement('a');
    a.className = 'tab';
    a.dataset.event = ev.id;
    a.href = withEnv(`./organizer.html?e=${encodeURIComponent(ev.id)}`);
    if (ev.id === eventId) a.setAttribute('aria-current', 'page');

    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = ev.name;

    // 同じ日に2本あることがある。日付が無いと、どちらも今日だと分からない。
    const when = document.createElement('span');
    when.className = 'tdate';
    when.textContent = ev.heldOn === todayIso()
      ? `${formatDate(ev.heldOn)}・今日`
      : (formatDate(ev.heldOn) || '日付なし');

    a.append(name, when);
    return a;
  }

  /**
   * サインイン直後に、いちばん近いイベントを開く。
   *
   * 作るのは普通1回きりで、開くのは何度もある。作る画面を最初に出すと、
   * 当日いちばんよくやることが、いちばん手間のかかる位置に来る。
   *
   * URL を `?e=` に付け替えるので、再読み込みしても同じものが出る。
   * 履歴には積まない（`replace`）。戻るで「どこでもない画面」に戻れても意味が無い。
   */
  function openNearest() {
    // 1本目が届いた時点で決める。待ち続けると、作る画面が一瞬出てから飛ぶことになる。
    //
    // 購読を止める関数は、最初の呼び出しより後に代入されることがある。
    // そのまま `unwatch?.()` を書くと、1回目だけ止め損ねて二重に走る。
    let done = false;
    let unwatch = null;
    unwatch = events.watchMyEvents((rows) => {
      if (done) return;
      done = true;
      unwatch?.();
      const pick = nearestEvent(rows);
      // 1本も無ければ作る画面。最初に使う人がここに来る。
      if (!pick) { create(); return; }
      location.replace(withEnv(`./organizer.html?e=${encodeURIComponent(pick.id)}`));
    }, (e) => { fail(`イベントを読めない: ${e.code ?? e.message}`); create(); });
  }

  /**
   * いちばん近いイベント。今日 → これから近い順 → 終わったもののうち新しい順。
   *
   * 日付なしは `splitByDate` が「これから」に置く。まだ日が決まっていないものなので、
   * 終わったものより手前に来るのは正しい。
   */
  function nearestEvent(rows) {
    const { upcoming, past } = splitByDate(rows);
    return upcoming[0] ?? past[0] ?? null;
  }

  // --- イベントを作る ---------------------------------------------------
  //
  // イベントを選んでいないときの面。タブの `＋` もここへ来る。
  function create() {
    el('listView').classList.remove('hidden');

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
    return { kind: 'create' };
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
    // QR は押したときに作る。画面に置いておく理由が無い。読むのは観客で、
    // 運営がこの絵から読めることは何も無い。
    el('copyEvQr').addEventListener('click', () => copyQr(eventUrlFor(id), el('evName').textContent));

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
        // 貼る先はチラシや掲示物。刷った紙ではなく画像が要る。
        button('QRをコピー', 'btn sm toAudience',
          () => copyQr(postUrlFor(eventId, t.id), t.name),
          `${t.name} の投稿QRを画像としてコピー`));
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
  /**
   * QR の画像をコピーする。
   *
   * ClipboardItem には Blob ではなく Blob を返す Promise を渡す。
   * 先に await して作ってから書こうとすると、Safari が「操作から離れた」と見て拒む。
   *
   * 画像を書けないブラウザがある。黙って諦めない。押したのに何も起きないのが
   * いちばん困るので、そのときはファイルとして渡す。
   */
  async function copyQr(url, name) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': qrPng(url) })]);
      say(`${name} のQR画像をコピーしました`, 'ok');
      return;
    } catch { /* 書けない環境。下で保存に回す。 */ }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await qrPng(url));
      a.download = `${name}-qr.png`;
      a.click();
      URL.revokeObjectURL(a.href);
      say(`${name} のQRを画像として保存しました（この環境ではコピーできません）`, 'ok');
    } catch (e) { fail(`QRを作れない: ${e.message}`); }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); say('コピーしました', 'ok'); }
    catch { fail('コピーできませんでした'); }
  }
}

/**
 * QR を PNG にする。チラシやスライドに貼るためのもの。
 *
 * 1024px。チラシに 40mm で載せても十分に細かい。
 * ベクタ（SVG）のほうが印刷の質は上だが、SVG はほとんどのデザインツールに貼れない。
 */
async function qrPng(url, size = 1024) {
  const svg = await qrSvg(url, size);
  const img = new Image();
  // 外を参照しない絵なので、data: から読んでも canvas は汚れない。
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  // 透過のまま貼ると、暗い背景のスライドで QR が読めなくなる。白を敷く。
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.drawImage(img, 0, 0, size, size);
  return new Promise((done, stop) =>
    c.toBlob((b) => (b ? done(b) : stop(new Error('画像にできない'))), 'image/png'));
}

/**
 * QR の絵。刷る直前にだけ作る。
 *
 * 画面に置いておく必要がない。読み取るのは観客で、運営がこの絵から読めることは何も無い。
 * 誤り訂正は M のまま。紙に刷って貼る前提なので、汚れに強い H まで上げる必要はない。
 */
const qrSvg = (url, width) =>
  QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width });

