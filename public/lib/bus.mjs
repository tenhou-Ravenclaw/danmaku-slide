// Firestore との境界。描画も DOM も持たない。
//
// 並び順だけは例外で、ここで決める。運営の表と観客のトラック選択が
// 別々に並べ替えると、両者が違う順で同じものを見ることになる。
//
// SDK を import せず引数で受け取る。ブラウザは同一オリジンに束ねた
// public/vendor/entry.js を渡し、テストは npm の firebase/firestore を渡す。
// こうしないと、ブラウザ向けバンドルを Node から読むことになってテストが書けない。

/** Rules 側と同じ上限。UI でも同じ値を使う。 */
import { compareTrackName } from './ids.mjs';

export const MAX_TEXT = 60;

/** Rules 側のクールダウン。UI で待ち時間を出すために公開する。 */
export const COOLDOWN_MS = 2000;

/** 購読する件数。Rules の request.query.limit の上限と一致させる。 */
export const PAGE = 50;

/**
 * 画面に出す並び。自分で付けた名前が先、既定の「Track A」は後。
 *
 * 元の配列は壊さない。購読の中身をそのまま渡してくる呼び出しがある。
 */
const sortTracks = (rows) => [...rows].sort((a, b) => compareTrackName(a.name, b.name));

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

    /**
     * 自分が関わっているイベントを購読する。作ったものと、手伝っているもの。
     *
     * Firestore は「作った or 手伝っている」を1回の問い合わせで引けない。
     * 作ったぶんは events を ownerUid で引き、手伝っているぶんは
     * users/{uid}/joined の控えから1件ずつ引いて合流させる。
     *
     * operators を直接引く道は採らない。あれは allow read: if false なので、
     * 引けるようにすると引き継ぎコードの漏れ口になる。
     */
    watchVisibleEvents(onEvents, onError) {
      const mine = new Map();     // 作ったもの
      const joined = new Map();   // 手伝っているもの
      const stops = new Map();    // eventId → そのイベントの購読を止める関数
      let ready = false;          // 作ったぶんが一度届くまで、合流を出さない

      const emit = () => {
        if (!ready) return;
        // 同じイベントが両方に入ることはないが、入っても作った側を優先する。
        const all = new Map([...joined, ...mine]);
        onEvents([...all.values()]);
      };

      const stopMine = onSnapshot(
        query(collection(db, 'events'),
          where('ownerUid', '==', uid), orderBy('createdAt', 'desc'), limit(PAGE)),
        (snap) => {
          mine.clear();
          for (const d of snap.docs) mine.set(d.id, { id: d.id, ...d.data(), mine: true });
          ready = true;
          emit();
        }, onError);

      const stopJoined = onSnapshot(
        query(collection(db, 'users', uid, 'joined'), limit(PAGE)),
        (snap) => {
          const want = new Set(snap.docs.map((d) => d.id));
          for (const [id, stop] of stops) {
            if (want.has(id)) continue;
            stop(); stops.delete(id); joined.delete(id);
          }
          for (const id of want) {
            if (stops.has(id)) continue;
            // 控えは名前を持たない。持たせると、作った人が直したときに古いまま残る。
            stops.set(id, onSnapshot(doc(db, 'events', id), (d) => {
              if (d.exists()) joined.set(id, { id: d.id, ...d.data(), mine: false });
              // 消えたイベントは出さない。控えだけが残ることがある。
              else joined.delete(id);
              emit();
            }, onError));
          }
          emit();
        }, onError);

      return () => {
        stopMine?.(); stopJoined?.();
        for (const stop of stops.values()) stop();
        stops.clear();
      };
    },

    /**
     * 招待コードを作り直して返す。
     *
     * コードは allow read: if false で、作った人でさえ読み出せない。
     * 配るには新しく発行するしかなく、そのぶん前に配ったリンクは通らなくなる。
     * 取り消しが副産物として手に入る。
     */
    async rotateHandoff(eventId, code) {
      await setDoc(doc(db, 'events', eventId, 'private', 'handoff'), { code });
      return code;
    },

    /**
     * そのイベントを手伝う側に回る。
     *
     * operators は自分の分しか作れない（Rules が uid を見ている）。
     * コードが違えば、ここで弾かれる。
     * 控えは operators が通ってから置く。順を逆にすると、入れていないのに
     * 一覧に出るイベントができる。
     */
    async joinEvent(eventId, code) {
      await setDoc(doc(db, 'events', eventId, 'operators', uid), { code });
      await setDoc(doc(db, 'users', uid, 'joined', eventId), { at: serverTimestamp() });
    },

    /** 手伝うのをやめる。自分の分だけ消せる。 */
    async leaveEvent(eventId) {
      await deleteDoc(doc(db, 'users', uid, 'joined', eventId));
      await deleteDoc(doc(db, 'events', eventId, 'operators', uid));
    },

    createEvent(eventId, { name, heldOn = '' }) {
      return setDoc(doc(db, 'events', eventId), {
        name, heldOn, ownerUid: uid, createdAt: serverTimestamp(),
      });
    },

    /**
     * イベント1件を購読する。
     *
     * 「無い」と言えるのはサーバーが無いと言ったときだけ。
     * 冷えた状態で開くと、最初にキャッシュ由来の空スナップショットが届く。
     * それをそのまま渡すと、配ったリンクを初めて開いた人に
     * 「イベントが見つからない」が一瞬出る。存在するイベントなのに。
     */
    watchEvent(eventId, onEvent, onError) {
      return onSnapshot(doc(db, 'events', eventId), (snap) => {
        if (!snap.exists() && snap.metadata.fromCache) return;
        onEvent(snap.exists() ? { id: snap.id, ...snap.data() } : null);
      }, onError);
    },

    renameEvent(eventId, { name, heldOn }) {
      return updateDoc(doc(db, 'events', eventId), { name, heldOn });
    },

    /** トラックを名前順に購読する。運営の表はこの順で並ぶ。 */
    /**
     * トラックを並べて購読する。
     *
     * Firestore には名前順で取らせ、手元で並べ替える。
     * 自分で付けた名前が先、既定の「Track A」は後。Rules は件数しか見ていないので、
     * 問い合わせ側の `orderBy` は変えない（50件の切り取り方を変えないため）。
     */
    watchTracks(eventId, onTracks, onError) {
      const q = query(collection(db, 'events', eventId, 'tracks'), orderBy('name'), limit(PAGE));
      return onSnapshot(q, (snap) => {
        onTracks(sortTracks(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
      }, onError);
    },

    // 取ってきたものをそのまま返す（並べ替えない）。画面には出ない経路で、
    // 呼び出し側は件数と有無しか見ていない。
    getTracksOnce(eventId) {
      return getDocs(query(collection(db, 'events', eventId, 'tracks'), orderBy('name'), limit(PAGE)));
    },

    /**
     * トラックを足す。作れるのはイベントの owner だけ（Rules で縛っている）。
     *
     * 受付中で作る。
     *
     * 止めた状態で作ると、運営が開け忘れたときに本番中に観客が投稿できない。
     * いちばん困るときに、いちばん気づきにくい形で壊れる。
     * 開催前に誰かが投げ込んでも紛れ込むのは数件で、運営は「止める」で閉じられる。
     * 失敗の重さが釣り合わないので、動いている側を既定にする。
     */
    createTrack(eventId, trackId, { name }) {
      return setDoc(doc(db, 'events', eventId, 'tracks', trackId), {
        name, stopped: false, createdAt: serverTimestamp(),
      });
    },

    /**
     * 名前を直す。trackId は触らない。
     *
     * 打ち間違えたときに消して作り直させると、配り直しが要る。名前だけ直せば、
     * 配るQRとリンクは trackId で出来ているのでそのまま生きる。
     * 刷った紙に載った名前だけは古いまま残るので、刷り直すかは運営が決める。
     */
    renameTrack(eventId, trackId, { name }) {
      return updateDoc(doc(db, 'events', eventId, 'tracks', trackId), { name });
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
    collection, doc, query, orderBy, limit,
    onSnapshot, getDoc, setDoc, updateDoc, serverTimestamp, writeBatch,
  } = sdk;

  const trackRef = () => doc(db, 'events', eventId, 'tracks', trackId);
  const commentsRef = () => collection(db, 'events', eventId, 'tracks', trackId, 'comments');

  // Firestore はクールダウンも停止も permission-denied で返すので、
  // サーバの返事だけでは UI が理由を出せない。手元でも持っておく。
  let lastPostAt = -Infinity;
  let stopped = false;
  // 一度も見ていない状態を「止まっている」と決めつけない。
  // 購読しない使い方もあるので、見るまではサーバの判断に任せる。
  let observed = false;

  return {
    eventId, trackId,

    /** トラックの状態を購読する。見るのは受付の可否だけ。 */
    watchTrack(onTrack, onError) {
      return onSnapshot(trackRef(), (snap) => {
        if (!snap.exists()) { onTrack(null); return; }
        const d = snap.data();
        stopped = d.stopped === true;
        observed = true;
        onTrack({ id: snap.id, name: d.name, stopped });
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
    watchComments(onComment, onError) {
      const q = query(commentsRef(), orderBy('createdAt', 'desc'), limit(PAGE));
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
      if (observed && stopped) throw new PostError('stopped');
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
    get isObserved() { return observed; },

    // --- 運営の操作 -----------------------------------------------------

    /**
     * 受付を開ける／止める。運営だけが触れる（Rules で縛っている）。
     *
     * 登壇の開始と終了はこの道具の仕事ではない。進行はイベントのタイムテーブルが
     * 持っているもので、ここに置くと二重管理になるし、押し忘れだけが増える。
     */
    open()  { return updateDoc(trackRef(), { stopped: false }); },
    close() { return updateDoc(trackRef(), { stopped: true }); },

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
