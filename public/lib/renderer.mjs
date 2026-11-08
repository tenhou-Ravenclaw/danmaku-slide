// Canvas への描画。配置は DanmakuFlow が決めるので、ここは描くだけ。
//
// DOM は作らない。コメント本文を DOM に入れないことが、そのまま XSS 対策になる。
// fillText は文字列を文字として扱うだけで、マークアップとして解釈しない。

export const STYLE = {
  font: '600 36px "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif',
  color: '#ffffff',
  strokeColor: 'rgba(0, 0, 0, 0.85)',
  strokeWidth: 5,
  baselineOffset: 40,   // 行の上端から文字の基準線までの距離(px)
};

export class Renderer {
  constructor(canvas, style = {}) {
    this.canvas = canvas;
    this.style = { ...STYLE, ...style };
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.widthCache = new Map();
  }

  /**
   * 画面サイズに合わせる。Retina でもぼけないよう実ピクセルで持つ。
   * @returns {{width: number, height: number}} CSS ピクセルでの大きさ
   */
  resize(cssWidth, cssHeight, dpr = 1) {
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.#applyContext();
    return { width: cssWidth, height: cssHeight };
  }

  /** 文字の幅を測る。同じ文面は測り直さない。 */
  measure(text) {
    const hit = this.widthCache.get(text);
    if (hit !== undefined) return hit;
    const w = Math.ceil(this.ctx.measureText(text).width);
    // 文面の種類は有限ではないので、際限なく溜めない
    if (this.widthCache.size > 500) this.widthCache.clear();
    this.widthCache.set(text, w);
    return w;
  }

  /**
   * 1フレーム描く。items は DanmakuFlow#step の戻り値。
   *
   * backdrop を渡すと、弾幕の下にそれを敷く（貼り方B のスライド）。
   * 下敷きは毎フレーム描き直す必要があるので、clearRect の直後に置く。
   */
  draw(items, backdrop = null) {
    const { ctx } = this;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.clearRect(0, 0, w, h);

    if (backdrop?.source && backdrop.width > 0 && backdrop.height > 0) {
      const c = backdrop.crop;
      if (c && c.width > 0 && c.height > 0) {
        // 取り込んだ枠の中から、中身のある範囲だけを切り出して敷く
        ctx.drawImage(backdrop.source, c.x, c.y, c.width, c.height,
          backdrop.x, backdrop.y, backdrop.width, backdrop.height);
      } else {
        ctx.drawImage(backdrop.source, backdrop.x, backdrop.y, backdrop.width, backdrop.height);
      }
    }

    for (const it of items) {
      const y = it.y + this.style.baselineOffset;
      ctx.strokeText(it.text, it.x, y);
      ctx.fillText(it.text, it.x, y);
    }
  }

  #applyContext() {
    const { ctx, style } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = style.font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = style.color;
    ctx.strokeStyle = style.strokeColor;
    ctx.lineWidth = style.strokeWidth;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    this.widthCache.clear();   // font が変われば幅も変わる
  }
}
