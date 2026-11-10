// tracks.html の起動。外部モジュールにして、CSP の script-src を 'self' で縛れる
// ようにする（インラインだと 'unsafe-inline' が要り、XSS の面が開く）。#113
//
// このページは /e/<id> からも配信される（rewrite）。だから読み込みは絶対パスで
// 指す。相対だと /e/ の下では /e/tracks.boot.mjs を探しに行く。import も同じ理由で絶対。
const note = document.getElementById('note');
const show = (m) => { note.textContent = `エラー: ${m}`; note.dataset.kind = 'bad'; };
addEventListener('error', (e) => show(e.message ?? e.error));
addEventListener('unhandledrejection', (e) => show(e.reason?.message ?? e.reason));
try {
  const q = new URLSearchParams(location.search);
  // /e/<id> から rewrite で来る。直接 ?e= でも開ける。
  const fromPath = location.pathname.match(/^\/e\/([^/]+)\/?$/)?.[1];
  const { createPicker } = await import('/lib/picker.mjs');
  window.__picker = await createPicker({ eventId: q.get('e') ?? fromPath });
} catch (e) { show(e?.message ?? e); }
