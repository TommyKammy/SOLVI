# アクセシビリティ自動検査 Evidence (Gate A GA-5)

- 実施日時: 2026-07-27 22:30:10 JST
- 対象: [[WP-P2-PORTAL-002]] の未達受入基準 / Gate A GA-5 / NFR-UX-002
- 実装: `tools/check_accessibility.mjs`

## 1. なぜ実ブラウザで検査するか

jsdom のような擬似DOMでも一部の規則は評価できるが、
**コントラスト比とフォーカスの可視性は実際に描画しないと判定できない**。
そこを落とすと、最も見落としやすい欠陥を検査対象から外すことになる。

Playwright + Chromium で実際に描画し、`@axe-core/playwright` で検査する。

## 2. 適用する規則

`wcag2a` / `wcag2aa` / `wcag21a` / `wcag21aa` / `wcag22aa`

`best-practice` は**含めない**。望ましいが必須ではない指摘が混ざると、
「対応しなくてよい違反」が一覧に並ぶ。そうなると一覧そのものが読まれなくなり、
本当の違反が埋もれる。

## 3. 検査結果

```
  OK   ログイン
  OK   ログイン(エラー表示)
  OK   Portalトップ
  OK   起票フォーム(障害)
  OK   起票フォーム(依頼)
  OK   起票フォーム(エラー表示)

検査した画面: 6

OK: WCAG 2.2 AA の自動検査で違反はありません
```

GA-5 は「Portal主要4画面」を求めているが、**エラー表示の状態も含めて6画面**を検査した。
エラー表示は最も見落とされやすい状態であり、通常表示だけ検査しても
「入力を間違えた利用者が困らない」ことの根拠にはならない。

## 4. 検査器が実際に違反を検出できることの確認

**常に通る検査は無意味である。** WP-P1-OBS-005 では計器を定義したものの
配線が繋がっておらず、記録が黙って捨てられていた。同じ形の欠陥を作らないため、
意図的に違反を作って検出されることを確かめた。

ログイン画面へ次の2つを一時的に追加した。

1. ラベルのない `<input type="text">`
2. コントラスト比 1.61 の文字(`#c9ccd1` on `#ffffff`)

結果:

```
  NG   ログイン — 2 件
         [serious] color-contrast: Elements must meet minimum color contrast ratio thresholds
           .stack > p
             Element has insufficient color contrast of 1.61 ... Expected contrast ratio of 4.5:1
         [critical] label: Form elements must have labels
           input[name="deliberately_unlabeled"]
             Element does not have an explicit <label>
```

両方とも検出された。確認後、意図的な違反は元に戻してある
(`git diff` に残っていないことを確認済み)。

## 5. 未検査を「合格」と書かない

認証が必要な画面は資格情報が無いと検査できない。
その場合、スクリプトは**未検査の画面がある旨を出して非0で終了する**。

検査できていない画面は「違反が無い」ことの根拠にならない。
一部だけ検査して「OK」と表示すると、その表示自体が誤った安心を与える。

## 6. この結果が意味しないこと

> [!important] violation 0 は「合格」ではなく「最低限の水準を割っていない」である
> 自動検査で見つかるのはアクセシビリティ問題の一部にすぎない。
> **読み上げ順序の妥当性、文言の分かりやすさ、操作の分かりやすさは
> 人が確かめる必要がある**(Gate A GA-4: 初見5名中4名以上がガイドなしで送信完了)。
>
> GA-4 は実利用者が必要なため未実施のままである。

## 7. 実行方法

```bash
docker compose up -d api web
A11Y_EMAIL=... A11Y_PASSWORD=... A11Y_ORG=... npm run check:a11y
```

`check:all` には含めていない。稼働中のスタックを要求するため、
混ぜるとスタックを上げていない人の手元で常に落ちることになる。
