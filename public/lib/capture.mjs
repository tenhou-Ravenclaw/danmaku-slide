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

/**
 * 取り込んだ映像から、実際に中身がある範囲を見つける。
 *
 * スライドショーを全画面にせずに取り込むと、スライドが黒帯に囲まれたまま入ってくる。
 * そこへこちらでさらに黒帯を足すと、二重に縁取られて小さく映る。
 * 縁の一様な部分を削って、中身だけを投影に使う。
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img 縮小した1フレーム
 * @param {number} tolerance 同じ色とみなす差（0-255）
 * @returns {{x:number, y:number, width:number, height:number}} img の座標系での範囲
 */
export function detectContentRect(img, tolerance = 10) {
  const { data, width: w, height: h } = img;
  const whole = { x: 0, y: 0, width: w, height: h };
  if (w < 4 || h < 4) return whole;

  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const near = (a, b) =>
    Math.abs(a[0] - b[0]) <= tolerance &&
    Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance;

  // 四隅が揃っていなければ、縁取りではないので触らない
  const c = at(0, 0);
  if (!near(c, at(w - 1, 0)) || !near(c, at(0, h - 1)) || !near(c, at(w - 1, h - 1))) return whole;

  const rowIsEdge = (y) => { for (let x = 0; x < w; x++) if (!near(c, at(x, y))) return false; return true; };
  const colIsEdge = (x) => { for (let y = 0; y < h; y++) if (!near(c, at(x, y))) return false; return true; };

  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < bottom && rowIsEdge(top)) top++;
  while (bottom > top && rowIsEdge(bottom)) bottom--;
  while (left < right && colIsEdge(left)) left++;
  while (right > left && colIsEdge(right)) right--;

  const rect = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };

  // 全面が一様（真っ暗なスライドなど）なら切らない。切ると何も映らなくなる。
  const ratio = (rect.width * rect.height) / (w * h);
  if (ratio < 0.15) return whole;
  // ほぼ全面なら、わずかな誤差で切らない
  if (ratio > 0.995) return whole;
  return rect;
}

/** 取り込んだものの種類。タブだと Chrome が共有バーをページ内に描き、それごと映る。 */
export function surfaceOf(stream) {
  return stream?.getVideoTracks?.()[0]?.getSettings?.().displaySurface ?? null;
}
