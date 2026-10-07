-- 공간실록 15단계: 상호 검색 다듬기
-- ① 두 글자 검색('스타', '카페')도 빠르게: 두 글자는 글자 색인(3글자 단위)이 안 먹어서 55만 곳을 다 훑다가 시간 초과가 났다.
--    가장 긴 낱말이 두 글자 이하면 '지도 근처 약 3km'를 먼저 좌표 색인으로 추리고(materialized), 그 안에서만 찾는다.
-- ② 띄어 쓴 낱말은 각각 찾는다: '어니언 안' → 상호·지점에 '어니언'과 '안'이 모두 든 곳(어니언컴퍼니 안국점)
-- Supabase SQL Editor에서 전체를 Run.

create or replace function public.search_shops(q text, at_lat double precision default null, at_lng double precision default null)
returns setof public.shops
language plpgsql stable set search_path = '' as $$
declare
  words text[] := array(select w from unnest(regexp_split_to_array(trim(coalesce(q, '')), '\s+')) w where w <> '');
  main text := (select w from unnest(words) w order by length(w) desc limit 1); -- 색인으로 먼저 추릴 가장 긴 낱말
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
      with near as materialized (
        select * from public.shops
        where lat between at_lat - 0.03 and at_lat + 0.03 and lng between at_lng - 0.04 and at_lng + 0.04
      )
      select n.* from near n
      where not exists (select 1 from unnest(words) w where replace(n.name || coalesce(n.branch, ''), ' ', '') not ilike '%' || w || '%')
      order by (n.lat - at_lat) ^ 2 + ((n.lng - at_lng) * 0.79) ^ 2
      limit 20;
  end if;
end;
$$;
grant execute on function public.search_shops(text, double precision, double precision) to anon, authenticated;
