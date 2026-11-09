// 弾幕ページの操作バー。
//
// 投影に映るので、触っていないときは消す。登壇中にバーが出たままだと邪魔になる。
// 透過シェル（貼り方C）から開かれたときは、そもそも出さない。

export function mountBar(overlay, { autoPick = false } = {}) {
  const el = (id) => document.getElementById(id);
  const bar = el('bar');
  if (!bar || getComputedStyle(bar).display === 'none') return null;

  const msg = (text, kind = '') => { el('barMsg').textContent = text; el('barMsg').dataset.kind = kind; };

  // --- 出したり消したり -------------------------------------------------
  let hideTimer = 0;
  function showBar() {
    document.body.dataset.bar = 'show';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      // バーの中を触っているときは消さない
      if (!bar.matches(':hover') && !bar.contains(document.activeElement)) {
        document.body.dataset.bar = '';
      }
    }, 2600);
  }
  addEventListener('mousemove', (e) => { if (e.clientY < 140) showBar(); });
  addEventListener('keydown', showBar);
  bar.addEventListener('mouseenter', showBar);
  showBar();

  // --- スライドの取り込み -----------------------------------------------
  function reflectSlide(on) {
    document.body.dataset.slide = on ? '1' : '';
    el('pick').textContent = on ? 'スライドを選び直す' : 'スライドを選ぶ';
    el('pick').classList.toggle('primary', !on);
    el('drop').hidden = !on;
  }
  overlay.onCaptureChange(reflectSlide);

  el('pick').addEventListener('click', async () => {
    el('pick').disabled = true;
    msg('');
    const r = await overlay.pickSlide();
    el('pick').disabled = false;
    if (!r.ok) msg(r.reason, r.reason.includes('もう一度') ? '' : 'bad');
    else msg('');
  });

  el('drop').addEventListener('click', () => { overlay.dropSlide(); msg(''); });

  // --- 全画面 -----------------------------------------------------------
  // キーボードの focus がキャプチャの選択画面から戻らないことがあるので、
  // キーではなくボタンで出す。押した理由がユーザー操作として伝わる必要がある。
  let picked = null;
  const sel = el('screen');

  (async () => {
    if (!overlay.screens.isSupported()) return;
    const { screens } = await overlay.screens.listScreens().catch(() => ({ screens: [] }));
    if (screens.length < 2) return;   // 1枚しかないなら選ばせる意味がない
    sel.hidden = false;
    for (const s of screens) {
      const o = document.createElement('option');
      o.value = String(s.index); o.textContent = s.label;
      sel.append(o);
    }
    picked = screens;
  })();

  el('full').addEventListener('click', async () => {
    if (overlay.screens.isFullscreen()) {
      await overlay.screens.exitFullscreen();
      el('full').textContent = '全画面にする';
      return;
    }
    const target = picked?.[Number(sel.value)]?.raw ?? null;
    const r = await overlay.screens.goFullscreen(document.documentElement, target);
    if (!r.ok) msg(`全画面にできない: ${r.reason}`, 'bad');
    else { el('full').textContent = '全画面をやめる'; msg(''); }
  });

  document.addEventListener('fullscreenchange', () => {
    el('full').textContent = overlay.screens.isFullscreen() ? '全画面をやめる' : '全画面にする';
    showBar();
  });

  // コンソールから「スライドに流す」で来たときは、選択画面まで一気に出す
  if (autoPick) el('pick').click();

  return { showBar };
}
