// ID と URL の組み立て。印刷して読み上げることがあるので、紛れる文字は使わない。

// 0/O、1/l/I のような紛れる文字を外す
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const UPPER = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function pick(set, n, random) {
  let s = '';
  for (let i = 0; i < n; i++) s += set[Math.floor(random() * set.length)];
  return s;
}

export function newEventId(random = () => Math.random()) { return pick(ALPHABET, 8, random); }
export function newTrackId(random = () => Math.random()) { return pick(ALPHABET, 6, random); }

/** 登壇者に渡すリンクの合言葉。口頭で伝えることがあるので大文字。 */
export function newHandoffCode(random = () => Math.random()) { return pick(UPPER, 8, random); }

/**
 * トラック名から ID の種を作る。Track A → a。
 * 読める ID のほうが運営が扱いやすいが、衝突しうるので使えないときは乱数に落とす。
 */
export function slugFromName(name) {
  const m = String(name ?? '').trim().match(/([A-Za-z0-9]+)\s*$/);
  if (!m) return null;
  const s = m[1].toLowerCase();
  return /^[23456789abcdefghjkmnpqrstuvwxyz]{1,12}$/.test(s) ? s : null;
}

export const postUrlFor = (eventId, trackId, origin = location.origin) =>
  `${origin}/post.html?e=${encodeURIComponent(eventId)}&t=${encodeURIComponent(trackId)}`;

export const stageUrlFor = (eventId, trackId, origin = location.origin) =>
  `${origin}/stage.html?e=${encodeURIComponent(eventId)}&t=${encodeURIComponent(trackId)}`;

export const overlayUrlFor = (eventId, trackId, origin = location.origin) =>
  `${origin}/overlay.html?e=${encodeURIComponent(eventId)}&t=${encodeURIComponent(trackId)}`;

/** チラシに載せる1本。観客はここからトラックを選ぶ。 */
export const eventUrlFor = (eventId, origin = location.origin) =>
  `${origin}/e/${encodeURIComponent(eventId)}`;

/** 末尾を省いて見せる。表の幅に収めるため。 */
export function shortUrl(url, keep = 34) {
  const s = String(url).replace(/^https?:\/\//, '');
  return s.length <= keep ? s : `…${s.slice(-keep)}`;
}

/** 相対時刻。登壇中に秒まで分かることが大事。 */
export function ago(ms, nowMs = Date.now()) {
  const d = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (d < 60) return `${d}秒前`;
  if (d < 3600) return `${Math.floor(d / 60)}分前`;
  if (d < 86400) return `${Math.floor(d / 3600)}時間前`;
  return `${Math.floor(d / 86400)}日前`;
}

/** 2026-12-12 → 2026/12/12（土） */
export function formatDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  const [, y, mo, d] = m;
  const wd = '日月火水木金土'[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()];
  return `${y}/${mo}/${d}（${wd}）`;
}

/**
 * 画面を移るときに、接続先を決めるクエリを引き継ぐ。
 *
 * 引き継がないと、移った先だけ別の環境に繋ぐことになる。
 * （前の画面はエミュレータ、次の画面は本番、という食い違いが実際に起きた）
 */
export function withEnv(url, search = (typeof location !== 'undefined' ? location.search : '')) {
  const here = new URLSearchParams(search);
  const u = new URL(url, typeof location !== 'undefined' ? location.href : 'https://example.test');
  for (const key of ['emu']) {
    const v = here.get(key);
    if (v !== null) u.searchParams.set(key, v);
  }
  return u.pathname + u.search + u.hash;
}

/**
 * 次のトラック名を決める。
 *
 * 空のイベントなら Track A。A と C があるなら B を埋める（抜けを先に使う）。
 * Z まで埋まったら番号に切り替える。
 * 固定の例を置くと、空のイベントで「Track D」のような嘘を出すことになる。
 */
export function nextTrackName(existing = []) {
  const used = new Set(existing.map((n) => String(n ?? '').trim()));
  for (let i = 0; i < 26; i++) {
    const name = `Track ${String.fromCharCode(65 + i)}`;
    if (!used.has(name)) return name;
  }
  for (let i = 1; i < 1000; i++) {
    const name = `Track ${i}`;
    if (!used.has(name)) return name;
  }
  return 'Track';
}
