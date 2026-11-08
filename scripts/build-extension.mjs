// Chrome 拡張を組み立てる。
//
// content script はページの CSP に縛られないよう、依存ごと拡張側に束ねる。
// ESM は使えないので IIFE で出す。
import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

if (!existsSync('.firebase-config.json')) {
  console.error('.firebase-config.json がない。先に npm run config を実行する。');
  process.exit(1);
}
const config = JSON.parse(readFileSync('.firebase-config.json', 'utf8'));

// テストでは実物の Google スライドを開けないので、ローカルの模擬ページにも差し込む
const forTest = process.env.EXT_TEST === '1';
const matches = ['https://docs.google.com/presentation/*'];
if (forTest) matches.push('http://127.0.0.1/*', 'http://localhost/*');

const manifest = {
  manifest_version: 3,
  name: '弾幕スライド',
  version: '0.1.0',
  description: 'Google スライドの発表に弾幕を重ねる',
  permissions: ['storage', 'tabs'],
  host_permissions: [
    'https://docs.google.com/*',
    'https://*.googleapis.com/*',
    ...(forTest ? ['http://127.0.0.1/*', 'http://localhost/*'] : []),
  ],
  action: { default_popup: 'popup.html', default_title: '弾幕スライド' },
  background: { service_worker: 'background.js' },
  content_scripts: [{ matches, js: ['content.js'], run_at: 'document_idle', all_frames: false }],
};
writeFileSync('extension/manifest.json', JSON.stringify(manifest, null, 2) + '\n');

const r = await build({
  entryPoints: ['src/extension-content.js'],
  outfile: 'extension/content.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: !forTest,
  legalComments: 'none',
  define: {
    __FIREBASE_CONFIG__: JSON.stringify(config),
    __USE_EMULATOR__: String(forTest),
  },
  metafile: true,
});
const out = Object.entries(r.metafile.outputs)[0];
console.log(`✓ ${out[0]}  ${(out[1].bytes / 1024).toFixed(0)} KB${forTest ? '（テスト用: ローカルにも差し込む）' : ''}`);
