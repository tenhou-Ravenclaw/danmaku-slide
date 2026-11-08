// ショートカットを受けて、発表中のタブに伝える。
// 発表中は全画面でツールバーが出ないので、アイコンからは状態を見られない。
chrome.runtime.onInstalled.addListener(() => {
  console.info('[弾幕スライド] 入った');
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-status') return;
  const isSlides = (u) => /\/presentation\/d\/[^/]+\//.test(u ?? '');
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isSlides(tab?.url)) {
    const found = (await chrome.tabs.query({})).filter((t) => isSlides(t.url));
    tab = found.find((t) => /\/present/.test(t.url)) ?? found[0] ?? null;
  }
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'danmaku:toggle' }).catch(() => {});
});
