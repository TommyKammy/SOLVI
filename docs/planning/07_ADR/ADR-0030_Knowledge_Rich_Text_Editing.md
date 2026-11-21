---
project: "SOLVI"
doc_id: "ADR-0030"
title: "Tiptap 3によるナレッジ記事の編集と本文形式"
category: "07_ADR"
type: "adr"
status: "accepted"
version: "0.6.0"
created: "2026-11-20"
updated: "2026-11-21"
owner: "SOLVI Product Team"
tags: ["adr", "knowledge", "editor", "security"]
source_of_truth: true
implementation_status: "in-progress"
---

# ADR-0030 Tiptap 3によるナレッジ記事の編集と本文形式

## Status

2026-11-21、利用者は試作と同じ固定依存でローカル組み込みを先行することを承認。人によるセキュリティ確認はマージ前に行う。日本語IME実機はスキップ済み。

## Context

現行の `KnowledgeEditor.tsx` は本文を最大20,000文字のテキストとして扱う。PostgreSQLの `knowledge_version` は版ごとに不変で、APIはレビュー・公開・復元でも本文を複製する。依頼者向け検索・抜粋は公開版の本文を使う。記事作成画面を変更すると、閲覧者に表示される版、旧記事の文字列、過去版の復元にも影響する。根拠は [[03.4_Knowledge_Requirements]]、[[WP-P3-KNWUI-060]]、`db/migrations/0025_knowledge.sql`、`services/api/src/modules/knowledge/`（調査時のmainは `1af5527`）。

