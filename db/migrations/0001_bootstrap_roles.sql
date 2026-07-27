-- SOLVI 基盤: ロールとスキーマの初期化
-- WP-P1-PLAT-001
--
-- ADR-0015: アプリケーションは非owner・NOBYPASSRLS のロールで接続する。
-- ADR-0006: Executor は Core とは別のロールで接続する。
-- ここではロールの器だけを作り、テーブルへの権限付与は各テーブルの
-- マイグレーション側で明示的に行う(既定で広い権限を配らない)。

-- +migrate up

-- 拡張: uuid v7 相当の時系列順序を持つIDを使いたいが、pg16 標準にはないため
-- アプリ側で uuid v7 を生成し、DBは uuid 型として受ける。
-- gen_random_uuid() はフォールバック用途にのみ使用する。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- citext: メールアドレスの大文字小文字を区別しない比較のため
CREATE EXTENSION IF NOT EXISTS citext;
-- pg_trgm: 件名の部分一致検索(全文検索はWP-P2-SEARCH-006で別途)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
BEGIN
  -- アプリケーションロール(Core API / Worker)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solvi_app') THEN
    CREATE ROLE solvi_app LOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE solvi_app NOBYPASSRLS;
  END IF;

  -- Executor ロール(SOLVI Run)。Core とは別資格情報。
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solvi_executor') THEN
    CREATE ROLE solvi_executor LOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE solvi_executor NOBYPASSRLS;
  END IF;

  -- 監査閲覧ロール。将来 audit_event への SELECT のみを付与する(WP-P1-AUD-004)。
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solvi_auditor') THEN
    CREATE ROLE solvi_auditor NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- パスワードは環境変数から与える(SQLにハードコードしない / AGENTS.md §1.8)。
-- 開発環境では tools/bootstrap_roles.mjs が設定する。

-- GRANT ... ON DATABASE はデータベース名をリテラルで要求するため、
-- 環境ごとに異なる名前を current_database() から組み立てる。
DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO solvi_app, solvi_executor',
    current_database()
  );
END
$$;

GRANT USAGE ON SCHEMA public TO solvi_app, solvi_executor, solvi_auditor;

-- 既定の広い権限を配らない。PUBLIC からの生成権限を落とす。
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 以後 owner が作るテーブルの既定権限。
-- SELECT/INSERT/UPDATE/DELETE はテーブル単位で明示付与する方針のため、ここでは何も与えない。

-- +migrate down

-- ロールは他のデータベースからも参照されうるため DROP しない。
-- 巻き戻しでは権限のみ剥奪する。
REVOKE USAGE ON SCHEMA public FROM solvi_app, solvi_executor, solvi_auditor;
GRANT CREATE ON SCHEMA public TO PUBLIC;
