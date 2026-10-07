-- 공간실록 14단계: 서울 전체(55만 곳)에서도 상호 일부 검색이 빠르게
-- 12_shops.sql의 search_shops는 '상호 OR 상호+지점' 두 조건이라 색인을 못 타서, 서울 전체에서는 시간 초과가 났다.
-- 띄어쓰기를 뺀 '상호+지점' 하나에 색인을 걸고, 두 글자 검색(색인이 안 되는 길이)은 지금 지도 근처(약 3km)에서만 찾는다.
-- Supabase SQL Editor에서 전체를 Run. (색인을 만드는 데 1~2분 걸릴 수 있다)

create index if not exists shops_search_trgm_idx on public.shops
  using gin ((replace(name || coalesce(branch, ''), ' ', '')) extensions.gin_trgm_ops);

create or replace function public.search_shops(q text, at_lat double precision default null, at_lng double precision default null)
returns setof public.shops
language sql stable set search_path = '' as $$
  with k as (select replace(trim(q), ' ', '') as s)
  select sh.* from public.shops sh, k
  where length(k.s) >= 2
    and replace(sh.name || coalesce(sh.branch, ''), ' ', '') ilike '%' || k.s || '%'
    and (length(k.s) >= 3 or (at_lat is not null
         and sh.lat between at_lat - 0.03 and at_lat + 0.03 and sh.lng between at_lng - 0.04 and at_lng + 0.04))
  order by case when at_lat is null then 0 else (sh.lat - at_lat) ^ 2 + ((sh.lng - at_lng) * 0.79) ^ 2 end
  limit 20;
$$;
grant execute on function public.search_shops(text, double precision, double precision) to anon, authenticated;

analyze public.shops;
