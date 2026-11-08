// Document Picture-in-Picture で弾幕を浮かせる。
//
// ブラウザには最前面も透過も API が無いが、PiP の窓だけは OS が最前面に浮かせる。
// 透過はできないので「全面に重なる」ことは諦め、帯として出す。
// その代わり、スライドツールを選ばず、何もインストールしない。

export function isSupported() {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

/**
 * canvas を PiP の窓へ移す。閉じられたら元の場所へ戻す。
 * @returns {Promise<{window: Window, close: () => void}>}
 */
export async function float(canvas, { height = 160, onClose } = {}) {
  if (!isSupported()) throw new Error('このブラウザは対応していない（Chrome か Edge で開く）');

  const home = canvas.parentElement;
  const next = canvas.nextSibling;
  const win = await window.documentPictureInPicture.requestWindow({
    width: Math.round(window.screen.width * 0.6),
    height,
    disallowReturnToOpener: true,
  });

  const style = win.document.createElement('style');
  style.textContent = `
    html, body { margin: 0; height: 100%; overflow: hidden; background: #0b0b0f; }
    canvas { display: block; width: 100%; height: 100%; }
  `;
  win.document.head.append(style);
  win.document.body.append(canvas);

  const restore = () => {
    if (next) home.insertBefore(canvas, next); else home.append(canvas);
    onClose?.();
  };
  win.addEventListener('pagehide', restore);

  return { window: win, close: () => win.close() };
}
