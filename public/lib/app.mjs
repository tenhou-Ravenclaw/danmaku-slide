// ブラウザ側の起動まわり。Firebase の初期化と匿名サインイン。
//
// 観客にもサインインさせる。画面もクリックも増えないが、UID が手に入るので
// 「UID ごとのレート制限」を Security Rules だけで書けるようになる。
// 認証を要求しない設計では、防御は認証ではなく形の制約でやるしかない。
import * as sdk from '../vendor/firebase.js';
import { firebaseConfig } from '../firebase-config.js';
import { createBus } from './bus.mjs';

let started = null;

/**
 * 初期化して匿名サインインまで済ませる。何度呼んでも1回しか走らない。
 * @returns {Promise<{ uid: string, db: unknown }>}
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
    const { user } = await sdk.signInAnonymously(auth);
    return { uid: user.uid, db };
  })();
  return started;
}

/** 起動して、そのトラック用の bus を返す。 */
export async function connect(trackId) {
  const { uid, db } = await start();
  return createBus(sdk, { db, trackId, uid });
}

export { sdk };
