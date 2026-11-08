// トラックの指定と、いまどうなっているかの診断。
//
// 「流れない」とき、原因は拡張・ページ・トラックのどれかにある。
// 画面の隅のバッジは数秒で消えるので、いつでも押して調べられる口をここに置く。
const el = (id) => document.getElementById(id);

// どのビルドが入っているかを最初に出す。
// 「作り直したつもりで古いものを見ている」のがいちばん切り分けづらい。
{
  const m = chrome.runtime.getManifest();
  el('ver').textContent = `版 ${m.version_name ?? m.version}`;
}
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

function verdict(kind, text, fix = '') {
  el('verdict').dataset.kind = kind;
  el('verdictText').textContent = text;
  el('fix').textContent = fix;
}

function detail(obj) {
  const dl = el('detail');
  dl.innerHTML = '';
  const rows = {
    トラック: obj.track ? `${obj.track}（${obj.trackId}）` : obj.trackId,
    受付: obj.stopped == null ? null : (obj.stopped ? '止めている' : '受付中'),
    受け取った数: obj.received,
    流れている数: obj.active,
    行数: obj.lanes,
    大きさ: obj.size,
    置き場所: obj.parent,
    全画面: obj.fullscreen ?? 'なし',
    ページ側の版: obj.builtAt,
  };
  for (const [k, v] of Object.entries(rows)) {
    if (v === null || v === undefined) continue;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  }
  dl.hidden = false;
}

/** いまのタブに content script が生きているか聞く。 */
async function check() {
  el('detail').hidden = true;
  verdict('', '調べています…');

  const isSlides = (u) => /\/presentation\/d\/[^/]+\//.test(u ?? '');

  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isSlides(tab?.url)) {
    // 別の窓でスライドを開いていることがある。探しに行く。
    const found = (await chrome.tabs.query({})).filter((t) => isSlides(t.url));
    tab = found.find((t) => /\/present/.test(t.url)) ?? found[0] ?? null;
  }
  if (!tab) {
    verdict('warn', 'Google スライドのタブが見つかりません',
      'スライドを開いてから、もう一度押してください');
    return;
  }

  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'danmaku:report' });
  } catch {
    verdict('bad', '拡張がこのページに入っていません',
      'chrome://extensions で更新（↻）を押してから、ページを再読み込みしてください');
    return;
  }

  if (!res?.presenting) {
    verdict('warn', '発表モードではありません',
      '「スライドショー」を開始してください（URL が /present になります）');
    detail(res ?? {});
    return;
  }
  if (res.reason === 'トラックが未設定') {
    verdict('bad', 'トラックが未設定です', '上の欄にIDかURLを入れて保存してください');
    detail(res);
    return;
  }
  if (!res.track) {
    verdict('bad', `トラックが見つかりません（${res.trackId}）`,
      'IDが合っているか確かめてください');
    detail(res);
    return;
  }
  if (!res.connected) {
    verdict('bad', '弾幕を置けていません',
      'ページが全画面の中に入れない形かもしれません。ページを再読み込みしてください');
    detail(res);
    return;
  }
  if (res.stopped) {
    verdict('warn', '投稿が止められています', '登壇者コンソールで「投稿を再開する」を押してください');
    detail(res);
    return;
  }
  verdict('ok', res.received > 0 ? `動いています（${res.received}件 受け取り）` : '動いています',
    res.received === 0 ? 'まだ投稿が届いていません。投稿ページから送ってみてください' : '');
  detail(res);
}

chrome.storage.local.get('trackId').then(({ trackId }) => {
  if (trackId) el('track').value = trackId;
  el('track').focus();
  check();
});

async function save() {
  const id = parseTrackId(el('track').value);
  if (!id) { msg('トラックIDかURLを入れる', 'bad'); return; }
  await chrome.storage.local.set({ trackId: id });
  msg(`${id} に重ねます`, 'ok');
  const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/presentation/*' });
  for (const t of tabs) if (/\/present/.test(t.url ?? '')) chrome.tabs.reload(t.id);
  setTimeout(check, 2500);
}

el('save').addEventListener('click', save);
el('track').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
el('recheck').addEventListener('click', check);
