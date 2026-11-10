// organizer.html の入口デモ。外部モジュールにして、CSP の script-src を 'self' で
// 縛れるようにする（#113）。Firebase に依存しないので、コンソール本体とは別に読む。
// こちらが落ちても運営の操作は動き、逆も同じ。

// 弾幕の配置と描画は本番と同じものを使う。見せているものが実物と食い違わない。
import { DanmakuFlow } from './lib/danmaku.mjs';
import { Renderer } from './lib/renderer.mjs';

const canvas = document.getElementById('demo');
const slow = matchMedia('(prefers-reduced-motion: reduce)').matches;

const LINES = [
  'ここ分かりやすい', '図がいい', 'フォントは何ですか', 'スライドの配色きれい',
  'それ知らなかった', '88888888', 'なるほど', 'あとで試す', 'テンポいい',
];

// 小さい枠なので本番より字を小さくする。流れ方は同じ。
const flow = new DanmakuFlow({ speed: 85, lineHeight: 40, gap: 28, topMargin: 12 });
const renderer = new Renderer(canvas, { strokeWidth: 3.5 });
const FACE = getComputedStyle(document.body).fontFamily;

/**
 * 枠の幅に合わせて字と行を決める。
 *
 * 固定の大きさにすると、スマホの小さい枠では字だけが大きく残り、
 * 行が2〜3本しか取れずに下敷きのスライドと重なって、どちらも読めなくなる。
 */
function scaleTo(width) {
  const px = Math.max(12, Math.min(22, Math.round(width / 30)));
  renderer.style.font = `700 ${px}px ${FACE}`;
  renderer.style.strokeWidth = Math.max(2.5, px / 5.7);
  renderer.style.baselineOffset = Math.round(px * 1.2);
  flow.lineHeight = Math.round(px * 1.95);
  flow.speed = Math.max(55, Math.round(width / 8.5));
  flow.gap = Math.round(px * 1.4);
}

// 読み込み直後は performance.now() が 0 に近い。「少し前に流れ始めた」ものを
// 置きたいので、そのまま引くと負の時刻になり、DanmakuFlow が空き行を見つけられない
// （行の空き時刻 0 と比べて「まだ塞がっている」と判断する）。時計ごと先へずらす。
const BASE = 60000;
const clock = (t) => t + BASE;

let n = 0;
const send = (now) => {
  const text = LINES[n++ % LINES.length];
  flow.add({ id: `d${n}`, text, width: renderer.measure(text) }, now);
};

/**
 * 枠に合わせ直す。
 *
 * resize は流れているものを作り直すので、そのたびに何本か入れ直す。
 * ResizeObserver は observe した直後にも一度鳴るので、ここで入れないと
 * 最初に入れた分が消えて、数秒のあいだ空の矩形を見せることになる。
 */
let nextAt = 0;
function fit() {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  scaleTo(r.width);
  const { width, height } = renderer.resize(r.width, r.height, devicePixelRatio || 1);
  flow.resize(width, height);

  const now = clock(slow ? 0 : performance.now());
  for (let i = Math.min(5, flow.laneCount); i > 0; i--) {
    const text = LINES[n++ % LINES.length];
    flow.add({ id: `d${n}`, text, width: renderer.measure(text) }, now - i * 1400);
  }
  nextAt = now + 900;
  renderer.draw(flow.step(now));
}
// 門が畳まれているあいだ canvas は幅0。見えるようになってから動かす。
let running = false;
const startIfVisible = () => {
  if (running || canvas.getBoundingClientRect().width === 0) return;
  running = true;
  fit();
  if (!slow) requestAnimationFrame(globalThis.__danmakuFrame);
};
new ResizeObserver(() => { startIfVisible(); if (running) fit(); }).observe(canvas);

// 動かさない設定の人には、止まったまま並べたものを見せる。
{
  const frame = (t) => {
    const now = clock(t);
    if (now >= nextAt) { send(now); nextAt = now + 1100 + Math.random() * 900; }
    renderer.draw(flow.step(now));
    requestAnimationFrame(frame);
  };
  globalThis.__danmakuFrame = frame;
  startIfVisible();
}
