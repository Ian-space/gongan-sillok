-- 공간실록 27단계: 중계 서버가 1년 지난 '사진으로 찾기' 사진을 지울 수 있게
-- Supabase SQL Editor에서 전체를 Run. (26_find_photos.sql을 먼저 실행했어야 한다)
-- 이 프로젝트는 관리자 역할(service_role)에도 표 권한을 자동으로 주지 않아서, 지우는 데 필요한 것만 준다(목록 보기·지우기)
grant select (id, path, created_at), delete on public.find_photos to service_role;
