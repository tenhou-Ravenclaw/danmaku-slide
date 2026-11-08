// 投稿ページの組み立て。
//
// QR から開いて即打てることが要件なので、クリックを1つも増やさない。
// 匿名サインインは開いた時点で済ませ、入力欄には最初からフォーカスを当てる。
import { connect } from './app.mjs';
import { MAX_TEXT, COOLDOWN_MS } from './bus.mjs';

/** Rules に弾かれた理由を、観客が読める言葉にする。 */
const REASON = {
  empty:    'なにか書いてから送る',
  'too-long': `${MAX_TEXT}文字までしか送れない`,
  cooldown: '連続では送れない',
  stopped:  'この登壇はもう終わっている',
  denied:   '送れなかった。少し待ってもう一度',
  offline:  'つながっていない。電波を確かめてもう一度',
};

export async function createPoster({ trackId, els, now = () => Date.now() }) {
  const { where, text, count, send, note } = els;
  const say = (msg, state = '') => { note.textContent = msg; note.dataset.state = state; };

  if (!trackId) {
    where.textContent = 'トラックが指定されていない';
    say('QRコードをもう一度読み取る', 'bad');
    return null;
  }

  let bus;
  try {
    bus = await connect(trackId);
  } catch (e) {
    where.textContent = 'つながらない';
    say(REASON.offline, 'bad');
    return null;
  }

  let track = null;
  let cooldownTimer = 0;

  bus.watchTrack((t) => {
    track = t;
    if (!t) { where.textContent = 'このトラックは存在しない'; say('QRコードを確かめる', 'bad'); refresh(); return; }
    where.textContent = t.title ? `${t.name} · ${t.title}` : t.name;
    if (t.stopped) say(REASON.stopped, 'wait');
    else if (note.dataset.state === 'wait' && note.textContent === REASON.stopped) say('');
    refresh();
  }, () => { where.textContent = '読み取れない'; say(REASON.denied, 'bad'); });

  /** 送れる状態かを見直す。文字数・停止・クールダウンのどれかで変わる。 */
  function refresh() {
    const len = text.value.trim().length;
    count.textContent = `${len} / ${MAX_TEXT}`;
    count.dataset.state = len > MAX_TEXT ? 'over' : '';

    const waiting = bus.cooldownRemaining() > 0;
    send.disabled = len === 0 || len > MAX_TEXT || track?.stopped === true || waiting || track === null;
    send.textContent = waiting ? `${Math.ceil(bus.cooldownRemaining() / 1000)} 秒待つ` : '送る';
  }

  /**
   * クールダウン中は毎秒表示を更新する。
   * 無言で押せなくすると「壊れている」と思われるので、残り秒数を出す。
   */
  function tickCooldown() {
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      refresh();
      if (bus.cooldownRemaining() <= 0) { clearInterval(cooldownTimer); cooldownTimer = 0; }
    }, 200);
  }

  async function submit() {
    const value = text.value;
    if (value.trim().length === 0) return;
    send.disabled = true;
    try {
      await bus.post(value);
      // 送れたら即空にする。続けて打てることが弾幕の体験なので。
      text.value = '';
      say('送った', 'ok');
      tickCooldown();
    } catch (e) {
      say(REASON[e.kind] ?? REASON.denied, e.kind === 'cooldown' ? 'wait' : 'bad');
      if (e.kind === 'cooldown') tickCooldown();
    } finally {
      refresh();
      text.focus();
    }
  }

  text.addEventListener('input', refresh);
  send.addEventListener('click', submit);
  text.addEventListener('keydown', (e) => {
    // スマホの改行は普通に使えるようにする。送信は Cmd/Ctrl + Enter
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });

  refresh();
  text.focus();
  return { bus, submit, refresh };
}
