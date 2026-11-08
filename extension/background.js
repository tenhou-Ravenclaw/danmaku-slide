// いまは何もしない。拡張としての取っ掛かりを持たせるためだけに置いている。
// 将来、投稿の中継やバッジ表示を足すならここ。
chrome.runtime.onInstalled.addListener(() => {
  console.info('[弾幕スライド] 入った');
});
