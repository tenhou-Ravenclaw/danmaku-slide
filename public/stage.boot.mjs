// stage.html の起動。外部モジュールにして、CSP の script-src を 'self' で縛れる
// ようにする（インラインだと 'unsafe-inline' が要り、XSS の面が開く）。#113
const stateText = document.getElementById('stateText');
const statebox = document.getElementById('statebox');
const show = (m) => { stateText.textContent = `エラー: ${m}`; statebox.dataset.kind = 'error'; };
addEventListener('error', (e) => show(e.message ?? e.error));
addEventListener('unhandledrejection', (e) => show(e.reason?.message ?? e.reason));
try {
  const q = new URLSearchParams(location.search);
  const { createStage } = await import('./lib/stage.mjs');
  window.__stage = await createStage({
    eventId: q.get('e'), trackId: q.get('t'),
  });
} catch (e) { show(e?.message ?? e); }
