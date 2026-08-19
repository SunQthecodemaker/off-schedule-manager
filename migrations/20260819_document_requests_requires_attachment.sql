-- 2026-08-19 연차 임박(마감일수 경과) 신청 시 요구하는 증빙 서류를 "파일 첨부 필수" 로 못박기
--
-- 배경: 지연 신청이 자동 생성하던 요청은 type='사유서' 하드코딩이었는데
--       document_templates 에 '사유서' 서식이 없어 requires_attachment 조회가 항상 실패 →
--       첨부가 "(선택)" 으로 떨어져 사유 텍스트만 적으면 제출이 완료되고 잠금이 풀렸다.
--
-- 1) 요청 단위 첨부 강제 플래그 (서식 설정과 무관하게 이 요청은 파일 없이는 제출 불가)
ALTER TABLE document_requests
  ADD COLUMN IF NOT EXISTS requires_attachment boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN document_requests.requires_attachment IS
  '요청 단위 첨부 강제. true 면 서식(document_templates.requires_attachment) 설정과 무관하게 파일 첨부 없이는 제출 불가.';

-- 2) 기본 요구 서식 '내원 확인서' (첨부 필수) — 없을 때만 생성
INSERT INTO document_templates (template_name, requires_attachment, template_fields)
SELECT '내원 확인서', true, NULL
WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE template_name = '내원 확인서');

-- 3) 임박 신청 시 요구할 서식명 설정 (원장이 연차 관리 화면에서 변경 가능)
INSERT INTO app_settings (key, value, updated_at)
SELECT 'leave_late_document_type', to_jsonb('내원 확인서'::text), now()
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'leave_late_document_type');
