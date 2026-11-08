// Firestore との境界。描画も DOM も持たない。
//
// SDK を import せず引数で受け取る。ブラウザは同一オリジンに束ねた
// public/vendor/entry.js を渡し、テストは npm の firebase/firestore を渡す。
// こうしないと、ブラウザ向けバンドルを Node から読むことになってテストが書けない。

/** Rules 側と同じ上限。UI でも同じ値を使う。 */
export const MAX_TEXT = 60;

/** Rules 側のクールダウン。UI で待ち時間を出すために公開する。 */
export const COOLDOWN_MS = 2000;

/** 購読する件数。Rules の request.query.limit の上限と一致させる。 */
export const PAGE = 50;

export class PostError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind;    // 'too-long' | 'empty' | 'cooldown' | 'stopped' | 'denied' | 'offline'
    this.cause = cause;
  }
}

/** イベント単位の操作。運営者の画面が使う。 */
export function createEventBus(sdk, { db, uid }) {
  const {
    collection, doc, query, where, orderBy, limit,
    onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp,
  } = sdk;

  return {
    /** 自分が作ったイベントを新しい順に購読する。 */
    watchMyEvents(onEvents, onError) {
      const q = query(collection(db, 'events'),
        where('ownerUid', '==', uid), orderBy('createdAt', 'desc'), limit(PAGE));
      return onSnapshot(q, (snap) => {
        onEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      }, onError);
    },

    createEvent(eventId, { name, heldOn = '' }) {
      return setDoc(doc(db, 'events', eventId), {
        name, heldOn, ownerUid: uid, createdAt: serverTimestamp(),
      });
    },

    watchEvent(eventId, onEvent, onError) {
      return onSnapshot(doc(db, 'events', eventId), (snap) => {
        onEvent(snap.exists() ? { id: snap.id, ...snap.data() } : null);
      }, onError);
    },

    renameEvent(eventId, { name, heldOn }) {
      return updateDoc(doc(db, 'events', eventId), { name, heldOn });
    },

    /** トラックを名前順に購読する。運営の表はこの順で並ぶ。 */
    watchTracks(eventId, onTracks, onError) {
      const q = query(collection(db, 'events', eventId, 'tracks'), orderBy('name'), limit(PAGE));
      return onSnapshot(q, (snap) => {
        onTracks(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      }, onError);
    },

    getTracksOnce(eventId) {
      return getDocs(query(collection(db, 'events', eventId, 'tracks'), orderBy('name'), limit(PAGE)));
    },

    /** トラックを足す。作れるのはイベントの owner だけ（Rules で縛っている）。 */
    createTrack(eventId, trackId, { name }) {
      return setDoc(doc(db, 'events', eventId, 'tracks', trackId), {
        name, stopped: false, live: false,
        sessionStartedAt: serverTimestamp(), createdAt: serverTimestamp(),
      });
    },

    /** 登壇者に渡すリンクの合言葉。置いた本人も読めない。 */
    setTrackHandoff(eventId, trackId, code) {
      return setDoc(doc(db, 'events', eventId, 'tracks', trackId, 'private', 'handoff'), { code });
    },

    setEventHandoff(eventId, code) {
      return setDoc(doc(db, 'events', eventId, 'private', 'handoff'), { code });
    },

    getEvent(eventId) { return getDoc(doc(db, 'events', eventId)); },
  };
}

/** トラック単位の操作。登壇者・観客・弾幕ページが使う。 */
export function createBus(sdk, { db, eventId, trackId, uid, now = () => Date.now() }) {
  const {
    collection, doc, query, where, orderBy, limit,
    onSnapshot, getDoc, setDoc, updateDoc, serverTimestamp, writeBatch,
  } = sdk;

  const trackRef = () => doc(db, 'events', eventId, 'tracks', trackId);
  const commentsRef = () => collection(db, 'events', eventId, 'tracks', trackId, 'comments');

  // Firestore はクールダウンも停止も permission-denied で返すので、
  // サーバの返事だけでは UI が理由を出せない。手元でも持っておく。
  let lastPostAt = -Infinity;
  let stopped = false;
  let live = false;
  // 一度も見ていない状態を「開始前」と決めつけない。
  // 購読していない使い方もあるので、見るまではサーバの判断に任せる。
  let observed = false;

  return {
    eventId, trackId,

    /** トラックの状態を購読する。stopped と sessionStartedAt の変化を拾う。 */
    watchTrack(onTrack, onError) {
      return onSnapshot(trackRef(), (snap) => {
        if (!snap.exists()) { onTrack(null); return; }
        const d = snap.data();
        stopped = d.stopped === true;
        live = d.live === true;
        observed = true;
        onTrack({
          id: snap.id,
          name: d.name,
          stopped,
          // 開始前 / 受付中 / 停止中 の3状態。演題の有無では判定できない。
          live: d.live === true,
          sessionStartedAt: d.sessionStartedAt ?? null,
        });
      }, onError);
    },

    /**
     * コメントを購読する。
     *
     * 最初のスナップショットは「いま溜まっている分」なので、第2引数で区別して返す。
     * 登壇中に再読み込みしたとき過去50件が一斉に流れると画面が埋まり、
     * いま来ているコメントが見えなくなる。流すかどうかは呼び出し側が決める。
     *
     * createdAt が null のものは飛ばす。サーバ時刻が確定していない自分の書き込みで、
     * 確定後に改めて届く。
     */
    watchComments(sessionStartedAt, onComment, onError) {
      const q = query(
        commentsRef(),
        where('createdAt', '>=', sessionStartedAt),
        orderBy('createdAt', 'desc'),
        limit(PAGE),
      );
      let first = true;
      return onSnapshot(q, (snap) => {
        const added = snap.docChanges()
          .filter((ch) => ch.type === 'added')
          .map((ch) => ({ id: ch.doc.id, ...ch.doc.data() }))
          .filter((c) => c.createdAt != null);

        // 最初の分だけは古い順に戻す（クエリは新しい順なので）
        if (first) added.reverse();
        for (const c of added) {
          onComment({ id: c.id, text: c.text, createdAt: c.createdAt }, { isBacklog: first });
        }
        first = false;
      }, onError);
    },

    /**
     * コメントを投稿する。
     *
     * コメントと posters/{uid} の2件バッチで書く。Rules が
     * getAfter() で同一バッチの posters 更新を要求しているので、この形以外は通らない。
     * posters 側に2秒のクールダウンがあり、片方が落ちればバッチ全体が落ちる。
     */
    async post(text) {
      const t = String(text ?? '').trim();
      if (t.length === 0) throw new PostError('empty');
      if (t.length > MAX_TEXT) throw new PostError('too-long');
      // 終了（live=false）と停止（stopped=true）はどちらでも送れないが、
      // 観客への言い方が変わる。終わったのか、止まっているだけなのか。
      if (observed && !live) throw new PostError('stopped');
      if (observed && stopped) throw new PostError('paused');
      if (this.cooldownRemaining() > 0) throw new PostError('cooldown');

      const b = writeBatch(db);
      b.set(doc(commentsRef()), { text: t, createdAt: serverTimestamp() });
      b.set(doc(db, 'events', eventId, 'tracks', trackId, 'posters', uid),
        { lastPostAt: serverTimestamp() });
      try {
        await b.commit();
        lastPostAt = now();
      } catch (e) {
        // サーバに弾かれたなら手元の時刻は進めない。次の投稿を無駄に待たせないため。
        throw new PostError(classify(e), e);
      }
    },

    /** 次に投稿できるまでの残り時間(ms)。UI がこれを出す。 */
    cooldownRemaining() {
      return Math.max(0, COOLDOWN_MS - (now() - lastPostAt));
    },

    get isStopped() { return stopped; },
    get isLive() { return live && !stopped; },
    get isObserved() { return observed; },

    // --- 登壇者の操作 ---------------------------------------------------

    /**
     * 登壇を開始する。
     *
     * ここが前の登壇との切れ目になる。trackId は変えないので QR を貼り替えなくていい。
     * 演題は持たない。切れ目を作るのに要らないし、更新し忘れという失敗だけが増える。
     */
    startSession() {
      return updateDoc(trackRef(), {
        sessionStartedAt: serverTimestamp(), stopped: false, live: true,
      });
    },

    /**
     * 登壇を終える。次の「開始」まで投稿は拒否される。
     * stopped は触らない。あれは運営の操作で、登壇者は戻せない。
     */
    endSession() {
      return updateDoc(trackRef(), { live: false });
    },

    /**
     * 荒らしへの最終手段。運営だけが触れる（Rules で縛っている）。
     * 運営が止めたものを登壇者が戻せてはいけない。
     */
    stop()   { return updateDoc(trackRef(), { stopped: true }); },
    resume() { return updateDoc(trackRef(), { stopped: false }); },

    /** 渡されたリンクの合言葉を示して、このトラックの登壇者になる。 */
    claim(code) {
      return setDoc(doc(db, 'events', eventId, 'tracks', trackId, 'operators', uid), { code });
    },

    getTrack() { return getDoc(trackRef()); },
  };
}

/** Firestore のエラーを UI が出し分けられる形にする。 */
function classify(e) {
  const code = e?.code ?? '';
  if (code === 'permission-denied') return 'denied';
  if (code === 'unavailable' || code === 'deadline-exceeded') return 'offline';
  return 'denied';
}
