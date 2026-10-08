-- 공간실록 21단계: 폐업 가게만 담은 작은 색인 (기록 화면의 '폐업 신고됨' 표시용)
-- 기록한 가게 근처(약 50m)에서 폐업 신고된 가게를 찾는데, 색인이 없으면 55만 곳을 다 훑다가 시간 초과가 난다.
-- 폐업 표시된 곳(약 1만 곳)만 담는 부분 색인이라 용량은 1MB도 안 된다.
-- Supabase SQL Editor에서 전체를 Run.

create index if not exists shops_closed_idx on public.shops (lat, lng) where closed_at is not null;
analyze public.shops;
