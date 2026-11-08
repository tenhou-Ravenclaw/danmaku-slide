// ブラウザへ配るものを組み立てる。
//
// やることは2つだけ。Firebase SDK を同一オリジン用に束ねること、
// Firebase の設定を生成すること。アプリ側の HTML / JS は素のまま配る。
import { build } from 'esbuild';
import { existsSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

if (!existsSync('.firebase-config.json')) {
  console.error('.firebase-config.json がない。先に npm run config を実行する。');
  process.exit(1);
}

// 中身からファイル名を決める。
//
// 名前が固定のまま immutable で配ると、一度読んだ人は更新を受け取れない。
// ハッシュ付きの本体を長期キャッシュし、名前が固定の薄い入口だけ毎回確かめさせる。
//
// 入口は entry.js。かつて lib.js を immutable 1年で配ってしまったので、
// その名前は一度開いた人のブラウザで取り直されない。二度と使わない。
const result = await build({
  entryPoints: ['src/vendor.js'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  write: false,
  metafile: true,
});

const code = result.outputFiles[0].text;
const hash = createHash('sha256').update(code).digest('hex').slice(0, 10);
const name = `lib.${hash}.js`;

mkdirSync('public/vendor', { recursive: true });
// 古いハッシュのものを片付ける
for (const f of readdirSync('public/vendor')) {
  if (/^lib\.[0-9a-f]+\.js$/.test(f) && f !== name) rmSync(`public/vendor/${f}`);
}
rmSync('public/vendor/lib.js', { force: true });   // 汚れた名前は置かない
writeFileSync(`public/vendor/${name}`, code);
// 入口。これだけが名前固定で、毎回確かめられる（数十バイト）。
writeFileSync('public/vendor/entry.js',
  `// 生成物。中身は ./${name} にある。\nexport * from './${name}';\n`);

console.log(`✓ public/vendor/${name}  ${(code.length / 1024).toFixed(1)} KB`);
console.log(`✓ public/vendor/entry.js  入口（ハッシュ付き本体を指す）`);
