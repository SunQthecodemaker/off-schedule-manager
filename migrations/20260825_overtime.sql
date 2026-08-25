-- 2026-08-25 초과근무(오버타임) 기록 — 구글시트 "2026_오버타임관리" 를 앱으로 이행
--
-- 배경: 진료가 늦게 끝나 남은 직원이 종이/구두로 기록을 남기면, 나중에 누군가 모아서
--       월별 시트에 옮겨 적고(좌측 기록부) 직원별 합계를 손으로 집계했다(우측 집계표).
--       옮겨 적는 과정에서 누락·오기가 생기고, 무엇이 확인된 기록인지 구분이 없었다.
--
-- 모델: 직원 본인이 그 자리에서 제출 → 매니저 1차 확인 → 원장 최종 확정.
--       집계표에는 "원장이 최종 확정한 것만" 잡힌다. 연차와 동일한 결재 패턴을 그대로 쓴다
--       (매니저 승인 = pending_changes staging, 매니저 반려 = 즉시 확정).
--
-- 분(minutes) 계산: 진료완료 시각에서 그날의 마감시각을 뺀 값.
--       마감시각 후보는 app_settings.overtime_cutoffs 에 두고, 입력 시각 이하의 가장 늦은 것을
--       자동으로 고른다 (21:31 → 21:00 기준 31분 / 15:34 → 15:00 기준 34분).
--       시트에 19:20 → 80분 같은 예외가 실재하므로 자동값은 어디까지나 초기값이고,
--       직원이 고칠 수 있으며 원장이 승인 직전에 다시 조정할 수 있다.
--       auto_minutes 를 함께 남겨 "손으로 고친 기록"을 사후에 구분할 수 있게 한다.

create table if not exists overtime_records (
    id                    bigserial primary key,
    employee_id           bigint not null references employees(id) on delete cascade,
    employee_name         text   not null,
    work_date             date   not null,
    end_time              text   not null,
    minutes               integer not null,
    auto_minutes          integer,
    cutoff_time           text,
    patient               text,
    doctor                text,
    note                  text,
    status                text   not null default 'pending',
    middle_manager_status text   not null default 'pending',
    middle_manager_id     bigint references employees(id),
    middle_manager_at     timestamptz,
    reviewed_by           bigint references employees(id),
    reviewed_at           timestamptz,
    reject_reason         text,
    created_at            timestamptz default now(),
    updated_at            timestamptz default now(),
    constraint overtime_records_minutes_chk  check (minutes > 0 and minutes <= 720),
    constraint overtime_records_status_chk   check (status in ('pending','approved','rejected')),
    constraint overtime_records_middle_chk   check (middle_manager_status in ('pending','approved','rejected')),
    constraint overtime_records_endtime_chk  check (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

-- 같은 직원이 같은 날 같은 완료시각으로 두 번 제출하는 것(중복 클릭·재제출)을 막는다.
-- 반려된 건은 제외 — 반려 후 같은 시각으로 고쳐 다시 내는 길은 열어둔다.
create unique index if not exists uniq_overtime_active
    on overtime_records(employee_id, work_date, end_time)
    where status <> 'rejected';

create index if not exists idx_overtime_month
    on overtime_records(work_date desc, employee_id);
create index if not exists idx_overtime_employee
    on overtime_records(employee_id, work_date desc);
create index if not exists idx_overtime_status
    on overtime_records(status) where status = 'pending';

comment on table  overtime_records is
    '초과근무 기록 — 직원 본인 제출 → 매니저 1차 → 원장 최종. 집계는 status=approved 만 합산';
comment on column overtime_records.employee_name is
    '제출 시점의 이름 스냅샷 (leave_requests 와 동일 관례). 조회는 employee_id 기준';
comment on column overtime_records.end_time is
    '진료완료 시각 HH:MM. 시트의 "진료완료 시각" 칸';
comment on column overtime_records.minutes is
    '확정 추가근무 분. 자동계산값에서 직원 또는 원장이 고쳤을 수 있다 (auto_minutes 와 비교하면 수정 여부를 안다)';
comment on column overtime_records.auto_minutes is
    'end_time - cutoff_time 자동계산값. NULL = 마감시각 후보보다 이른 시각이라 자동계산 불가(직원 직접 입력)';
comment on column overtime_records.cutoff_time is
    '자동계산에 쓴 마감시각 HH:MM. 나중에 마감시각 설정이 바뀌어도 당시 기준을 알 수 있게 남긴다';
comment on column overtime_records.middle_manager_status is
    '매니저 1차 판정. 승인은 pending_changes(overtime_approval) 로 가고 반려는 즉시 확정 (연차와 동일)';

-- updated_at 자동 갱신
create or replace function overtime_records_touch() returns trigger as $$
begin
    new.updated_at := now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_overtime_records_touch on overtime_records;
create trigger trg_overtime_records_touch
    before update on overtime_records
    for each row execute function overtime_records_touch();

-- RLS: 다른 테이블과 동일 정책 (내부용 앱 — 직원 로그인이 RPC 기반이라 클라이언트는 anon).
-- 실제 가시성·권한은 클라이언트 계층(employee_id 필터, getManagerPerm, shouldStage)이 담당.
alter table overtime_records enable row level security;

drop policy if exists overtime_records_anon on overtime_records;
drop policy if exists overtime_records_auth on overtime_records;

create policy overtime_records_anon on overtime_records for all to anon          using (true) with check (true);
create policy overtime_records_auth on overtime_records for all to authenticated using (true) with check (true);

-- 마감시각 후보 (원장이 초과근무 관리 화면에서 변경). 입력 시각 이하의 가장 늦은 값이 그날의 기준.
insert into app_settings (key, value, updated_at)
select 'overtime_cutoffs', to_jsonb(array['15:00','19:00','21:00']), now()
where not exists (select 1 from app_settings where key = 'overtime_cutoffs');
