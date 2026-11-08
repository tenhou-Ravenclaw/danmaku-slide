// 全画面にする先を選ぶ。拡張ディスプレイに投影しているときに要る。
//
// Window Management API が使えれば投影先を名指しで選べる。使えなければ
// 今いる画面で全画面にするしかないので、その旨を呼び出し側に返す。

export function isSupported() {
  return typeof window !== 'undefined' && 'getScreenDetails' in window;
}

/**
 * 画面の一覧を取る。許可が要るので、押されたときに呼ぶ。
 * @returns {Promise<{screens: Array, details: object|null, reason: string|null}>}
 */
export async function listScreens() {
  if (!isSupported()) return { screens: [], details: null, reason: 'unsupported' };
  try {
    const details = await window.getScreenDetails();
    return {
      details,
      screens: details.screens.map((s, i) => ({
        index: i,
        label: `${i + 1}: ${s.width}×${s.height}${s.isPrimary ? '（メイン）' : ''}${s.isInternal ? '・内蔵' : ''}`,
        raw: s,
      })),
      reason: null,
    };
  } catch (e) {
    // 許可されなかった。今いる画面で全画面にするしかない。
    return { screens: [], details: null, reason: e?.name === 'NotAllowedError' ? 'denied' : 'failed' };
  }
}

/**
 * 全画面にする。screen を渡せばその画面で開く。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function goFullscreen(element, screen = null) {
  try {
    await element.requestFullscreen(screen ? { screen } : undefined);
    return { ok: true };
  } catch (e) {
    // 全画面はユーザー操作からしか呼べない。キーボードの focus が
    // キャプチャの選択画面から戻らないと、キーでは発火できない。
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

export function isFullscreen() {
  return typeof document !== 'undefined' && document.fullscreenElement !== null;
}

export function exitFullscreen() {
  if (isFullscreen()) return document.exitFullscreen();
  return Promise.resolve();
}
