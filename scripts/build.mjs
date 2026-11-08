// ブラウザへ配るものを組み立てる。
//
// やることは2つだけ。Firebase SDK を同一オリジン用に束ねること、
// Firebase の設定を生成すること。アプリ側の HTML / JS は素のまま配る。
import { build } from 'esbuild';
import { existsSync } from 'node:fs';

if (!existsSync('.firebase-config.json')) {
  console.error('.firebase-config.json がない。先に npm run config を実行する。');
  process.exit(1);
}

const result = await build({
  entryPoints: ['src/vendor-firebase.js'],
  outfile: 'public/vendor/firebase.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
});

const out = Object.entries(result.metafile.outputs)[0];
console.log(`✓ ${out[0]}  ${(out[1].bytes / 1024).toFixed(1)} KB`);
