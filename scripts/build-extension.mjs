// Chrome 拡張を組み立てる。
//
// content script はページの CSP に縛られないよう、依存ごと拡張側に束ねる。
// ESM は使えないので IIFE で出す。
import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';

if (!existsSync('.firebase-config.json')) {
  console.error('.firebase-config.json がない。先に npm run config を実行する。');
  process.exit(1);
}
const config = JSON.parse(readFileSync('.firebase-config.json', 'utf8'));

// テストでは実物の Google スライドを開けないので、ローカルの模擬ページにも差し込む。
// 出力先も分ける。同じ場所に書くと、テストを回しただけで手元に入れた拡張が
// エミュレータ向けに差し替わり、本番のコメントが流れなくなる。
const forTest = process.env.EXT_TEST === '1';
// 切り分け用。本番の Firestore に繋ぎつつ、手元の模擬ページにも差し込む。
// 「拡張 ↔ 本番」と「Google のページ特有の事情」を分けて見るために要る。
const forDiag = process.env.EXT_DIAG === '1';
const outDir = forTest ? '.ext-test' : (forDiag ? '.ext-diag' : 'extension');
const matches = ['https://docs.google.com/presentation/*'];
if (forTest || forDiag) matches.push('http://127.0.0.1/*', 'http://localhost/*');

const manifest = {
  manifest_version: 3,
  name: '弾幕スライド',
  version: '0.1.0',
  description: 'Google スライドの発表に弾幕を重ねる',
  permissions: ['storage', 'tabs'],
  host_permissions: [
    'https://docs.google.com/*',
    'https://*.googleapis.com/*',
    ...(forTest || forDiag ? ['http://127.0.0.1/*', 'http://localhost/*'] : []),
  ],
  action: { default_popup: 'popup.html', default_title: '弾幕スライド' },
  background: { service_worker: 'background.js' },
  content_scripts: [{ matches, js: ['content.js'], run_at: 'document_idle', all_frames: false }],
};
mkdirSync(outDir, { recursive: true });
// テスト用の出力先には、生成物でないファイルもコピーしておく
if (forTest || forDiag) for (const f of ['popup.html', 'popup.js', 'background.js'])
  copyFileSync(`extension/${f}`, `${outDir}/${f}`);
writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');

const r = await build({
  entryPoints: ['src/extension-content.js'],
  outfile: `${outDir}/content.js`,
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: !forTest && !forDiag,
  legalComments: 'none',
  define: {
    __FIREBASE_CONFIG__: JSON.stringify(config),
    __BUILT_AT__: JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 19)),
    __USE_EMULATOR__: String(forTest),
  },
  metafile: true,
});
const out = Object.entries(r.metafile.outputs)[0];

// 本番の成果物にエミュレータ接続が残っていないことを確かめる。
// 残っていると「テストを回したら本番のコメントが流れない」事故に戻る。
if (!forTest && !forDiag) {
  const code = readFileSync(out[0], 'utf8');
  const leaks = ['127.0.0.1:8181', '127.0.0.1', ':9099', 'localhost:']
    .filter((needle) => code.includes(needle));
  if (leaks.length) {
    console.error(`本番の成果物にローカル向けの接続が残っている: ${leaks.join(', ')}`);
    process.exit(1);
  }
  if (!code.includes(config.projectId)) {
    console.error(`本番の成果物に projectId が入っていない: ${config.projectId}`);
    process.exit(1);
  }
}

console.log(`✓ ${out[0]}  ${(out[1].bytes / 1024).toFixed(0)} KB${forTest ? '（テスト用）' : forDiag ? '（切り分け用: 本番に繋ぐ）' : ''}`);