担当者は日本語IMEで手順を書き、必要な箇所をHTMLで直し、テンプレートから記事を起こす。TiptapはHTMLをスキーマに沿った文書へ取り込むため、未対応要素が消えた後の文書だけでは、入力時の欠落を検出できない。候補選択中のEnterやフォーカス移動も、Webの自動操作だけでは評価しきれない。この2点を採否の中心に置く。[Tiptapのスキーマ](https://tiptap.dev/docs/editor/core-concepts/schema)

## Decision

次の構成を採用する。

1. **編集エンジン**はセルフホストのTiptap 3 OSS版とする。React連携、ProseMirror、本文に必要な拡張に絞る。最初の試作で実際の直接・推移依存、固定バージョン、ライセンス、更新履歴、既知の保守上の懸念を記録する。エディタは編集画面だけで読み込み、閲覧者用の表示は静的な部品で構成する。[公式リポジトリ](https://github.com/ueberdosis/tiptap) · [Next.js導入手順](https://tiptap.dev/docs/editor/getting-started/install/nextjs) · [リリース履歴](https://github.com/ueberdosis/tiptap/releases)
2. **本文で表せる内容**は、段落、改行、見出し2・3、太字、斜体、順序付き・順序なしリストとその入れ子、リンク、インラインコード、コードブロック、各行の列数が等しい表とする。記事タイトルが見出し1を担う。初版のリンクは絶対HTTPS URLを許可し、利用者が指定できるリンク属性は `href` のみとする。太字・斜体の別名、文字参照、属性の引用符は正規化する。コード内の空白・改行とリンク先の値は保持する。
3. **HTMLソース**は本文断片を直接編集できる独立した入力欄とする。「適用」で元ソースを検査し、エラーなら入力と直前の文書を保持して箇所・理由を示す。入力の欠落を伴う構文補正・未対応タグ・属性はこの段階で拒否する。貼り付け、テンプレート、ソース適用、API入力に同じ文書制約を適用する。未適用の変更がある間は保存・レビューを保留する。採用条件は意味の往復と正規化後の安定性であり、HTML原文の字面を保つ用途は別途判断する。
4. **永続化**は形式版付きの構造化JSONとする。製品導入時は記事版と同じPostgreSQLトランザクションで保存し、その版からサーバーが導出したプレーンテキストを `body` に保持する。検索・抜粋・既存読み取りに使い、検索文字列を独立した編集対象にしない。可視本文20,000文字の数え方（絵文字・改行を含む）とJSONの容量・深さ上限は、現行Web/API/DBの差を考慮して後続WPで境界値を決める。[Tiptapの保存形式](https://tiptap.dev/docs/editor/core-concepts/persistence)
5. **テンプレート**は本文と同じ形式で管理し、選んだ版の本文を新しい下書きに複製する。閲覧範囲は作成画面で明示する。テンプレートを改訂・廃止しても、作成済みの記事に変更は波及しない。今回の検証では操作手順のひな形を使う。標準テンプレートの提供と組織別管理は各段階のWPで扱う。

## Consequences

- 担当者・レビュー担当・依頼者が同じ本文構造を見る。表現差を機械照合でき、過去版・テンプレートにも同じ表示規則を適用できる。
- SOLVIがツールバー、日本語入力中の状態管理、元HTMLの検証、静的レンダラー、形式版の互換性を保守する。エディタ拡張を更新するたびに同じ記事で再検証する。セル結合・画像・任意CSSが必要になれば、データ形式と表示・安全性を併せて再審査する。

## Rejected Alternatives

| 比較案 | 今回の判断理由 |
|---|---|
| TinyMCE | 基本のソース編集を備え、実装量を抑えられる。セルフホストのライセンス選択と公式テンプレートの有償条件が導入判断に加わる。Tiptapで操作性を満たせない場合の再比較候補。[Code](https://www.tiny.cloud/docs/tinymce/latest/code/) · [ライセンス](https://www.tiny.cloud/docs/tinymce/latest/license-key/) · [Templates](https://www.tiny.cloud/docs/tinymce/latest/advanced-templates/) |
| CKEditor 5 | 基本のソース編集に対応するが、取り込み後に文書が正規化される点は同じ。GPLまたは商用ライセンス、公式テンプレートの提供条件を含めて評価する必要がある。[ソース編集](https://ckeditor.com/docs/ckeditor5/latest/features/source-editing/source-editing.html) · [ライセンス](https://ckeditor.com/docs/ckeditor5/latest/getting-started/licensing/license-and-legal.html) · [Templates](https://ckeditor.com/docs/ckeditor5/latest/features/template.html) |
| Lexical | MITでReactとHTML入出力に対応する。今回の範囲では、記事の構造を宣言するスキーマとNext.js向け公式手順を評価してTiptapを優先した。[Lexical公式](https://github.com/meta/lexical) |
| HTML原文を保存し表示 | 原文の保持には有利だが、閲覧・復元など各経路に安全な表示処理が必要になる。過去のプレーンテキストとの識別も必要で、直接編集だけでは採用理由にならない。 |

## Security Impact

[[02.14_Threat_Model]] T-27、[[ADR-0027_Browser_Security_Headers]] を適用する。ソースは未信頼の文字列として保持し、検証前にライブDOMへ挿入しない。サーバーは直接送られたJSONもノード・マーク・属性・URLの許可リストで検証する。プレビューと公開相当画面は許可済み文書から同じ描画規則を使う。組織境界、管理者による公開、版競合の判定、本文を含めない監査記録は既存のナレッジ境界に従う。[[ADR-0015_Organization_Isolation_and_RLS]]、[[ADR-0009_Append_Only_Audit]] を参照する。

## Operational Impact

編集エンジンの読込失敗時は保存操作を止め、保存済みの版を引き続き読めるようにする。製品導入時は、読取対応を先行配布してから新形式の書込みを有効にする。障害時は書込みを停止して読取互換を維持する。

## Migration Impact

段階1は隔離試作のみでMigrationはない。製品導入時は追加型Migrationを別WPで設計する。既存の本文はテキストとして読む。過去の不変版を一括変換せず、編集によって新しい下書きを作る時点で形式を明示する。レビュー・公開・復元は元版の形式を引き継ぎ、チケットの引用は既存の記事ID・版を指し続ける。旧形式の書込みクライアントによる書式消失、新形式を含むDBでのロールバックを互換試験に含める。

## 製品の固定依存

`@tiptap/core` と `@tiptap/starter-kit` は編集とAPIで共通の文書スキーマを構成する。`@tiptap/pm` は選択・履歴・ブロック移動、`@tiptap/react` は既存のReact画面との接続、`@tiptap/suggestion` はスラッシュコマンドに使う。いずれも公式OSS版3.34.0、MIT。個別のProseMirrorパッケージを組み合わせる案に比べ、React連携と候補・選択処理の自前実装を減らせる。[Tiptap公式リリース](https://github.com/ueberdosis/tiptap/releases/tag/v3.34.0)

HTML取り込みには `parse5@8.1.1`（MIT）を使う。元ソースの位置を取り、ブラウザのHTMLパーサーによる暗黙の補正で内容が失われる前に要素・属性を検査できる。製品のlockfileで追加した54パッケージパスはMIT 53件とBSD-2-Clause 1件。後者は `entities`。[parse5の保守元](https://github.com/inikulin/parse5)

## Verification

ローカルの先行試作 WP-P3-KNWUI-061 で操作仕様を受け入れた。製品経路の判定は [[WP-P3-KNWUI-062]] §7 のP1〜P6を用いる。Chromium・WebKitのHTML3往復、公開・引用版の照合、入力拒否、旧形式との互換、ロールバックを検証した。日本語IME実機は未判定。[製品の検証記録](../../../evidence/WP-P3-KNWUI-062/README.md)

## Follow-up

ローカルの保存・版互換・編集画面・標準手順テンプレートは [[WP-P3-KNWUI-062]] で扱う。組織別テンプレート管理は後続候補。主要依存の更新、許可するタグ・属性・URL範囲の拡張、本文形式版の変更時は、影響する採用試験を再実施する。
