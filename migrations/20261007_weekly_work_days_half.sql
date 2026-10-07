-- 주 근무일수 0.5일 단위 허용 (예: 토요일 반일 = 주 4.5일)
-- 2026-10-07 Management API 로 운영 DB 에 적용 완료.
alter table public.employees
    alter column weekly_work_days type numeric(3,1) using weekly_work_days::numeric(3,1);
alter table public.employees
    alter column weekly_work_days set default 5;
notify pgrst, 'reload schema';
