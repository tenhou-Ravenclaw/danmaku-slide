# 弾幕スライド

登壇中のスライドにコメントを**重ねて**流す。観客はQRを読んで投稿するだけ、
登壇者は自分の画面でそのまま弾幕が見える。

GDGoC Japan DevFest Hackathon 2026 提出作品。

## 何を解くのか

LT で弾幕を流す既存のやり方は、どれかが必ず欠ける。

- 別画面に弾幕を出す → 登壇者がスライドと弾幕を同時に見られない
- Chrome 拡張で DOM に重ねる → PowerPoint や Keynote では原理的に動かない
- 配信ソフトで合成する → 拡張ディスプレイや登壇モードで崩れる

このアプリは**描画実装を1本に保ったまま、スライドへの「貼り方」を3つ用意する**ことで、
スライドツールを問わず同じ挙動にする。

## 貼り方

| | 方式 | 向く場面 |
|---|---|---|
| A | 弾幕ページを単体で全画面表示 | 弾幕だけを別画面に出したいとき |
| B | 画面キャプチャとブラウザ内で合成 | 投影先が1枚で、スピーカーノートを手元に残したいとき |
| C | **透過ウィンドウを最前面に重ねる** | スライドツールを問わない既定の方式 |

C が既定。[desktop/](desktop/) にシェルがある。

```bash
npm run shell
```

「全画面のスライドショーの上に残るか」は実機と本物のスライドツールが要るので
自動化できない。手順を [CHECKLIST.md](CHECKLIST.md) に固定してある。

## 構成

```
観客のスマホ ──投稿──▶ Cloud Firestore ──購読──▶ 登壇者の弾幕ページ
                            ▲
                     Firebase Hosting が
                     弾幕ページ / 投稿ページを配信
```

サーバコードは持たない。Hosting と Firestore だけで動く。
整合性と安全性はすべて **Firestore Security Rules** に寄せている（→ [SECURITY.md](SECURITY.md)）。

## データモデル

```
events/{eventId}          { name, heldOn, ownerUid, createdAt }
  /private/handoff        { code }                  ← 運営を手伝う人用
  /operators/{uid}        { code }
  /tracks/{trackId}       { name, stopped, createdAt }
    /comments/{id}        { text, createdAt }
    /posters/{uid}        { lastPostAt }
```

`trackId` は会場の「Track A」そのもので1日固定。だから **QR を印刷物に載せられる**。
登壇者が交代しても何も変えなくていいので、QR は貼り替えない。

トラックに状態はひとつしか無い。`stopped`（受付の可否）だけで、触れるのは運営。
**登壇の開始・終了は持たない。** 進行はイベントのタイムテーブルが持つもので、
ここに置くと二重管理になり、押し忘れだけが増える。
作ったトラックは受付前（`stopped: true`）で始まるので、前日に用意した QR が
その場から生きてしまうことはない。

## 開発

```bash
npm install
npm run config        # Firebase の Web 設定を生成（初回と設定変更時）

npm run dev           # エミュレータ（Firestore / Auth / Hosting）
npm run shell         # 透過ウィンドウシェル（貼り方C）

npm run review        # ローカルレビュー一式（CI と同じもの）
npm run test:e2e      # 本番に対する Rules の確認（27件、自分で後片付けする）

npm run preview       # 使い捨てURLにプレビュー配信
npm run deploy        # Hosting と Rules を本番へ
```

## テスト

| | |
|---|---|
| 純粋ロジック | 76件 |
| 透過シェルの設定 | 27件 |
| Security Rules | 60件（エミュレータ） |
| Firestore 境界 | 17件 |
| 実ブラウザ | 48件 |
| Chrome 拡張 | 16件 |
| 本番のインデックスと Rules | 11件 |

ほかに Rules の不変条件ガード26件、秘密情報の履歴スキャン、依存の脆弱性を
配信物と開発ツールで基準を分けて見ている。詳しくは [CONTRIBUTING.md](CONTRIBUTING.md)。

Rules のテストには JDK が必要（`brew install openjdk`）。

### Firebase の設定について

`public/firebase-config.js` と `.firebase-config.json` は **リポジトリに置かず、生成する**。
中身は Hosting から公開される性質のもの（ブラウザに配る設定なので隠せない）だが、
鍵のような文字列をリポジトリに残さないために `npm run config` で都度取り直す形にしている。
実体は `firebase apps:sdkconfig` の出力。

### テストが2種類ある理由

`test:rules` はエミュレータに対して Rules の論理を網羅的に当てる。速いし何度でも回せる。

`test:e2e` は**デプロイ済みの本番**に対して同じことをやる。エミュレータと本番で
`getAfter()` やクエリ制約の挙動が食い違っていないか、インデックスが本当に足りているかは
本番でしか分からないので、両方を維持する。終わったら検証用トラックと匿名アカウントを
自分で削除する。

## 本番

- Hosting: https://df-hackathon-2026.web.app
- Firestore: `asia-northeast1`

## ライセンス

MIT
