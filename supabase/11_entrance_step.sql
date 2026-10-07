-- 공간실록 12단계: 입구 값 '계단 있음' → '턱·계단 있음'
-- 한 칸짜리 작은 문턱도 휠체어에는 장벽이라 계단과 함께 묶는다. 높이는 단차 cm(step_cm)로 따로 남긴다.
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (10_lamp.sql까지 실행했어야 한다)

alter table public.records drop constraint if exists records_entrance_check;
update public.records set entrance = '턱·계단 있음' where entrance = '계단 있음';
alter table public.records add constraint records_entrance_check
  check (entrance in ('턱 없음', '경사로 있음', '턱·계단 있음'));
