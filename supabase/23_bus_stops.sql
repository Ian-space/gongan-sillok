-- 공간실록 23단계: 버스정류장(수도권: 서울·경기·인천)
-- 자료: 국토교통부_전국 버스정류장 위치정보(공공데이터포털, 2025-10-31 수집, 1년에 한 번 갱신)
-- 네이버 지도 API의 기본 지도와 카카오에는 버스정류장이 없어서, '주변 장소'에 정류장 점을 띄우고
-- 누르면 실시간 도착(중계 서버 /arrive)을 보여 주려고 넣는다.
--
-- 순서
-- 1) 이 파일 전체를 Supabase SQL Editor에서 Run
-- 2) Table Editor → bus_stops → Insert → Import data from CSV 로
--    '공간실록_상가 CSV/버스정류장/bus_stops_capital.csv'(61,644곳)를 넣는다
-- 3) 마지막 줄의 analyze 를 한 번 더 Run (새 자료로 검색 계획을 다시 세운다)

create table if not exists public.bus_stops (
  id text primary key,   -- 정류장번호(SEB…: 서울BIS, GGB…: 경기BIS, ICB…: 인천BIS)
  name text not null,    -- 정류장명
  lat double precision not null,
  lng double precision not null,
  ars text,              -- 서울 정류소 고유번호(5자리, 실시간 도착 조회용). 서울이 아니면 비어 있음
  city text not null,    -- seoul | gg | etc (실시간 도착을 어느 쪽에 물을지)
  sid text               -- 경기 정류소 ID(실시간 도착 조회용). 경기BIS 정류장만
);
-- 지도 영역 안 정류장을 빨리 찾는 좌표 색인
create index if not exists bus_stops_pt_idx on public.bus_stops using gist (point(lng, lat));

alter table public.bus_stops enable row level security;
drop policy if exists "bus_stops: 누구나 읽기" on public.bus_stops;
create policy "bus_stops: 누구나 읽기" on public.bus_stops for select to anon, authenticated using (true);
grant select on public.bus_stops to anon, authenticated;

-- 지도 한 칸 안의 정류장(가게 shops_in_box와 같은 방식, 칸은 약 3km 안쪽만)
create or replace function public.stops_in_box(min_lng double precision, min_lat double precision, max_lng double precision, max_lat double precision, lim int default 300)
returns setof public.bus_stops
language sql stable set search_path = '' as $$
  select * from public.bus_stops
  where point(lng, lat) <@ box(point(min_lng, min_lat), point(max_lng, max_lat))
    and (max_lat - min_lat) < 0.03 and (max_lng - min_lng) < 0.03
  limit least(greatest(lim, 1), 600);
$$;
grant execute on function public.stops_in_box(double precision, double precision, double precision, double precision, int) to anon, authenticated;

analyze public.bus_stops;
