-- 복지 미션 게시판 (welfare_posts)
-- 직원이 본인이 작성한 블로그 글 / 혜택 미션 인증을 텍스트 + 사진으로 올리는 게시판.
--   · 직원  : 본인 글만 작성/수정/삭제/조회 (클라이언트 employee_id 필터)
--   · 관리자: 전체 글 조회 (복지 탭 → 📸 미션 게시판), 삭제 가능
-- 사진은 기존 'docs' 버킷 재사용 — 경로 welfare/posts/{employee_id}/{ts}_{seq}.jpg
-- (비공개 버킷 → 표시는 signed URL. 이행체크 첨부와 동일 패턴)

CREATE TABLE IF NOT EXISTS welfare_posts (
    id          bigserial PRIMARY KEY,
    employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    year_month  text   NOT NULL,
    category    text   NOT NULL DEFAULT 'mission',
    title       text   NOT NULL,
    body        text   NOT NULL DEFAULT '',
    link_url    text,
    photos      jsonb  NOT NULL DEFAULT '[]'::jsonb,
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now(),
    CONSTRAINT welfare_posts_category_chk CHECK (category IN ('mission','blog')),
    CONSTRAINT welfare_posts_title_chk    CHECK (title <> ''),
    CONSTRAINT welfare_posts_ym_chk       CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

CREATE INDEX IF NOT EXISTS idx_welfare_posts_employee
    ON welfare_posts(employee_id, year_month DESC);
CREATE INDEX IF NOT EXISTS idx_welfare_posts_month
    ON welfare_posts(year_month DESC, created_at DESC);

COMMENT ON TABLE  welfare_posts IS '복지 미션 게시판 — 직원이 올리는 블로그 글/혜택 미션 인증 (텍스트 + 사진)';
COMMENT ON COLUMN welfare_posts.year_month IS
    '미션 해당 월 (YYYY-MM). 작성일과 별개 — 8월에 7월/9월분을 올릴 수 있어 직원이 직접 선택. 기본값 = 작성 시점의 현재 달';
COMMENT ON COLUMN welfare_posts.category IS 'mission = 혜택 미션 인증 / blog = 블로그 글';
COMMENT ON COLUMN welfare_posts.link_url IS '블로그 글 URL (선택)';
COMMENT ON COLUMN welfare_posts.photos   IS 'docs 버킷 내 사진 경로 배열 (welfare/posts/...)';

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION welfare_posts_touch() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_welfare_posts_touch ON welfare_posts;
CREATE TRIGGER trg_welfare_posts_touch
    BEFORE UPDATE ON welfare_posts
    FOR EACH ROW EXECUTE FUNCTION welfare_posts_touch();

-- RLS : 다른 welfare_* 테이블과 동일 (내부용 앱 — 직원 로그인은 RPC 기반이라 클라이언트는 anon).
-- 세부 가시성(직원=본인 글만)은 클라이언트 필터가 담당.
ALTER TABLE welfare_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS welfare_posts_anon ON welfare_posts;
DROP POLICY IF EXISTS welfare_posts_auth ON welfare_posts;

CREATE POLICY welfare_posts_anon ON welfare_posts FOR ALL TO anon          USING (true) WITH CHECK (true);
CREATE POLICY welfare_posts_auth ON welfare_posts FOR ALL TO authenticated USING (true) WITH CHECK (true);
