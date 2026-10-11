-- 공간실록 24단계: 버스정류장 겹침 지우기
-- 서울 정류장 일부가 서울BIS(SEB…)와 경기BIS(GGB…)에 함께 올라 있어서 지도에 점이 두 개씩 찍힌다
-- (예: 암사역.선사현대아파트 SEB124000055 / GGB124000055, 좌표가 몇 m 달라 처음 정리 때 못 걸렀다).
-- 서울 정류소 고유번호(ars)가 같으면 같은 정류장이므로 서울BIS 것만 남긴다.
-- Supabase SQL Editor에서 전체를 Run. 지운 개수가 결과에 나온다

with gone as (
  delete from public.bus_stops g
  where g.id like 'GGB%' and g.city = 'seoul' and g.ars is not null
    and exists (select 1 from public.bus_stops s where s.id like 'SEB%' and s.ars = g.ars)
  returning 1
)
select count(*) as "지운 정류장 수" from gone;

analyze public.bus_stops;
