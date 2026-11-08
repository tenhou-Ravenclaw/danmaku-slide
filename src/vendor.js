// ブラウザへ配る外部ライブラリの入口。
//
// gstatic などの外部 CDN から読ませない。会場のネットワークが逼迫している前提なので、
// 初回ロードで外部ホストに依存したくない。ここを esbuild で束ねて同一オリジンから配る。
// 版も package-lock.json で固定されるので、テストした版がそのまま出る。
export { initializeApp } from 'firebase/app';
export { getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator } from 'firebase/auth';
export {
  initializeFirestore,
  collection, doc, query, where, orderBy, limit,
  onSnapshot, getDoc, setDoc, updateDoc,
  serverTimestamp, writeBatch, Timestamp,
  connectFirestoreEmulator,
} from 'firebase/firestore';

// QR は自前実装せず実績のあるものを束ねる。esbuild を通すので、
// 外部 CDN に依存しない性質は Firebase SDK と同じ。
export { default as QRCode } from 'qrcode';
