// overlay.html の起動。外部モジュールにして、CSP の script-src を 'self' で縛れる
// ようにする（#113）。読み込み自体が失敗したときも画面に出す。
// PoC では module が黙って死んで原因が分からなかった。
const hud = document.getElementById('hud');
const show = (m) => { hud.textContent = `エラー: ${m}`; hud.dataset.kind = 'error'; };
addEventListener('error', (e) => show(e.message ?? e.error));
addEventListener('unhandledrejection', (e) => show(e.reason?.message ?? e.reason));

// 客席から見えるものなので、端末の設定に関係なく暗いまま固定する
document.documentElement.classList.add('projected');
const q = new URLSearchParams(location.search);
if (q.get('transparent') === '1') document.documentElement.classList.add('transparent');
if (q.get('hud') === '0') document.documentElement.classList.add('no-hud');
if (q.get('bar') === '0') document.documentElement.classList.add('no-bar');

try {
  const { createOverlay } = await import('./lib/overlay.mjs');
  const { mountBar } = await import('./lib/overlay-bar.mjs');
  const overlay = createOverlay({
    canvas: document.getElementById('stage'),
    video: document.getElementById('slide'),
    hud,
    eventId: q.get('e'),
    trackId: q.get('t'),
    test: q.get('test') === '1',
  });
  window.__overlay = overlay;
  mountBar(overlay, { autoPick: q.get('capture') === '1' });

  // 登壇者のコントロール画面から開かれた場合
  if (q.get('stage') === '1') {
    document.documentElement.classList.add('no-bar');
    const cover = document.getElementById('cover');
    cover.hidden = false;
    cover.addEventListener('click', async () => {
      try { await document.documentElement.requestFullscreen(); } catch {}
      cover.hidden = true;
    });
    // 親に「受け取れる」と伝える。映像は親が取り込んだものをそのまま渡してもらう。
    window.opener?.__projectorReady?.(overlay, window);
  }
} catch (e) {
  show(e?.message ?? e);
}
