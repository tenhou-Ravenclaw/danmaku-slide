// 拡張の content script 用。ページの CSP に縛られないよう、拡張側に束ねて持つ。
export { initializeApp } from 'firebase/app';
export { getAuth, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
export {
  initializeFirestore,
  collection, doc, query, where, orderBy, limit,
  onSnapshot, getDoc, setDoc, updateDoc,
  serverTimestamp, writeBatch, Timestamp,
  connectFirestoreEmulator,
} from 'firebase/firestore';
