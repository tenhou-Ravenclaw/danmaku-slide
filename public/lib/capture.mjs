// 画面キャプチャ（貼り方B）。スライドを弾幕の下に敷く。
//
// これがあるとインストールもターミナルも要らない。登壇者がブラウザだけで
// スライドに弾幕を重ねられる。透過シェル（貼り方C）はこの上の選択肢。

export class CaptureError extends Error {
  constructor(kind, cause) { super(kind); this.kind = kind; this.cause = cause; }
}

/** ブラウザがキャプチャに対応しているか。 */
export function isSupported() {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getDisplayMedia;
}

/**
 * スライドを選んでもらう。
 *
 * selfBrowserSurface: 'exclude' で自分自身を候補から外す。
 * これが無いと弾幕ページ自身を選べてしまい、鏡の無限ループになる。
 */
export async function pickSlide() {
  if (!isSupported()) throw new CaptureError('unsupported');
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',   // 途中で別のウィンドウに切り替えられる
    });
  } catch (e) {
    // 選択画面を閉じただけ。失敗として騒がない。
    if (e?.name === 'NotAllowedError') throw new CaptureError('cancelled', e);
    if (e?.name === 'NotFoundError') throw new CaptureError('none', e);
    throw new CaptureError('failed', e);
  }
}

/**
 * 取り込んだ映像を <video> に繋ぐ。描画のたびにこの video を読む。
 * @returns {Promise<HTMLVideoElement>}
 */
export async function attach(stream, video) {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return video;
}

/**
 * 取り込んだ映像を、はみ出さず・歪まないように収める位置を出す。
 * スライドは 16:9 とは限らず、画面も 16:9 とは限らない。
 */
export function fitRect(srcW, srcH, dstW, dstH) {
  if (!srcW || !srcH || !dstW || !dstH) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return { x: (dstW - width) / 2, y: (dstH - height) / 2, width, height };
}

/** 映像が終わったとき（共有を止めたとき）に知らせる。 */
export function onEnded(stream, fn) {
  for (const track of stream.getVideoTracks()) track.addEventListener('ended', fn);
}

export function stop(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
