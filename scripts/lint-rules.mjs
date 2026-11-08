// Security Rules の不変条件ガード。
//
// Rules のテストとは役割が違う。テストは「意図どおり守れているか」を確かめるもので、
// こちらは「守りの一行が黙って消えていないか」を見る。テストごと消された場合に備えた二重化。
// CI もローカルレビューもこのスクリプトを呼ぶので、実装は1つしかない。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const rules = readFileSync('firestore.rules', 'utf8');
const problems = [];
const checks = [];

function check(label, ok) {
  checks.push([ok, label]);
  if (!ok) problems.push(label);
}

// --- テストモードの Rules の混入 ----------------------------------------
// `allow ... : if true` は Firebase コンソールのテストモードそのもの。
// 提出リポジトリに入ると全開放になる。
const testMode = [...rules.matchAll(/^.*allow[^;]*:\s*if\s+true.*$/gm)];
check('テストモードの Rules が入っていない', testMode.length === 0);
for (const m of testMode) {
  const line = rules.slice(0, m.index).split('\n').length;
  console.error(`  firestore.rules:${line}  ${m[0].trim()}`);
}

// --- 守りの一行が消えていないか -----------------------------------------
// どれか1つ欠けるだけで守りが崩れるものを名指しで見張る。
const invariants = [
  ['認証必須の判定',                      'request.auth != null'],
  ['運営は匿名では操作できない',          "sign_in_provider != 'anonymous'"],
  ['作成時の ownerUid の固定',            'request.resource.data.ownerUid == request.auth.uid'],
  ['トラックを作れるのは運営だけ',        'get(eventPath()).data.ownerUid == request.auth.uid'],
  ['レート制限（同一バッチの posters 更新の強制）', 'getAfter('],
  ['2秒のクールダウン',                   "duration.value(2, 's')"],
  ['createdAt のサーバ時刻強制',          'request.resource.data.createdAt == request.time'],
  ['クエリ件数の上限',                    'request.query.limit'],
  ['引き継ぎコードの読み取り禁止',        'allow read: if false'],
  ['コメントの追記専用',                  'allow update, delete: if false'],
  ['ownerUid の書き換え禁止',             'request.resource.data.ownerUid == resource.data.ownerUid'],
  ['createdAt の書き換え禁止',            'request.resource.data.createdAt == resource.data.createdAt'],
  ['更新できるフィールドの限定',          'affectedKeys()'],
  ['トラックで動くのは受付の可否だけ',    "hasOnly(['stopped'])"],
  ['受付の開け閉めは運営だけ',            'allow update: if isEventStaff()'],
  ['トラックは受付前で作られる',          'request.resource.data.stopped == true'],
  ['受付中でなければ受け付けない',        'get(trackPath()).data.stopped == false'],
  // 登壇者に書き込む先を残さない。合言葉が何も開けない状態で残るのを防ぐ。
];
for (const [label, needle] of invariants) {
  if (needle === null) continue;
  check(`${label}（${needle}）`, rules.includes(needle));
}

// 消したものが戻ってきていないか。登壇者に書き込ませる口は持たない。
for (const gone of ['isTrackSpeaker', "'live'", 'sessionStartedAt', 'tracks/$(trackId)/operators']) {
  check(`${gone} が残っていない`, !rules.includes(gone));
}

// --- 生成物・秘密情報が git に入っていないか ----------------------------
for (const f of ['public/firebase-config.js', 'public/vendor/entry.js', '.firebase-config.json', '.env']) {
  let tracked = false;
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', f], { stdio: 'ignore' });
    tracked = true;
  } catch { /* 追跡されていない = 正常 */ }
  check(`${f} が git に入っていない`, !tracked);
}

// --- 出力 ---------------------------------------------------------------
for (const [ok, label] of checks) console.log(`  ${ok ? 'ok  ' : 'NG  '} ${label}`);

if (problems.length) {
  console.error(`\n${problems.length} 件の不変条件が破れている`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\n${checks.length} 件すべて満たしている`);
