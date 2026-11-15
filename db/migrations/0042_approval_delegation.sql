-- WP-P4-APR-020 (段階A) / ADR-0025 §1〜§5, WP §6.1. 代理承認の委任と、代理で決定したステップの記録。
--
-- 方針:
--  - 委任は「承認者本人が、期間を限って、自分宛ての承認を別の人へ任せる」記録である。
--    作成できるのは本人だけ(dp.API が委任者のIDを入力から受け取らない)。
--  - 承認の権限の付与と同格の特権操作であるため、追記専用に準じる:
--    DELETE を拒否し、UPDATE は取消の3列(revoked_at / revoked_by / revoke_reason)を
--    NULL から一度だけ埋める場合に限って許す。ほかの列は変えられない。
--  - 同じ委任者の、取り消されていない委任の期間は重ならない(代理者は同時に1人)。
--    `btree_gist` を追加しないため、**委任者単位の助言ロック**(pg_advisory_xact_lock)で
--    直列化してから検査する。API も同じ鍵でロックしてから事前検査する(二重の防御)。
--    助言ロックはトランザクション終了で解放される。ロックは委任者の行ではなく
--    「組織 + 委任者」の鍵なので、委任者を消す・作り直す操作とも直列化される。
--  - 組織境界は複合外部キー(他組織の利用者・委任を参照できない)と
--    RLS(ENABLE + FORCE、organization_id = app_current_org())で守る。RLS は第二層である。
--  - `local_request_approval.delegation_id` は代理で決定したステップにだけ入る。
--    CHECK で「委任のIDがあるなら決定者があり、承認者と異なる」を強制する。
--    既存の行は NULL のまま(バックフィルしない)。
--  - down は、委任の行、または `delegation_id` を持つステップが1件でもあれば拒否する
--    (0036〜0041 と同じ前進修復)。
-- +migrate up

