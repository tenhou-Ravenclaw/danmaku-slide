// 弾幕の配置ロジック。描画は持たない。
//
// 時刻は必ず引数で受け取る。内部で Date.now() を呼ばないこと。
// 呼ぶとテストから時間を動かせなくなり、行の衝突や待ち時間の検証ができなくなる。

/** 既定値。流れる速さと行の形。 */
export const DEFAULTS = {
  speed: 180,      // px/秒。全コメント共通にすると追い越しが起きない
  gap: 24,         // 同じ行で前のコメントとの最小すき間(px)
  lineHeight: 52,  // 行の高さ(px)
  waitMs: 3000,    // 行が空くのを待つ上限(ms)。超えたら捨てる
  topMargin: 8,    // 上端の余白(px)
};

/**
 * 弾幕の流れを管理する。
 *
 * 行を「いつまで塞がっているか」の時刻で持つ。新しいコメントは、その時刻を
 * 過ぎている行にだけ入れられる。入れられなければ待機列に回し、waitMs を
 * 超えたら捨てる。捨てるのは、待たせ続けると登壇者の画面が過去のコメントで
 * 埋まり、いま来ているコメントが見えなくなるため。
 */
export class DanmakuFlow {
  constructor(options = {}) {
    const o = { ...DEFAULTS, ...options };
    this.speed = o.speed;
    this.gap = o.gap;
    this.lineHeight = o.lineHeight;
    this.waitMs = o.waitMs;
    this.topMargin = o.topMargin;

    this.width = 0;
    this.height = 0;
    this.laneCount = 0;
    this.lanes = [];      // lanes[i] = その行が空く時刻(ms)
    this.nextLane = 0;    // 次に試す行。上から詰めると上半分に固まる
    this.active = [];     // 流れているもの
    this.pending = [];    // 行が空くのを待っているもの
    this.seen = new Set();// 同じ id を二度流さない（Firestore は再配信する）
    this.dropped = 0;
  }

  /** 画面の大きさを設定する。行数が変わるので流れているものは作り直す。 */
  resize(width, height) {
    this.width = width;
    this.height = height;
    const usable = Math.max(0, height - this.topMargin);
    this.laneCount = Math.max(1, Math.floor(usable / this.lineHeight));
    this.lanes = new Array(this.laneCount).fill(0);
    this.nextLane = 0;
    this.active = [];
    this.pending = [];
  }

  /** 行の y 座標（文字の基準線ではなく行の上端）。 */
  laneY(lane) {
    return this.topMargin + lane * this.lineHeight;
  }

  /**
   * コメントを受け付ける。
   * @returns {'placed'|'queued'|'dup'} 流し始めたか、待たせたか、重複で捨てたか
   */
  add(comment, now) {
    if (this.seen.has(comment.id)) return 'dup';
    this.seen.add(comment.id);

    const item = {
      id: comment.id,
      text: comment.text,
      width: comment.width,
      queuedAt: now,
    };
    if (this.#place(item, now)) return 'placed';
    this.pending.push(item);
    return 'queued';
  }

  /**
   * 時刻を進める。流れ終わったものを外し、待機列を捌く。
   * @returns {Array} いま描くべきもの（x, y つき）
   */
  step(now) {
    this.#drain(now);
    this.active = this.active.filter((it) => this.#x(it, now) + it.width > 0);
    return this.active.map((it) => ({
      id: it.id,
      text: it.text,
      width: it.width,
      x: this.#x(it, now),
      y: this.laneY(it.lane),
      lane: it.lane,
    }));
  }

  /**
   * 流さずに「見た」ことにする。
   * 再読み込み時の溜まっていた分に使う。一斉に流すと画面が埋まって
   * いま来ているコメントが見えなくなるので、流さずに重複排除だけ登録する。
   */
  markSeen(id) { this.seen.add(id); }

  /** 登壇者が交代したとき。流れているものは消すが、seen は残す。 */
  resetFlow() {
    this.active = [];
    this.pending = [];
    this.lanes = new Array(this.laneCount).fill(0);
    this.nextLane = 0;
  }

  get pendingCount() { return this.pending.length; }
  get activeCount() { return this.active.length; }

  // --- 内部 -------------------------------------------------------------

  #x(item, now) {
    return this.width - ((now - item.startedAt) / 1000) * this.speed;
  }

  /** 空いている行を探して入れる。入れられなければ false。 */
  #place(item, now) {
    const lane = this.#pickLane(now);
    if (lane === -1) return false;
    item.lane = lane;
    item.startedAt = now;
    // この行は、末尾が左端に抜けきるまで塞がる。
    this.lanes[lane] = now + ((item.width + this.gap) / this.speed) * 1000;
    this.active.push(item);
    return true;
  }

  /**
   * 空いている行をラウンドロビンで選ぶ。
   * 毎回 0 から探すと、流量が少ないとき上の数行だけが使われて下が空く。
   */
  #pickLane(now) {
    for (let i = 0; i < this.laneCount; i++) {
      const lane = (this.nextLane + i) % this.laneCount;
      if (this.lanes[lane] <= now) {
        this.nextLane = (lane + 1) % this.laneCount;
        return lane;
      }
    }
    return -1;
  }

  /** 待機列を古い順に捌く。待ちすぎたものは捨てる。 */
  #drain(now) {
    if (this.pending.length === 0) return;
    const rest = [];
    for (const item of this.pending) {
      if (now - item.queuedAt > this.waitMs) {
        this.dropped++;
        continue;
      }
      if (!this.#place(item, now)) rest.push(item);
    }
    this.pending = rest;
  }
}
