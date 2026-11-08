// 透過シェルをダブルクリックで起動できるアプリに固める。
//
// 署名はしない。公証には Apple Developer Program が要り、時間的に無理。
// 初回だけ右クリック→開く（macOS）／詳細情報→実行（Windows）で回避してもらう前提。
//
// mac から Windows 版も作れる。Electron が各OSの本体を配っているので、
// 中身を入れ替えるだけで済む。native module を持っていないから成立する。
//   npm run pack:app            いまの OS のぶんだけ
//   npm run pack:app -- --all   mac と Windows の両方
import { packager } from '@electron/packager';
import { readFileSync, rmSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const electronVersion = require_('electron/package.json').version;
const app = JSON.parse(readFileSync('desktop/package.json', 'utf8'));

const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ` +
              `${p2(now.getHours())}:${p2(now.getMinutes())}`;

rmSync('dist', { recursive: true, force: true });

const all = process.argv.includes('--all');
const platform = all ? ['darwin', 'win32'] : [process.platform];
const arch = all ? ['arm64', 'x64'] : [process.arch];

const paths = await packager({
  dir: 'desktop',
  out: 'dist',
  platform,
  arch,
  overwrite: true,
  asar: true,
  electronVersion,
  appBundleId: 'net.xpadev.danmaku-slide',
  appVersion: app.version,
  buildVersion: stamp,
  // 運営のリンクから起動できるようにする。手でIDを貼らずに済む。
  protocols: [{ name: '弾幕スライド', schemes: ['danmaku'] }],
  // 書き出す対象を絞る。node_modules は要らない（依存を持っていない）。
  ignore: [/^\/README\.md$/],
  darwinDarkModeSupport: true,
  appCategoryType: 'public.app-category.productivity',
});

// zip まで作る。配るときに .app のままだと権限が落ちることがある。
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
for (const dir of paths) {
  // macOS は .app ひとつ、Windows はフォルダごと。入れるものが違う。
  const appName = readdirSync(dir).find((f) => f.endsWith('.app'));
  const zip = `${basename(dir)}.zip`;
  const target = appName ?? '.';
  execFileSync('zip', ['-q', '-r', '-y', `../${zip}`, target], { cwd: dir });
  console.log(`✓ dist/${zip}`);
}
console.log(`  版 ${app.version}  ${stamp}  electron ${electronVersion}`);
console.log('  署名していないので、macOS では初回だけ右クリック→開く が要る');
