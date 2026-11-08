// ブラウザ側の起動まわり。Firebase の初期化と匿名サインイン。
//
// 観客にもサインインさせる。画面もクリックも増えないが、UID が手に入るので
// 「UID ごとのレート制限」を Security Rules だけで書けるようになる。
// 認証を要求しない設計では、防御は認証ではなく形の制約でやるしかない。
import * as sdk from '/vendor/entry.js';
import { firebaseConfig } from '/firebase-config.js';
import { createBus } from '/lib/bus.mjs';

let started = null;

/**
 * 初期化して匿名サインインまで済ませる。何度呼んでも1回しか走らない。
 * @returns {Promise<{ uid: string, db: unknown, sdk: unknown }>}
 */
export function start() {
  if (started) return started;
  started = (async () => {
    const app = sdk.initializeApp(firebaseConfig);

    // 会場のネットワークでは WebChannel が通らないことがある。
    // 自動検出に任せると、必要なときだけロングポーリングに落ちる。
    const db = sdk.initializeFirestore(app, {
      experimentalAutoDetectLongPolling: true,
    });

    const auth = sdk.getAuth(app);

    // ?emu=1 のときだけエミュレータへ向ける。localhost を自動判定にすると、
    // 手元から本番を触って確かめることができなくなる。
    if (isEmulator()) {
      sdk.connectFirestoreEmulator(db, '127.0.0.1', 8181);
      sdk.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    }

    const { user } = await sdk.signInAnonymously(auth);
    return { uid: user.uid, db, sdk };
  })();
  return started;
}

/**
 * 運営として入る。匿名ではなく本人確認できる形でサインインする。
 *
 * イベントとトラックは当日まで残るものなので、端末を変えたら失う匿名のままでは
 * 運用に耐えない。Rules 側でも匿名の作成・削除を拒んでいる。
 *
 * @returns {Promise<{ uid, db, sdk, user } | null>} まだ入っていなければ null
 */
let organizerStarted = null;
export function startOrganizer() {
  if (organizerStarted) return organizerStarted;
  organizerStarted = (async () => {
    const app = sdk.initializeApp(firebaseConfig, 'organizer');
    const db = sdk.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
    const auth = sdk.getAuth(app);
    if (isEmulator()) {
      sdk.connectFirestoreEmulator(db, '127.0.0.1', 8181);
      sdk.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    }
    return { db, sdk, auth };
  })();
  return organizerStarted;
}

/** いま入っている人を見張る。入っていなければ null が来る。 */
export async function watchOrganizer(onUser) {
  const { auth, db } = await startOrganizer();
  return sdk.onAuthStateChanged(auth, (user) => {
    onUser(user ? { uid: user.uid, name: user.displayName ?? user.email ?? '運営', db, sdk } : null);
  });
}

/** 運営として入る。本番は Google、エミュレータでは確認用の口を使う。 */
export async function signInOrganizer() {
  const { auth } = await startOrganizer();
  if (isEmulator()) {
    // エミュレータには Google の本物の口が無い。検証のための入口。
    // ?emu=1 はローカルのエミュレータにしか向かないので、本番には存在しない。
    // 毎回新しいアカウントを作る。既存を探しに行くと 400 が出て、
    // 本物の不具合と区別がつかなくなる。2回目以降はセッションが復元されるので
    // ここには来ない。
    const email = `organizer-${Math.random().toString(36).slice(2)}@example.test`;
    return sdk.createUserWithEmailAndPassword(auth, email, 'organizer-pass');
  }
  return sdk.signInWithPopup(auth, new sdk.GoogleAuthProvider());
}

export async function signOutOrganizer() {
  const { auth } = await startOrganizer();
  return sdk.signOut(auth);
}

function isEmulator() {
  return new URLSearchParams(location.search).get('emu') === '1';
}

/** 起動して、そのトラック用の bus を返す。 */
export async function connect(eventId, trackId) {
  const { uid, db } = await start();
  return createBus(sdk, { db, eventId, trackId, uid });
}

export { sdk };
