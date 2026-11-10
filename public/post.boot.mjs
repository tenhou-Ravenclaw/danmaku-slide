// post.html の起動。外部モジュールにして、CSP の script-src を 'self' で縛れる
// ようにする（インラインだと 'unsafe-inline' が要り、XSS の面が開く）。#113
const note = document.getElementById('note');
const show = (m) => { note.textContent = `エラー: ${m}`; note.dataset.kind = 'bad'; };
addEventListener('error', (e) => show(e.message ?? e.error));
addEventListener('unhandledrejection', (e) => show(e.reason?.message ?? e.reason));
try {
  const q = new URLSearchParams(location.search);
  const { createPoster } = await import('./lib/poster.mjs');
  window.__poster = await createPoster({ eventId: q.get('e'), trackId: q.get('t') });
} catch (e) { show(e?.message ?? e); }
