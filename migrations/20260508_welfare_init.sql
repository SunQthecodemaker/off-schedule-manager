-- 진료비 복지 시스템 초기 스키마 (welfare_*)
-- Apps Script 의 시트 5탭(Config, Employees, Records, Admins, AuditLog) → offapp Supabase 로 통합.
-- 권한/staging 모델은 기존 offapp 패턴(employees.role, employees.isManager,
-- employees.manager_permissions, pending_changes) 을 그대로 재사용한다.
--
-- 핵심 변경점:
--   기존 Apps Script 잔액 = 기준금액 - (월차감액 × 시작일~오늘 경과 개월수)
--   변경 후     잔액 = 기준금액 - (월차감액 × 이행 인정된 개월수)
--   → 매니저가 매월 말 직원별 이행 여부를 체크하고, 관리자 승인(pending_changes) 후 반영.

-- ============================================================
-- 1) welfare_config : 진료비 산정 파라미터 (key/value)
-- ============================================================
CREATE TABLE IF NOT EXISTS welfare_config (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz DEFAULT now()
);

INSERT INTO welfare_config (key, value) VALUES
    ('SELF_RATE_EMP', '30'),
    ('SELF_RATE_FAM', '50'),
    ('PRE_CAP_EMP',   '35'),
    ('PRE_CAP_FAM',   '25'),
    ('CLINIC_NAME',   '프라임S치과')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE welfare_config IS
    '진료비 복지 산정 기준 (의무 부담률, 근속 차감 상한, 병원명 등)';

-- ============================================================
-- 2) welfare_records : 진료비 동의서 + 진료기록 (Apps Script Records 시트 대응)
-- ============================================================
CREATE TABLE IF NOT EXISTS welfare_records (
    id                bigserial PRIMARY KEY,
    employee_id       bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    relation_type     text   NOT NULL,
    patient_name      text,
    treatment_type    text   NOT NULL,
    treatment_details text,
    total_fee         int    NOT NULL CHECK (total_fee > 0),
    start_date        date   NOT NULL,
    pre_tenure_months int    NOT NULL DEFAULT 0,
    consent_sig_path  text,
    status            text   NOT NULL DEFAULT 'Active',
    resign_date       date,
    created_at        timestamptz DEFAULT now(),
    created_by        bigint REFERENCES employees(id),
    CONSTRAINT welfare_records_relation_chk
        CHECK (relation_type IN ('직원','가족')),
    CONSTRAINT welfare_records_treatment_chk
        CHECK (treatment_type IN ('A-Type','B-Type')),
    CONSTRAINT welfare_records_status_chk
        CHECK (status IN ('Active','Settled')),
    CONSTRAINT welfare_records_family_patient_chk
        CHECK (
            relation_type = '직원'
            OR (relation_type = '가족' AND patient_name IS NOT NULL AND patient_name <> '')
        )
);

CREATE INDEX IF NOT EXISTS idx_welfare_records_employee
    ON welfare_records(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_welfare_records_status
    ON welfare_records(status);

COMMENT ON TABLE  welfare_records IS '직원 복지 진료비 동의서/진료기록';
COMMENT ON COLUMN welfare_records.consent_sig_path IS
    'Storage 경로 (예: welfare/signatures/{id}.png in bucket "docs")';
COMMENT ON COLUMN welfare_records.pre_tenure_months IS
    '동의서 작성 시점의 근속 개월수 (스냅샷, 추후 입사일 변경되어도 고정)';

-- ============================================================
-- 3) welfare_monthly_fulfillment : 월별 이행 체크 (조건부 차감 핵심)
-- ============================================================
-- 잔액 인정 = 월차감액 × COUNT(fulfilled = true)
-- 매니저가 매월 말 일괄 체크 → pending_changes 임시저장 → 관리자 승인 시 본 테이블 반영.
CREATE TABLE IF NOT EXISTS welfare_monthly_fulfillment (
    id          bigserial PRIMARY KEY,
    record_id   bigint NOT NULL REFERENCES welfare_records(id) ON DELETE CASCADE,
    year_month  text   NOT NULL,
    fulfilled   boolean NOT NULL DEFAULT false,
    verified_by bigint REFERENCES employees(id),
    verified_at timestamptz,
    note        text,
    UNIQUE (record_id, year_month),
    CONSTRAINT welfare_fulfillment_ym_chk
        CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

CREATE INDEX IF NOT EXISTS idx_welfare_fulfillment_record
    ON welfare_monthly_fulfillment(record_id);
CREATE INDEX IF NOT EXISTS idx_welfare_fulfillment_month
    ON welfare_monthly_fulfillment(year_month);

COMMENT ON TABLE welfare_monthly_fulfillment IS
    '월별 약속 이행 체크. fulfilled=true 인 개월수만 잔액 차감 인정.';
COMMENT ON COLUMN welfare_monthly_fulfillment.year_month IS 'YYYY-MM 형식';

-- ============================================================
-- 4) welfare_audit_log : 변경 자동 기록 (offapp 에 없던 기능, 신규 추가)
-- ============================================================
CREATE TABLE IF NOT EXISTS welfare_audit_log (
    id          bigserial PRIMARY KEY,
    table_name  text NOT NULL,
    record_id   bigint,
    action      text NOT NULL,
    before_data jsonb,
    after_data  jsonb,
    actor_id    bigint,
    occurred_at timestamptz DEFAULT now(),
    CONSTRAINT welfare_audit_action_chk
        CHECK (action IN ('INSERT','UPDATE','DELETE'))
);

