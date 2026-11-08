// ブラウザへ配る Firebase SDK の入口。
//
// gstatic などの外部 CDN から読ませない。会場のネットワークが逼迫している前提なので、
// 初回ロードで外部ホストに依存したくない。ここを esbuild で束ねて同一オリジンから配る。
// 版も package-lock.json で固定されるので、テストした版がそのまま出る。
export { initializeApp } from 'firebase/app';
export { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
export {
  initializeFirestore,
  collection, doc, query, where, orderBy, limit,
  onSnapshot, getDoc, setDoc, updateDoc,
  serverTimestamp, writeBatch, Timestamp,
} from 'firebase/firestore';
