-- 2026-08-25 급연차 "연장 신청" — 한 사건 = 한 건
--
-- 배경: 병가로 급하게 연차를 쓴 뒤 호전이 안 돼 며칠 더 쉬는 경우, 지금은
--       "새 연차 신청"으로 갈 수밖에 없다. 그런데 임박 신청은 증빙 서류가
--       승인될 때까지 다음 신청을 막으므로(document_requests.status) 직원이 잠긴다.
--       게다가 우회해서 따로 신청하면 같은 병가에 증빙 요청이 2건 생긴다.
--
-- 해결: 연장분을 "다음 건"이 아니라 "이 건"으로 인식시킨다.
--   1) leave_requests.parent_request_id  — 연장분이 원 신청에 매달린다(체인의 뿌리를 가리킴)
--   2) document_requests.leave_request_id — 증빙 요청이 어느 연차 건에서 나왔는지
--      (지금은 message 텍스트로만 연결돼 있어 프로그램이 판정할 수 없다. 이게 예외 판정의 열쇠)
--
-- 잠금 규칙 자체는 변경 없음: 서류가 approved 되어야 다음(새) 건 신청 가능.
-- 연장은 새 건이 아니므로 잠금 대상 밖 — 유일한 예외 경로.

-- ⚠️ leave_requests 에 PK 가 없었다(id 는 identity·NOT NULL·중복 0 이지만 제약 미설정).
--    자기참조 FK 를 걸려면 참조 대상에 unique 제약이 필요하므로 여기서 함께 붙인다.
do $$
begin
    if not exists (
        select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'leave_requests' and c.contype = 'p'
    ) then
        alter table leave_requests add primary key (id);
    end if;
end $$;

alter table leave_requests
    add column if not exists parent_request_id bigint references leave_requests(id);

create index if not exists idx_leave_requests_parent
    on leave_requests(parent_request_id);

alter table document_requests
    add column if not exists leave_request_id bigint references leave_requests(id);

create index if not exists idx_document_requests_leave
    on document_requests(leave_request_id);

comment on column leave_requests.parent_request_id is
    '연장 신청일 때 원 신청(체인의 뿌리) id. NULL = 독립 신청';
comment on column document_requests.leave_request_id is
    '이 증빙 요청을 유발한 연차 신청 id. 연장 시 새 요청을 만들지 않고 이 요청의 범위를 넓힌다';

-- 기존 자동생성 요청 backfill: message 앞머리의 첫 날짜 + 같은 직원으로 원 신청을 찾는다.
-- (자동생성 message 형식: "2026-08-18, 2026-08-19 연차 신청기간(7일) 경과 — ... 제출 요청")
update document_requests dr
set leave_request_id = lr.id
from leave_requests lr
where dr.leave_request_id is null
  and dr.message like '%연차 신청기간%'
  and lr.employee_id = dr.employee_id
  and lr.dates::text like '%' || substring(dr.message from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') || '%';
