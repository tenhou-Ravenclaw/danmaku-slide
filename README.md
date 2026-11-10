# Aizuchi

> 登壇中のスライドに、客席からのコメントを重ねて流す。

観客は QR を読んでコメントを送るだけ。登壇者は自分の画面で、スライドの上に重なった
弾幕（コメント）をそのまま見られる。PowerPoint・Keynote・Google スライド・PDF など、
**スライドツールを問わず**同じように動く。

名前の Aizuchi は「相槌」から。客席のうなずきが、スライドの上を流れていく。

GDGoC Japan DevFest Hackathon 2026 提出作品。

## 試す

本番: **https://df-hackathon-2026.web.app**

1. 運営が Google サインインしてイベントとトラックを作り、QR とリンクを配る
2. 観客は QR を読んで投稿ページでコメントする（インストール不要）
3. 登壇者は自分の画面（`/stage.html`）から弾幕を出す

弾幕の出し方は3通り（下記「貼り方」）。既定は透過ウィンドウを重ねる**アプリ**で、
登壇者画面の「アプリを入手」から配布版（macOS / Windows）を入手できる。
インストールの余裕がなければ、ブラウザだけで合成する道もある。

## 解く課題

LT で弾幕を流す既存のやり方は、どれかが必ず欠ける。

- 別画面に弾幕を出す → 登壇者がスライドと弾幕を同時に見られない
- Chrome 拡張で DOM に重ねる → PowerPoint や Keynote では原理的に動かない
- 配信ソフトで合成する → 拡張ディスプレイや登壇モードで崩れる

Aizuchi は**描画の実装を1本に保ったまま、スライドへの「貼り方」を3つ**用意することで、
スライドツールを問わず同じ挙動にする。

| | 方式 | 向く場面 |
|---|---|---|
| A | 弾幕ページを単体で全画面表示 | 弾幕だけを別画面に出したいとき |
| B | 画面キャプチャをブラウザ内で合成 | 投影が1枚で、スピーカーノートを手元に残したいとき |
| C | **透過ウィンドウを最前面に重ねる** | 既定。スライドツールを問わない |

既定は C（[desktop/](desktop/) の Electron シェル）。クリックはそのままスライドに通り、
全画面のスライドショーの上にも残る。同時に出る弾幕は上限 30 本に抑え、スライドの本文が
弾幕で埋もれないようにしている。

## 構成

```
観客のスマホ ──投稿──▶ Cloud Firestore ──購読──▶ 登壇者の弾幕ページ
                            ▲
                     Firebase Hosting が
                     弾幕ページ / 投稿ページを配信
```

**サーバアプリケーションコードを持たない。** Cloud Functions も自前のバックエンドも無く、
Firebase Hosting と Firestore だけで動く。整合性と安全性のロジックは、サーバ側で評価される
**Firestore Security Rules** に寄せている（→ [SECURITY.md](SECURITY.md)）。

## データモデル

```
events/{eventId}          { name, heldOn, ownerUid, createdAt }
  /private/handoff        { code }                  ← 運営を手伝う人用
  /operators/{uid}        { code }
  /tracks/{trackId}       { name, stopped, createdAt }
    /comments/{id}        { text, createdAt }
    /posters/{uid}        { lastPostAt }             ← 2秒に1回のレート制限
```

`trackId` は会場の「Track A」そのもので1日固定。だから **QR を印刷物に載せられ**、
登壇者が交代しても貼り替えなくていい。トラックの状態は受付の可否（`stopped`）だけで、
触れるのは運営。投稿のレート制限は、コメントと `posters/{uid}` を同一バッチで書かせる
ことで Rules が強制している。

## セキュリティ

サーバがないぶん、Rules が契約そのもの。詳細と、意図的に残している穴（App Check など）は
[SECURITY.md](SECURITY.md) に**隠さず**書いてある。

## 技術とテスト

Firebase Hosting / Cloud Firestore / Electron（透過シェル）/ Chrome 拡張（貼り方の一つ）。

テストは純粋ロジック（弾幕の配置・描画）、Security Rules、Firestore 境界、実ブラウザ
（Playwright + エミュレータ）、Chrome 拡張を網羅する。1コマンドで一括実行できる。

```bash
npm install
npm run config        # Firebase の Web 設定を生成（初回と設定変更時）
npm run review        # テスト一式（CI と同じもの。JDK が要る）
npm run shell         # 透過ウィンドウシェル（貼り方C）を起動
npm run deploy        # Hosting と Rules を本番へ
```

「全画面のスライドショーの上に残るか」は実機と本物のスライドツールが要るので自動化できず、
そこは実機で手動確認している。

## ライセンス

MIT
