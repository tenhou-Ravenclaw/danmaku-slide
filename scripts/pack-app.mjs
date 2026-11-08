// 透過シェルをダブルクリックで起動できるアプリに固める。
//
// 署名はしない。公証には Apple Developer Program が要り、時間的に無理。
// 初回だけ右クリック→開く で回避してもらう前提。
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

const paths = await packager({
  dir: 'desktop',
  out: 'dist',
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
for (const dir of paths) {
  const appName = readdirSync(dir).find((f) => f.endsWith('.app'));
  const zip = `${app.name}-${process.platform}-${process.arch}.zip`;
  execFileSync('zip', ['-q', '-r', '-y', `../${zip}`, appName], { cwd: dir });
  console.log(`✓ ${dir}`);
  console.log(`✓ dist/${zip}`);
}
console.log(`  版 ${app.version}  ${stamp}  electron ${electronVersion}`);
console.log('  署名していないので、macOS では初回だけ右クリック→開く が要る');
