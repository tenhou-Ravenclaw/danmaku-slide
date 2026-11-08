// トラック選択。チラシのQR1本から、観客が自分の部屋を選ぶ。
//
// これがあると、トラックごとに別のQRを刷らなくて済む。
import { start } from '/lib/app.mjs';
import { createEventBus } from '/lib/bus.mjs';
import { postUrlFor, withEnv } from '/lib/ids.mjs';

export async function createPicker({ eventId } = {}) {
  const el = (id) => document.getElementById(id);
  const note = (text, kind = '') => { el('note').textContent = text; el('note').dataset.kind = kind; };

  if (!eventId) {
    el('heading').textContent = 'リンクが正しくありません';
    note('QRコードをもう一度読み取ってください', 'bad');
    return null;
  }

  let events;
  try {
    const { uid, db, sdk } = await start();
    events = createEventBus(sdk, { db, uid });
  } catch {
    el('heading').textContent = 'つながりません';
    note('電波を確かめてもう一度', 'bad');
    return null;
  }

  events.watchEvent(eventId, (ev) => {
    if (!ev) {
      el('heading').textContent = 'このイベントはありません';
      note('QRコードを確かめてください', 'bad');
      return;
    }
    el('event').textContent = ev.name;
  }, () => note('読み取れません', 'bad'));

  let tracks = [];
  events.watchTracks(eventId, (rows) => { tracks = rows; paint(rows); },
    () => note('トラックを読み取れません', 'bad'));

  function paint(rows) {
    const list = el('list');
    list.replaceChildren();
    if (rows.length === 0) {
      note('まだトラックがありません', 'bad');
      return;
    }
    note('');
    // トラックが1つしかないなら迷う余地がない。そのまま送る。
    if (rows.length === 1) {
      location.replace(withEnv(postUrlFor(eventId, rows[0].id)));
      return;
    }
    for (const t of rows) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = withEnv(postUrlFor(eventId, t.id));
      const box = document.createElement('div');
      const name = document.createElement('div');
      name.className = 't';
      name.textContent = t.name;
      const sub = document.createElement('div');
      sub.className = 's';
      // コメントは外から来る。textContent で入れる。
      sub.textContent = (t.live && !t.stopped) ? '登壇中' : '次の登壇を待っています';
      box.append(name, sub);
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '›';
      a.append(box, chev);
      li.append(a);
      list.append(li);
    }
  }

  return { eventId, get tracks() { return tracks; } };
}
