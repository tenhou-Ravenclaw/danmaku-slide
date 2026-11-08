// Firestore との境界。描画も DOM も持たない。
//
// SDK を import せず引数で受け取る。ブラウザは同一オリジンに束ねた
// public/vendor/firebase.js を渡し、テストは npm の firebase/firestore を渡す。
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

export function createBus(sdk, { db, trackId, uid, now = () => Date.now() }) {
  const {
    collection, doc, query, where, orderBy, limit,
    onSnapshot, getDoc, setDoc, updateDoc, serverTimestamp, writeBatch,
  } = sdk;

  const trackRef = () => doc(db, 'tracks', trackId);
  const commentsRef = () => collection(db, 'tracks', trackId, 'comments');

  // Firestore はクールダウンも停止も permission-denied で返すので、
  // サーバの返事だけでは UI が理由を出せない。手元でも持っておく。
  let lastPostAt = -Infinity;
  let stopped = false;

  return {
    trackId,

    /** トラックの状態を購読する。stopped と sessionStartedAt の変化を拾う。 */
    watchTrack(onTrack, onError) {
      return onSnapshot(trackRef(), (snap) => {
        if (!snap.exists()) { onTrack(null); return; }
        const d = snap.data();
        stopped = d.stopped === true;
        onTrack({
          name: d.name,
          title: d.title ?? '',
          speaker: d.speaker ?? '',
          stopped: d.stopped === true,
          sessionStartedAt: d.sessionStartedAt ?? null,
          ownerUid: d.ownerUid,
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
      if (stopped) throw new PostError('stopped');
      if (this.cooldownRemaining() > 0) throw new PostError('cooldown');

      const b = writeBatch(db);
      b.set(doc(commentsRef()), { text: t, createdAt: serverTimestamp() });
      b.set(doc(db, 'tracks', trackId, 'posters', uid), { lastPostAt: serverTimestamp() });
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

    // --- 登壇者・スタッフの操作 -----------------------------------------

    /** トラックを作る。作った人が ownerUid になる。 */
    async createTrack({ name, title = '', speaker = '' }) {
      await setDoc(trackRef(), {
        name, title, speaker,
        stopped: false,
        sessionStartedAt: serverTimestamp(),
        ownerUid: uid,
        createdAt: serverTimestamp(),
      });
    },

    /** 登壇を開始する。trackId は変えないので QR を貼り替えなくていい。 */
    startSession({ title = '', speaker = '' } = {}) {
      return updateDoc(trackRef(), {
        sessionStartedAt: serverTimestamp(), stopped: false, title, speaker,
      });
    },

    /** 荒らしへの最終手段。これ以降の投稿は Rules が拒否する。 */
    stop()   { return updateDoc(trackRef(), { stopped: true }); },
    resume() { return updateDoc(trackRef(), { stopped: false }); },

    /** 引き継ぎコードを置く。置いた本人も読めない。 */
    setHandoffCode(code) {
      return setDoc(doc(db, 'tracks', trackId, 'private', 'handoff'), { code });
    },

    /** 引き継ぎコードを示して運用者になる。 */
    claimOperator(code) {
      return setDoc(doc(db, 'tracks', trackId, 'operators', uid), { code });
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
