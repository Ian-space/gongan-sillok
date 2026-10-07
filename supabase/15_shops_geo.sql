-- 공간실록 16단계: 2차원 좌표 색인(GiST)으로 '근처 찾기'를 빠르게
-- (lat, lng) 색인은 위도로만 좁혀서, 서울 전체(55만 곳)에서는 '근처 3km'를 고르는 것조차 느렸다(두 글자 검색 시간 초과).
-- 점(경도, 위도) 색인을 걸면 ① 가까운 순으로 바로 꺼내고(<->) ② 네모 안을 빠르게 고른다(<@).
-- Supabase SQL Editor에서 전체를 Run. (색인을 만드는 데 1분쯤 걸릴 수 있다)

create index if not exists shops_pt_gist_idx on public.shops using gist (point(lng, lat));

-- 지도 한 칸 안의 가게
create or replace function public.shops_in_box(min_lng double precision, min_lat double precision, max_lng double precision, max_lat double precision, lim int default 400)
returns setof public.shops
language sql stable set search_path = '' as $$
  select * from public.shops
  where point(lng, lat) <@ box(point(min_lng, min_lat), point(max_lng, max_lat))
    and (max_lat - min_lat) < 0.03 and (max_lng - min_lng) < 0.03
  limit least(greatest(lim, 1), 800);
$$;
grant execute on function public.shops_in_box(double precision, double precision, double precision, double precision, int) to anon, authenticated;

-- 상호 일부로 찾기: 세 글자 이상 낱말이 있으면 글자 색인으로, 아니면 가까운 순(좌표 색인)으로 훑되 약 3km 안에서만
create or replace function public.search_shops(q text, at_lat double precision default null, at_lng double precision default null)
returns setof public.shops
language plpgsql stable set search_path = '' as $$
declare
  words text[] := array(select w from unnest(regexp_split_to_array(trim(coalesce(q, '')), '\s+')) w where w <> '');
  main text := (select w from unnest(words) w order by length(w) desc limit 1);
begin
  if main is null or length(array_to_string(words, '')) < 2 then return; end if;
  if length(main) >= 3 then
    return query
      select sh.* from public.shops sh
      where replace(sh.name || coalesce(sh.branch, ''), ' ', '') ilike '%' || main || '%'
        and not exists (select 1 from unnest(words) w where replace(sh.name || coalesce(sh.branch, ''), ' ', '') not ilike '%' || w || '%')
      order by case when at_lat is null then 0 else (sh.lat - at_lat) ^ 2 + ((sh.lng - at_lng) * 0.79) ^ 2 end
      limit 20;
  elsif at_lat is not null then
    return query
      select sh.* from public.shops sh
      where point(sh.lng, sh.lat) <@ box(point(at_lng - 0.035, at_lat - 0.027), point(at_lng + 0.035, at_lat + 0.027))
        and not exists (select 1 from unnest(words) w where replace(sh.name || coalesce(sh.branch, ''), ' ', '') not ilike '%' || w || '%')
      order by point(sh.lng, sh.lat) <-> point(at_lng, at_lat)
      limit 20;
  end if;
end;
$$;
grant execute on function public.search_shops(text, double precision, double precision) to anon, authenticated;

analyze public.shops;
