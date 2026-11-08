// ブラウザ側の起動まわり。Firebase の初期化と匿名サインイン。
//
// 観客にもサインインさせる。画面もクリックも増えないが、UID が手に入るので
// 「UID ごとのレート制限」を Security Rules だけで書けるようになる。
// 認証を要求しない設計では、防御は認証ではなく形の制約でやるしかない。
import * as sdk from '../vendor/entry.js';
import { firebaseConfig } from '../firebase-config.js';
import { createBus } from './bus.mjs';

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
    if (new URLSearchParams(location.search).get('emu') === '1') {
      sdk.connectFirestoreEmulator(db, '127.0.0.1', 8181);
      sdk.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    }

    const { user } = await sdk.signInAnonymously(auth);
    return { uid: user.uid, db, sdk };
  })();
  return started;
}

/** 起動して、そのトラック用の bus を返す。 */
export async function connect(eventId, trackId) {
  const { uid, db } = await start();
  return createBus(sdk, { db, eventId, trackId, uid });
}

export { sdk };
