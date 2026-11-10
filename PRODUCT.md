# SOLVI Product Context

このファイルは UI 作業の補助資料です。設計の正本は `docs/planning/` です。
根拠: README、03.3_Ticket_Requirements、03.13_UX_Accessibility_Requirements、既存ポータル実装。

## Register

product

## Users

日本語で IT 支援を依頼する社員と、問い合わせを処理する IT 担当者。
社員は申告と進捗確認、担当者は割当・返信・状態更新を行う。

## Product Purpose

Freshservice の利用範囲を自作 ITSM に段階的に移す。今回の対象はローカルで申告から解決まで試せるチケット業務。

## Brand Personality

既存 UI の簡潔で行動を直接表す日本語を踏襲する。読みやすく、落ち着きがあり、操作結果が明瞭な画面。
正式なブランド再設計は今回の対象外。

## Anti-references

色だけの状態表示、利用者に内部 ID を入力させるフォーム、失敗時に入力が消える画面、未実装機能を操作できるように見せるメニュー。

## Design Principles

- 社員の申告と担当者の処理をそれぞれの業務に合わせる。
- ボタンには操作後に起きることを書く。
- エラーでは入力を保持し、次にできる操作を伝える。
- 表示する情報は API の認可と保存済みの状態に基づく。
- 既存の色・書体・フォームの一貫性を保つ。

## Accessibility & Inclusion

要求は WCAG 2.2 AA 相当。ラベル、キーボード操作、見えるフォーカス、エラー要約、色だけに依存しない状態表示を維持する。
自動検査の通過は Evidence がある範囲だけで報告する。
