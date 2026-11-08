// トラックの指定。URL をそのまま貼られても拾う。
const el = (id) => document.getElementById(id);
const msg = (t, k = '') => { el('msg').textContent = t; el('msg').dataset.kind = k; };

function parseTrackId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  try {
    const t = new URL(s).searchParams.get('track');
    if (t) return t;
  } catch { /* URL でなければ ID そのもの */ }
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

chrome.storage.local.get('trackId').then(({ trackId }) => {
  if (trackId) { el('track').value = trackId; msg(`${trackId} に重ねます`, 'ok'); }
  el('track').focus();
});

async function save() {
  const id = parseTrackId(el('track').value);
  if (!id) { msg('トラックIDかURLを入れる', 'bad'); return; }
  await chrome.storage.local.set({ trackId: id });
  msg(`${id} に重ねます`, 'ok');
  // 発表中のタブがあれば読み込み直して、すぐ効くようにする
  const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/presentation/*' });
  for (const t of tabs) if (/\/present/.test(t.url ?? '')) chrome.tabs.reload(t.id);
}

el('save').addEventListener('click', save);
el('track').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
