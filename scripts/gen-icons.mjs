// assets/icon/png から、配布用の .icns（mac）と .ico（Windows）を作る。
//
// PNG は #143 で書き出し済み。ここはそれを束ねるだけ。
//   .icns … iconutil（macOS 標準）に .iconset を渡す
//   .ico  … 変換ツールが無い環境でも通るよう、PNG を埋めた ICO を素で書く
//           （Vista 以降は PNG 圧縮の ICO を読める）
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const PNG = 'assets/icon/png';
const OUT = 'assets/icon';
const png = (n) => `${PNG}/aizuchi-${n}.png`;

// --- .icns（iconutil） -----------------------------------------------------
// iconutil は決まった名前の .iconset を要求する。倍密度は @2x。
const ICONSET = [
  [16, 'icon_16x16.png'],   [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],   [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];
function buildIcns() {
  const dir = `${OUT}/aizuchi.iconset`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [size, name] of ICONSET) copyFileSync(png(size), `${dir}/${name}`);
  execFileSync('iconutil', ['-c', 'icns', dir, '-o', `${OUT}/aizuchi.icns`]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`✓ ${OUT}/aizuchi.icns`);
}

// --- .ico（素で書く） ------------------------------------------------------
// ICONDIR(6) + ICONDIRENTRY(16)×N + PNG データの連結。
// 幅/高さは 256 を 0 で表す。planes=1, bitCount=32 固定。
const ICO_SIZES = [16, 32, 64, 128, 256];
function buildIco() {
  const imgs = ICO_SIZES.map((s) => ({ size: s, data: readFileSync(png(s)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type: icon
  header.writeUInt16LE(imgs.length, 4);

  const entries = [];
  let offset = 6 + imgs.length * 16;
  for (const { size, data } of imgs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);  // width（256 は 0）
    e.writeUInt8(size >= 256 ? 0 : size, 1);  // height
    e.writeUInt8(0, 2);                         // palette
    e.writeUInt8(0, 3);                         // reserved
    e.writeUInt16LE(1, 4);                      // color planes
    e.writeUInt16LE(32, 6);                     // bits per pixel
    e.writeUInt32LE(data.length, 8);            // bytes of PNG
    e.writeUInt32LE(offset, 12);                // offset
    offset += data.length;
    entries.push(e);
  }
  const ico = Buffer.concat([header, ...entries, ...imgs.map((i) => i.data)]);
  writeFileSync(`${OUT}/aizuchi.ico`, ico);
  console.log(`✓ ${OUT}/aizuchi.ico  (${ICO_SIZES.join('/')})`);
}

buildIcns();
buildIco();
