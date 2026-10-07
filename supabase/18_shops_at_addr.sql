-- 공간실록 19단계: 같은 건물(도로명주소)의 가게 찾기
-- 지도에서 누른 건물의 주소(카카오)와 같은 주소의 상가를 돌려준다. 큰 건물(쇼핑몰)은 가게 좌표가 넓게 흩어져 있어서
-- 누른 자리 근처 약 400m를 2차원 좌표 색인으로 먼저 추리고, 그 안에서 주소가 같은 곳만 고른다(새 색인 없음).
-- Supabase SQL Editor에서 전체를 Run.

create or replace function public.shops_at_addr(p_addr text, at_lat double precision, at_lng double precision)
returns setof public.shops
language sql stable set search_path = '' as $$
  select * from public.shops
  where point(lng, lat) <@ box(point(at_lng - 0.0045, at_lat - 0.0036), point(at_lng + 0.0045, at_lat + 0.0036))
    and addr = trim(p_addr)
  order by point(lng, lat) <-> point(at_lng, at_lat)
  limit 300;
$$;
grant execute on function public.shops_at_addr(text, double precision, double precision) to anon, authenticated;
