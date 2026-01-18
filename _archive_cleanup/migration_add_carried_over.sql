-- employees 테이블에 이월 연차(carried_over_leave) 컬럼 추가
-- 기본값은 0으로 설정

ALTER TABLE employees 
ADD COLUMN IF NOT EXISTS carried_over_leave float DEFAULT 0;

COMMENT ON COLUMN employees.carried_over_leave IS '전년도에서 이월된 연차 일수';
