# 弾幕スライド

> **はじめて触る / 作業を再開するなら** → [issue #48 ここから再開する](https://github.com/tenhou-Ravenclaw/danmaku-slide/issues/48)
> いまの状態、残っていること、締切、触ると壊れるものがまとめてある。

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

登壇者が使うアプリは **GitHub Release** で配る。登壇者の画面（`/stage.html`）の
「アプリを入手」からそこへ飛ぶ（`/app.html` は Release へのリダイレクト）。
OS 別のファイルの選び方・未署名アプリの越え方・使い方は Release notes に書いてある。

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
作ったトラックは受付中で始まる。止めた状態で作ると、運営が開け忘れたときに
本番中に観客が投稿できない。いちばん困るときに、いちばん気づきにくい形で壊れる。
開催前の投稿は運営が「止める」で閉じられるので、失敗の重さが釣り合わない。

## 開発

```bash
npm install
npm run config        # Firebase の Web 設定を生成（初回と設定変更時）

npm run dev           # エミュレータ（Firestore / Auth / Hosting）
npm run shell         # 透過ウィンドウシェル（貼り方C）

npm run review        # ローカルレビュー一式（CI と同じもの）
npm run test:e2e      # 本番の Rules とインデックスの確認（本番には書かない）

npm run preview       # 使い捨てURLにプレビュー配信
npm run deploy        # Hosting と Rules を本番へ
```

## テスト

| 何を見るか | |
|---|---|
| 純粋ロジック | 弾幕の配置・描画・ID・切り出し（`node --test`） |
| 透過シェルの設定 | Electron のウィンドウ設定とリンクの解釈 |
| Security Rules | エミュレータに対して Rules の論理を網羅する |
| Firestore 境界 | `bus` の読み書きがルールと噛み合うか |
| 実ブラウザ | Playwright + エミュレータで画面の挙動 |
| Chrome 拡張 | 拡張を読み込んだ Chromium で差し込みを確認 |
| 本番のインデックスと Rules | デプロイ済みの本番で複合インデックスを検査 |

ほかに Rules の不変条件ガード、秘密情報の履歴スキャン、依存の脆弱性を配信物と
開発ツールで基準を分けて見ている。詳しくは [CONTRIBUTING.md](CONTRIBUTING.md)。

件数は固定で書かない（増減のたびに文書がずれる）。`npm run review` が全部まとめて
回し、各スイートの実数を出す。

Rules のテストには JDK が必要（`brew install openjdk`）。

### Firebase の設定について

`public/firebase-config.js` と `.firebase-config.json` は **リポジトリに置かず、生成する**。
中身は Hosting から公開される性質のもの（ブラウザに配る設定なので隠せない）だが、
鍵のような文字列をリポジトリに残さないために `npm run config` で都度取り直す形にしている。
実体は `firebase apps:sdkconfig` の出力。

### テストが2種類ある理由

`test:rules` はエミュレータに対して Rules の論理を網羅的に当てる。速いし何度でも回せる。

`test:e2e` は**デプロイ済みの本番**に対して同じことをやる。エミュレータは
インデックスを検査しないので、複合インデックスの不足は本番でしか出ない
（実際に failed-precondition を出した）。だから両方を維持する。

本番には何も書かない。クエリは実在しない親に対して投げる。Firestore は
実行前に計画するので、結果が0件でもインデックスが足りなければ落ちる。
書かないので後片付けも要らない。

## 本番

- Hosting: https://df-hackathon-2026.web.app
- Firestore: `asia-northeast1`

## 今後の展望

このプロダクトは**運営ドリブンの発行**を主目的に置いている。イベントを立てる運営が、
観客と登壇者にトラックを配る形。カンファレンスや勉強会のように、準備する人と使う人が
分かれている場を想定している。

**個人ドリブンの発行**（一人がパッと自分の発表用トラックを出す）は、別クライアントを
同じバックエンドに繋ぎ込む形で後から足せる。このアプリはサーバーコードを持たず、
Firestore と Security Rules が契約そのものなので、`firebaseConfig` と Rules を共有すれば
別の入口を増やせる。弾幕エンジン（`public/lib/`）もペルソナ非依存なので再利用できる。

その場合も**認証は外さない**。トラックを後から増やす・開催日が変わる・本番中に受付を
開け閉めするといった「あとからの操作」が要るので、端末を変えても同じものを開ける
durable な identity が要る。個人向けの軽さは Rules を緩めるのではなく、UI 側で
event の段取りを隠すことで出す（共有している Rules を緩めると、運営側の安全性まで
一緒に下がるため）。

セキュリティ面で残している穴（App Check など）は [SECURITY.md](SECURITY.md) の
「残っている穴」を参照。

## ライセンス

MIT
