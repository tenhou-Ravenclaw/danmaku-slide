# 開発の進め方

## 流れ

1. **issue を立てる** — 何を作るか、なぜ作るかを先に書く
2. **ブランチを切る** — `main` には直接コミットしない
3. **実装する** — テストは後回しにしない（後付けだとテストできない設計になる）
4. **ローカルでレビューを回す** — 下の「ローカルレビュー」を全部通す
5. **PR を立てる** — draft では立てない（レビューフックが draft をブロックする）
6. **CI と自動レビューが通ったらマージする**

ブランチ名は `<種別>/<issue番号>-<短い説明>`。種別は `feat` / `fix` / `chore` / `docs`。

```
feat/2-danmaku-engine
chore/1-dev-flow-and-ci
```

## ローカルレビュー

PR を立てる前に全部通す。

```bash
npm run config        # 初回と Firebase 設定の変更時だけ
npm run lint          # 不変条件ガード + 秘密情報スキャン（CI と同じもの）
npm run test:rules    # Security Rules（エミュレータ / 42件）
npm run test:e2e      # Security Rules（本番 / 27件）
```

`lint:secrets` には gitleaks が必要（`brew install gitleaks`）。


`test:e2e` は本番の Firestore を触る。検証用トラックと匿名アカウントは自分で片付けるが、
失敗して残ったら手で消す。

## レビューフック

[gh-review-hook](https://github.com/xpadev-net/gh-review-hook) を Claude Code の
Stop hook として使う。セッション終了時に PR の状態を見て、問題があればブロックする。

- CI の合否
- AI レビュー（Greptile / CodeRabbit / Copilot）の指摘
- base ブランチから遅れていないこと
- マージコンフリクト

```bash
go install github.com/xpadev-net/gh-review-hook/cmd/gh-review-hook@latest
```

登録は `.claude/settings.json` にコミットしてある。バイナリのパスが違う場合は
`gh-review-hook install` で入れ直す。

**このフックの効き目は CI の中身で決まる。** PR に対して CI が何も走らなければ、
見るのは base 遅れとコンフリクトだけになる。だから CI には実質のあるチェックを入れる。

## CI

`.github/workflows/ci.yml` の4ジョブ。

| ジョブ | 内容 |
|---|---|
| 弾幕エンジンのテスト | `node --test` で 20 件 |
| Firestore のテスト | エミュレータで Rules 42 件 + 境界 14 件 |
| 実ブラウザでの検証 | Playwright + エミュレータで 8 件 |
| Rules の不変条件と生成物のガード | テストモードの Rules の混入、守りの欠落、生成物の追跡を機械で落とす |
| 秘密情報スキャン | gitleaks で **履歴** を見る（一度コミットして消した鍵も対象） |
| 依存の脆弱性 | 配信物は moderate 以上で落とす / 開発ツールは high 以上で落とす |

### 依存の脆弱性

基準を2つに分けている。

```bash
npm audit --omit=dev --audit-level=moderate   # 配信されるコードの依存
npm audit --audit-level=high                  # 開発ツールまで含めた全体
```

ブラウザに配られるものは厳しく、ビルド時にしか動かない道具は現実的に、という分け方。
`firebase-tools` を devDependency に入れている関係で moderate が14件出るが、
いずれも CLI の依存（glob / minimatch / uuid / @opentelemetry など）で、
修正には firebase-tools を 13.11.2 まで落とす必要がある。配信コードには入らないので受け入れている。

鳴ったら監視レベルを下げるのではなく直す。

いま `package.json` に `overrides` で `@grpc/grpc-js` を `^1.14.7` に上げている。
`@firebase/firestore@4.19.1` が `~1.9.0` でピン留めしていて、1.9 系には high が5件ある
（GHSA-m9gg-hp2v-232j / GHSA-f596-whhp-79r4）。`npm audit fix --force` は firebase を
9.14.0 まで落とそうとするので使わない。上に引き上げたうえで、エミュレータと本番の
両方のテストが通ることを確認してある。

引き上げが壊れる依存に当たったときは、**理由をここに書いてから**例外にする。
`--audit-level` を静かに下げるのは禁止。

CI は `npm run lint:rules` / `npm run lint:secrets` を呼ぶだけなので、
**手元で通ったものが CI でも通る**。実装が二重にならない。

不変条件のガードは `scripts/lint-rules.mjs` の1本で、
**Rules から特定の1行が消えただけで守りが崩れる**ことへの対策であり、
`getAfter(` が消えればレート制限が、`request.resource.data.createdAt == request.time` が
消えれば時刻偽装の防止が、黙って無くなる。Rules のテストでも落ちるはずだが、
テストごと消された場合に備えて二重にしている。

## 守ること

- **PoC リポジトリ（`danmaku-slide-poc`）からコードをコピーしない。** ハッカソン規約で
  流用が禁止されており、違反は失格になり得る。参考にするのは設計だけで、コードは書き直す
- **鍵や秘密情報をコミットしない。** Firebase の Web 設定は `npm run config` の生成物で、
  `.gitignore` 済み
- **`Date.now()` をロジックの内部で呼ばない。** 時刻は引数で渡す。テストできなくなる
