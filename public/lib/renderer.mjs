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

  /** 1フレーム描く。items は DanmakuFlow#step の戻り値。 */
  draw(items) {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
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
