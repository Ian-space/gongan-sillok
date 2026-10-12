-- 공간실록 29단계: 중계 서버가 새 신고를 읽어 운영자에게 메일로 알릴 수 있게
-- Supabase SQL Editor에서 전체를 Run. (02_moderation.sql까지 실행했어야 한다)
-- 이 프로젝트는 관리자 역할(service_role)에도 표 권한을 자동으로 주지 않아서, 알림에 필요한 칸만 읽게 한다(신고한 사람 칸은 주지 않는다)
grant select (id, record_id, reason, detail, status, created_at) on public.reports to service_role;
grant select (id, place_id) on public.records to service_role;
grant select (id, name) on public.places to service_role;
