# 安全性の設計

このアプリは**観客にログインを要求しない**。QRを読んだら即投稿できることが要件なので、
認証で守る設計は取れない。その制約の中で何をどう守っているかを書く。

## 出発点になる非対称性

- **投稿面は認証で守れない。** ログインを挟むと「無駄なクリックをなくす」という要件が壊れる。
  だから防御は認証ではなく **形の制約** でやる。
- **制御面は認証で守れる。** 登壇者とスタッフには準備時間があるので一手間かけられる。

観客にも `signInAnonymously` を入れている。画面もクリックも増えないが、UID が手に入るので
「UID ごとのレート制限」が Rules だけで書けるようになる。

## データモデル

```
tracks/{trackId}        { name, title, speaker, sessionStartedAt, stopped, ownerUid, createdAt }
  /comments/{id}        { text, createdAt }      追記専用。update / delete は全拒否
  /private/handoff      { code }                 誰も読めない。Rules の get() だけが参照する
  /operators/{uid}      { code }                 引き継ぎコードで登録された運用者
  /posters/{uid}        { lastPostAt }           レート制限の土台。読み取り全拒否
```

`trackId` は長寿命（会場の「Track A」そのもの。QR が指すのはこれ）。
`sessionStartedAt` は短寿命（登壇者1人ぶんの区切り）。
この2つを分けているので、QR を貼り替えずに登壇者を交代できる。

## 脅威と対策

| | 脅威 | 対策 |
|---|---|---|
| T1 | 公開 config を見て他トラックを覗く・荒らす | 読み・書き・購読すべて認証必須 |
| T2 | `stopped` や `sessionStartedAt` の改変で弾幕を殺す | `ownerUid` に焼き、`ownerUid` と `createdAt` は誰も書き換えられない。触れるのは運用4フィールドのみ |
| T3 | 投稿の改変・削除 | `update` / `delete` は owner でも全拒否 |
| T4 | 無限書き込みで Firestore 課金を燃やす | `getAfter()` で同一バッチの `posters` 更新を強制し、`posters` 側で2秒のクールダウン。`request.query.limit` も上限で縛る |
| T5 | 長文・制御文字で描画を壊す | フィールド whitelist、1〜60文字、`createdAt == request.time` |

描画は Canvas の `fillText` なので、XSS は構造的に発生しない。DOM 化しないことが防御になっている。

## レート制限の仕組み

サーバコードを持たずに Rules だけでレート制限を成立させている。

1. 投稿は **コメント + `posters/{uid}` の2件バッチ**で書く
2. コメントの `create` 条件に
   `getAfter(.../posters/{uid}).data.lastPostAt == request.time` を入れる
3. `posters/{uid}` の `update` 条件に
   `request.time > resource.data.lastPostAt + duration.value(2,'s')` を入れる

片方が落ちればバッチ全体が落ちるので、2秒以内の連投はコメントごと拒否される。

コストは **1投稿あたり write 2 / read 2**（`posters` の更新と Rules の `get` / `getAfter`）。
1イベント1000投稿で 2000/2000。無料枠は1日 20,000 write / 50,000 read なので桁が違う。

## 引き継ぎ（スタッフ → 登壇者）

`tracks/{id}/private/handoff` に引き継ぎコードを置く。**owner 自身も読めない**
（Rules の `get()` だけが見る）。登壇者はコードを提示して `operators/{uid}` に自分を登録し、
以降は owner と同じ運用操作ができる。`ownerUid` は奪えないまま。

これが成立するので、**スタッフが事前にトラックを作り、QR を印刷物に載せる**運用が取れる。
スクリーンに QR を出して登壇を邪魔する必要がない。
登壇者スタートは「自分で createTrack を呼ぶだけ」の特殊ケースで、Rules は完全に共通。

## 残っている穴

**匿名 UID は使い捨てなので、再サインインすれば2秒制限を抜けられる。**
Rules だけでは原理的に防げない。本来の正解は App Check（reCAPTCHA v3 プロバイダ）で、
Firestore は App Check 強制に対応している。

現状はこれを承知の上で、次の多層で受けている。

1. Rules — 攻撃に技術的ハードルを作る
2. 予算アラート — 実費の歯止め
3. 登壇者の `stopped = true` ワンクリック封鎖 — 運用上の最終手段
4. App Check — 時間が確保できたら

3 が効くのは、攻撃面が**登壇中の数分間に限られる**から。`sessionStartedAt` の時間窓と
`stopped` で、守る対象がそもそも小さい。

### 停止が効くことの実装上の注意

Firestore は書き込みをまずローカルに適用し、サーバに拒否されると巻き戻す。
巻き戻しのスナップショットが購読から届くので、素直に書くと**エラー表示が通常表示で
上書きされ、押しても何も起きなかったように見える**。登壇者コンソールでは、エラーを
残す側に倒して、次に成功したときか一定時間で消すようにしている。

これは実ブラウザのテストで見つけた。owner 以外が停止を押したときに
「止められない」が出続けることを `test:browser` で固定している。

## 検証

`firestore.rules` が設計そのもので、`test/rules.test.mjs` が「本当にそう守れているか」の証拠。

    npm install
    npm run test:rules    # エミュレータ / 42件
    npm run test:e2e      # 本番 / 27件

エミュレータ 42 件と本番 27 件がすべて通る状態を維持する。
Rules を触ったら両方が落ちないことを確認する。

本番側を別に持っているのは、エミュレータと本番で `getAfter()` やクエリ制約の挙動が
食い違っていないか、インデックスが本当に足りているかは本番でしか分からないため。
2026-11-08 時点で、`where(createdAt >= sessionStartedAt) + orderBy(createdAt desc) + limit(50)`
が複合インデックスなしで通ることを本番で確認している。
