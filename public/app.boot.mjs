// app.html の起動。外部モジュールにして、CSP の script-src を 'self' で縛れる
// ようにする（#113）。登壇者の画面から来たときは、そのトラックのままブラウザで
// 流せる道を出す。ここに来た人はたいてい登壇直前で、アプリを入れている時間が無い。
const q = new URLSearchParams(location.search);
const e = q.get('e'), t = q.get('t');
if (e && t) {
  const { overlayUrlFor, withEnv } = await import('./lib/ids.mjs');
  document.getElementById('nowLink').href = withEnv(`${overlayUrlFor(e, t)}&capture=1`);
  document.getElementById('now').classList.remove('hidden');
}

// どのファイルを落とせばいいかを先に出す。配布ページで4つから選ばせない。
const ua = navigator.userAgent;
const mac = /Mac/.test(ua);
const os = mac ? 'macOS' : /Windows/.test(ua) ? 'Windows' : null;

const hint = document.getElementById('osHint');
const which = document.getElementById('which');
if (os === 'macOS') {
  hint.textContent = 'macOS で開いています';
  which.innerHTML = '配布ページで <span class="file">darwin-arm64</span>'
    + '（Apple シリコン）か <span class="file">darwin-x64</span>（Intel）を選んでください。';
} else if (os === 'Windows') {
  hint.textContent = 'Windows で開いています';
  which.innerHTML = '配布ページで <span class="file">win32-x64</span> を選んでください。';
} else {
  hint.textContent = 'macOS と Windows のアプリを配っています';
  which.textContent = 'スマホからは入れられません。発表に使う機械で開いてください。';
}

if (!mac) document.getElementById('k2').textContent = 'Ctrl+Shift+X';