CREATE TABLE approval_delegation (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  -- 委任者(自分宛ての承認を任せる人)と代理者(任される人)。
  delegator_id uuid NOT NULL,
  delegate_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz NULL,
  revoked_by uuid NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  revoke_reason text NULL,
  -- 複合外部キーの参照先。委任のIDと組織を切り離せなくする。
  CONSTRAINT approval_delegation_id_org_key UNIQUE (id, organization_id),
  -- 利用者への外部キーは組織を含む既存の流儀(org_member_profile)に合わせる。
  -- 行の存在は所属の証明ではない(ADR-0023 §1)。資格はAPIとRLSの外側で毎回判定する。
  CONSTRAINT approval_delegation_delegator_fk
    FOREIGN KEY (delegator_id, organization_id)
    REFERENCES org_member_profile (user_id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT approval_delegation_delegate_fk
    FOREIGN KEY (delegate_id, organization_id)
    REFERENCES org_member_profile (user_id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT approval_delegation_distinct_users CHECK (delegator_id <> delegate_id),
  CONSTRAINT approval_delegation_period_order CHECK (ends_at > starts_at),
  -- 期間は最長30日。延長は新しい委任を作る(ADR-0025 §3)。
  CONSTRAINT approval_delegation_period_max
    CHECK (ends_at <= starts_at + interval '30 days'),
  -- 取消の3列はすべて NULL かすべて非 NULL。片方だけの行は検証できない。
  CONSTRAINT approval_delegation_revocation_pair CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  CONSTRAINT approval_delegation_revoke_reason_length
    CHECK (revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 1 AND 2000),
  -- 取消は作成より前にならない(時計の巻き戻しで「作成前に取り消した」記録を作らない)。
  CONSTRAINT approval_delegation_revoke_order
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX approval_delegation_delegator_idx
  ON approval_delegation (organization_id, delegator_id, starts_at, ends_at);
CREATE INDEX approval_delegation_delegate_idx
  ON approval_delegation (organization_id, delegate_id, starts_at, ends_at);
COMMENT ON TABLE approval_delegation IS
  '承認の委任(ADR-0025)。委任者本人だけが作り、取消は記録を一度だけ埋める。append-only に準じる。';
COMMENT ON COLUMN approval_delegation.delegator_id IS
  '委任者。ステップの approver_id と一致する場合にだけ、この委任が効く。';
COMMENT ON COLUMN approval_delegation.delegate_id IS
  '代理者。決定の時点で有効な所属かつ approver ロールを持つことを毎回検証する(ADR-0025 §2)。';
COMMENT ON COLUMN approval_delegation.revoke_reason IS
  '取消の理由(必須・2000文字以内)。取消のときに一度だけ書く。';

-- ---------------------------------------------------------------- 追記専用と重なりの防止

CREATE FUNCTION approval_delegation_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval_delegation_immutable: rows cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- 取消は一度だけ。書き換え・取り消しの取り消しは拒否する。
    IF OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'approval_delegation_immutable: revocation cannot be rewritten'
        USING ERRCODE = 'check_violation';
    END IF;
    -- 変えてよいのは取消の3列だけ。委任者・代理者・期間・作成者は不変である。
    IF NEW.id <> OLD.id
       OR NEW.organization_id <> OLD.organization_id
       OR NEW.delegator_id <> OLD.delegator_id
       OR NEW.delegate_id <> OLD.delegate_id
       OR NEW.starts_at <> OLD.starts_at
       OR NEW.ends_at <> OLD.ends_at
       OR NEW.created_by <> OLD.created_by
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'approval_delegation_immutable: only the revocation columns can change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revoke_reason IS NULL THEN
      RAISE EXCEPTION 'approval_delegation_immutable: revocation must fill all three columns'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- 作成の時点で取消済みの行は作れない(取消は UPDATE だけ)。
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
    RAISE EXCEPTION 'approval_delegation_immutable: revoke through update, not insert'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 同じ委任者の、取り消されていない委任の期間の重なりを防ぐ。
  -- 排他制約(btree_gist)を足さないため、委任者単位の助言ロックで直列化してから検査する。
  -- 鍵は「組織 + 委任者」。同じトランザクション内の再取得は再入可能である。
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'approval_delegation:' || NEW.organization_id::text || ':' || NEW.delegator_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM approval_delegation d
     WHERE d.organization_id = NEW.organization_id
       AND d.delegator_id = NEW.delegator_id
       AND d.revoked_at IS NULL
       AND tstzrange(d.starts_at, d.ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'approval_delegation_overlap: delegator already has an overlapping delegation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER approval_delegation_guard_insert
  BEFORE INSERT ON approval_delegation
  FOR EACH ROW EXECUTE FUNCTION approval_delegation_guard();

CREATE TRIGGER approval_delegation_guard_update
  BEFORE UPDATE ON approval_delegation
  FOR EACH ROW EXECUTE FUNCTION approval_delegation_guard();

CREATE TRIGGER approval_delegation_guard_delete
  BEFORE DELETE ON approval_delegation
  FOR EACH ROW EXECUTE FUNCTION approval_delegation_guard();

-- ---------------------------------------------------------------- ステップの記録

ALTER TABLE local_request_approval
  ADD COLUMN delegation_id uuid NULL;

ALTER TABLE local_request_approval
  -- 委任への複合外部キー。他組織の委任をステップに記録できない。
  ADD CONSTRAINT local_request_approval_delegation_fk
    FOREIGN KEY (delegation_id, organization_id)
    REFERENCES approval_delegation (id, organization_id) ON DELETE RESTRICT,
  -- 委任のIDは、代理で決定したステップにだけ入る。
  -- 決定者が無い行・決定者と承認者が同じ行には入れられない(ADR-0025 §4)。
  ADD CONSTRAINT local_request_approval_delegation_pair
    CHECK (delegation_id IS NULL OR (decided_by IS NOT NULL AND decided_by <> approver_id));

COMMENT ON COLUMN local_request_approval.delegation_id IS
  '代理で決定したときに使った委任(ADR-0025 §4)。委任者本人の決定と既存行は NULL。';

-- ---------------------------------------------------------------- RLS / GRANT

ALTER TABLE approval_delegation ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_delegation FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_delegation_isolation ON approval_delegation
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- DELETE は与えない(トリガでも拒否する)。UPDATE は取消の3列のためだけに必要である。
GRANT SELECT, INSERT, UPDATE ON approval_delegation TO solvi_app;
GRANT SELECT ON approval_delegation TO solvi_auditor;

-- +migrate down
-- Refuse a lossy rollback. Keep compatible readers and stop delegation writes instead.
-- A migrator without BYPASSRLS must fail instead of seeing a silently filtered zero count.
SET LOCAL row_security = off;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM approval_delegation)
     OR EXISTS (SELECT 1 FROM local_request_approval WHERE delegation_id IS NOT NULL) THEN
    RAISE EXCEPTION '0042 rollback refused: retain approval delegations and delegated step records';
  END IF;
END $$;
SET LOCAL row_security = on;

ALTER TABLE local_request_approval
  DROP CONSTRAINT local_request_approval_delegation_pair,
  DROP CONSTRAINT local_request_approval_delegation_fk,
  DROP COLUMN delegation_id;

DROP TRIGGER approval_delegation_guard_delete ON approval_delegation;
DROP TRIGGER approval_delegation_guard_update ON approval_delegation;
DROP TRIGGER approval_delegation_guard_insert ON approval_delegation;
DROP TABLE approval_delegation;
DROP FUNCTION approval_delegation_guard();
