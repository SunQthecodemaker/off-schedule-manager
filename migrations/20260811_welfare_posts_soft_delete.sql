-- 복지 미션 게시판(welfare_posts) 소프트 삭제 지원.
-- 관리자가 직원이 올린 글을 실수로 삭제해도 복원할 수 있도록 deleted_at 플래그 도입.
-- 기존 deleteWelfarePost() 는 하드 삭제였으나, 이제 deleted_at 만 찍고 행/사진은 보존한다.
-- 정말 무효한(스팸·오등록 등) 글만 관리자가 휴지통에서 "영구 삭제"로 확정 삭제(purgeWelfarePost).
alter table public.welfare_posts
  add column if not exists deleted_at timestamptz;

create index if not exists idx_welfare_posts_deleted
  on public.welfare_posts(deleted_at);

comment on column public.welfare_posts.deleted_at is
  '소프트 삭제 시각. NULL = 정상 노출. 관리자 휴지통에서 복원(NULL로 되돌림) 또는 영구삭제(행 자체 삭제) 가능.';
