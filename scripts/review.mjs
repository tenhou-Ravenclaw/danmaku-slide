// ローカルレビューの門。PR を立てる前にこれを通す。
//
// CI と同じチェックを同じ順で回し、1つでも落ちたら非ゼロで終わる。
// CI が使えないときでも、この1コマンドが通ったことが判断の根拠になる。
import { spawnSync } from 'node:child_process';

// 件数はラベルに焼かない。実行前には分からないし、各ランナー（node --test /
// エミュレータ）が実数を出す。文書と二重に持つとドリフトする（#115）。
const steps = [
  ['純粋ロジック',             'npm', ['run', '--silent', 'test:unit']],
  ['透過シェル',               'npm', ['run', '--silent', 'test:shell']],
  ['Rules の不変条件と生成物', 'npm', ['run', '--silent', 'lint:rules']],
  ['秘密情報（履歴）',         'npm', ['run', '--silent', 'lint:secrets']],
  ['本番依存の脆弱性',         'npm', ['audit', '--omit=dev', '--audit-level=moderate']],
  ['開発依存の脆弱性',         'npm', ['audit', '--audit-level=high']],
  ['Security Rules',           'npm', ['run', '--silent', 'test:rules']],
  ['Firestore 境界',           'npm', ['run', '--silent', 'test:bus']],
  ['実ブラウザ',               'npm', ['run', '--silent', 'test:browser']],
  ['Chrome 拡張',              'npm', ['run', '--silent', 'test:ext']],
];

const results = [];
for (const [label, cmd, args] of steps) {
  process.stdout.write(`\n──── ${label}\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  results.push([label, r.status === 0]);
}

console.log('\n════ ローカルレビュー');
for (const [label, ok] of results) console.log(`  ${ok ? 'ok  ' : 'NG  '} ${label}`);

const failed = results.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} 件落ちている。PR を立てる前に直す。`);
  process.exit(1);
}
console.log('\n全部通った。PR を立てられる。');
