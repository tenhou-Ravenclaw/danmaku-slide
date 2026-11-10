// organizer.html の起動（運営コンソール本体）。外部モジュールにして、CSP の
// script-src を 'self' で縛れるようにする（#113）。入口のデモとは別に読む。
const msg = document.getElementById('msg');
const show = (m) => { msg.textContent = `エラー: ${m}`; msg.dataset.kind = 'bad'; };
addEventListener('error', (e) => show(e.message ?? e.error));
addEventListener('unhandledrejection', (e) => show(e.reason?.message ?? e.reason));
try {
  const { createOrganizer } = await import('./lib/organizer.mjs');
  window.__organizer = await createOrganizer({
    eventId: new URLSearchParams(location.search).get('e'),
    // `＋` から来たときは、いちばん近いイベントを開かない。
    // 開いてしまうと2本目以降を作りにいけなくなる。
    wantNew: new URLSearchParams(location.search).get('new') !== null,
    // 招待リンクから来たときの合言葉。入るかどうかを聞く面へ回す。
    joinCode: new URLSearchParams(location.search).get('join'),
  });
} catch (e) { show(e?.message ?? e); }
