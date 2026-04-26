-- 매니저가 5개 메뉴(서류 검토 / 연차 관리 / 직원 관리 / 부서 관리 / 서식 관리)에서
-- 수정한 내용은 즉시 DB에 반영되지 않고 이 테이블에 임시저장(staging)된다.
-- 관리자가 상단 일괄 승인 배너에서 [전체 승인] / [개별 승인] 누르면 실제 테이블에 반영.

CREATE TABLE IF NOT EXISTS pending_changes (
    id bigserial PRIMARY KEY,
    entity_type text NOT NULL,
    entity_id bigint,
    action text NOT NULL,
    payload jsonb NOT NULL,
    original_snapshot jsonb,
    created_by bigint NOT NULL,
    created_at timestamptz DEFAULT now(),
    status text NOT NULL DEFAULT 'pending',
    reviewed_by bigint,
    reviewed_at timestamptz,
    rejection_reason text,
    CONSTRAINT pending_changes_action_chk CHECK (action IN ('create','update','delete')),
    CONSTRAINT pending_changes_status_chk CHECK (status IN ('pending','approved','rejected'))
);

CREATE INDEX IF NOT EXISTS idx_pending_changes_status ON pending_changes(status);
CREATE INDEX IF NOT EXISTS idx_pending_changes_entity ON pending_changes(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_pending_changes_created_by ON pending_changes(created_by);