CREATE INDEX IF NOT EXISTS idx_welfare_audit_record
    ON welfare_audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_welfare_audit_occurred
    ON welfare_audit_log(occurred_at DESC);

COMMENT ON TABLE welfare_audit_log IS
    '복지 테이블(welfare_records, welfare_monthly_fulfillment) 변경의 자동 기록.';

-- ============================================================
-- 5) 트리거 : welfare_records, welfare_monthly_fulfillment 변경 → audit_log 자동 적재
-- ============================================================
-- 클라이언트는 트랜잭션 시작 직전에 다음 한 줄을 실행해 actor 를 알린다:
--   SELECT set_config('welfare.actor_id', '<employees.id>', true);
-- 미설정 시 actor_id 는 NULL 로 기록(시스템/배치성 변경).
CREATE OR REPLACE FUNCTION welfare_audit_trigger() RETURNS trigger AS $$
DECLARE
    v_actor bigint;
BEGIN
    BEGIN
        v_actor := NULLIF(current_setting('welfare.actor_id', true), '')::bigint;
    EXCEPTION WHEN OTHERS THEN
        v_actor := NULL;
    END;

    IF (TG_OP = 'INSERT') THEN
        INSERT INTO welfare_audit_log(table_name, record_id, action, after_data, actor_id)
        VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', to_jsonb(NEW), v_actor);
        RETURN NEW;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO welfare_audit_log(table_name, record_id, action, before_data, after_data, actor_id)
        VALUES (TG_TABLE_NAME, NEW.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), v_actor);
        RETURN NEW;
    ELSIF (TG_OP = 'DELETE') THEN
        INSERT INTO welfare_audit_log(table_name, record_id, action, before_data, actor_id)
        VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', to_jsonb(OLD), v_actor);
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_welfare_records_audit ON welfare_records;
CREATE TRIGGER trg_welfare_records_audit
    AFTER INSERT OR UPDATE OR DELETE ON welfare_records
    FOR EACH ROW EXECUTE FUNCTION welfare_audit_trigger();

DROP TRIGGER IF EXISTS trg_welfare_fulfillment_audit ON welfare_monthly_fulfillment;
CREATE TRIGGER trg_welfare_fulfillment_audit
    AFTER INSERT OR UPDATE OR DELETE ON welfare_monthly_fulfillment
    FOR EACH ROW EXECUTE FUNCTION welfare_audit_trigger();

-- ============================================================
-- 6) RLS : 인증된 사용자만 접근(offapp 표준). 세부 권한은 클라이언트(employees.role/isManager) 분기.
-- ============================================================
ALTER TABLE welfare_config              ENABLE ROW LEVEL SECURITY;
ALTER TABLE welfare_records             ENABLE ROW LEVEL SECURITY;
ALTER TABLE welfare_monthly_fulfillment ENABLE ROW LEVEL SECURITY;
ALTER TABLE welfare_audit_log           ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS welfare_config_auth          ON welfare_config;
DROP POLICY IF EXISTS welfare_records_auth         ON welfare_records;
DROP POLICY IF EXISTS welfare_fulfillment_auth     ON welfare_monthly_fulfillment;
DROP POLICY IF EXISTS welfare_audit_read           ON welfare_audit_log;

CREATE POLICY welfare_config_auth          ON welfare_config              FOR ALL    TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY welfare_records_auth         ON welfare_records             FOR ALL    TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY welfare_fulfillment_auth     ON welfare_monthly_fulfillment FOR ALL    TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY welfare_audit_read           ON welfare_audit_log           FOR SELECT TO authenticated USING (true);
-- audit_log 는 트리거 외 직접 INSERT/UPDATE/DELETE 금지 → SELECT 만 허용.

-- ============================================================
-- 7) pending_changes 와의 관계 (참고용 주석)
-- ============================================================
-- 매니저가 신규 동의서 작성/이행 체크/삭제 등을 시도하면 클라이언트는
-- pending_changes 에 다음 entity_type 으로 임시저장한다 (관리자 승인 후 반영):
--   'welfare_record'      : welfare_records  의 INSERT/UPDATE/DELETE
--   'welfare_fulfillment' : welfare_monthly_fulfillment 의 UPSERT
-- 관리자(employees.role='admin')는 곧바로 본 테이블에 INSERT/UPDATE 가능.
