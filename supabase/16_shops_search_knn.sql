-- 공간실록 17단계: 두 글자 검색이 글자 색인을 타지 않게
-- 두 글자('카페', '스타')는 글자 색인(3글자 단위)으로 아무것도 못 거르는데, DB가 ilike를 보고 그 색인을 골라 전체를 훑었다.
-- 두 글자일 때는 ilike 대신 strpos(글자 위치 찾기)를 써서 글자 색인을 못 고르게 하고, 좌표 색인으로 가까운 순으로만 훑는다.
-- Supabase SQL Editor에서 전체를 Run. (색인을 새로 만들지 않아 금방 끝난다)

create or replace function public.search_shops(q text, at_lat double precision default null, at_lng double precision default null)
returns setof public.shops
language plpgsql stable set search_path = '' as $$
declare
  words text[] := array(select lower(w) from unnest(regexp_split_to_array(trim(coalesce(q, '')), '\s+')) w where w <> '');
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
        and not exists (select 1 from unnest(words) w where strpos(lower(replace(sh.name || coalesce(sh.branch, ''), ' ', '')), w) = 0)
      order by point(sh.lng, sh.lat) <-> point(at_lng, at_lat)
      limit 20;
  end if;
end;
$$;
grant execute on function public.search_shops(text, double precision, double precision) to anon, authenticated;
