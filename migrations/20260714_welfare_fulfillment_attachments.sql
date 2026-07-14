-- 월별 이행체크 메모에 사진 첨부 지원.
-- attachments = docs 버킷 내 사진 경로 문자열 배열 (비공개 버킷 → 표시는 signed URL).
-- 예: ["welfare/fulfillment/11_2025-09/1699999999_0.jpg", ...]
alter table public.welfare_monthly_fulfillment
  add column if not exists attachments jsonb not null default '[]'::jsonb;

comment on column public.welfare_monthly_fulfillment.attachments is
  '이행체크 메모 첨부 사진 경로 배열 (docs 버킷 내 경로 문자열).';
