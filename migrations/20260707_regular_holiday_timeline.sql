-- 정기휴무 효력일 이력 (언제부터 규칙 변경) 지원
-- 각 항목: { "from": "YYYY-MM-DD", "rules": [{"day":n,"sub":bool,"weeks"?:[..]}] }
-- from <= 대상날짜 중 가장 최근 항목의 rules 가 그 날짜에 적용됨.
-- 빈 배열([]) = 이력 없음 → 코드가 기존 regular_holiday_rules(현재값 포인터)로 폴백.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS regular_holiday_timeline jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.employees.regular_holiday_timeline IS
  '정기휴무 효력일 이력. [{from:YYYY-MM-DD, rules:[{day,sub,weeks?}]}]. from<=날짜 중 최신 적용. []=regular_holiday_rules 폴백.';
