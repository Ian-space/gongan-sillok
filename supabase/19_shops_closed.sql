-- 공간실록 20단계: 폐업 신고된 가게 숨기기 (지방행정 인허가 데이터)
-- 상가정보는 분기마다 갱신돼서 문 닫은 가게가 몇 달씩 남는다. 인허가 데이터(일반음식점·휴게음식점·제과점, 매일 갱신)에서
-- '같은 도로명주소 + 같은 상호'가 폐업으로만 있고 영업 중인 기록은 없는 가게에 폐업일을 적고, 지도·검색에서 뺀다.
-- 지우지 않고 표시만 하므로 되돌리기 쉽다: update public.shops set closed_at = null;
-- Supabase SQL Editor에서 전체를 Run한 다음, 폐업 목록 파일(shops_closed_data.sql)을 Run.

alter table public.shops add column if not exists closed_at date;  -- 폐업 신고일(인허가). 비어 있으면 영업 중으로 본다

-- 지도 한 칸 안의 가게
create or replace function public.shops_in_box(min_lng double precision, min_lat double precision, max_lng double precision, max_lat double precision, lim int default 400)
returns setof public.shops
language sql stable set search_path = '' as $$
  select * from public.shops
  where point(lng, lat) <@ box(point(min_lng, min_lat), point(max_lng, max_lat))
    and (max_lat - min_lat) < 0.03 and (max_lng - min_lng) < 0.03
    and closed_at is null
  limit least(greatest(lim, 1), 800);
$$;
grant execute on function public.shops_in_box(double precision, double precision, double precision, double precision, int) to anon, authenticated;

-- 상호 일부로 찾기 (16번과 같고 폐업만 뺀다)
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
        and sh.closed_at is null
      order by case when at_lat is null then 0 else (sh.lat - at_lat) ^ 2 + ((sh.lng - at_lng) * 0.79) ^ 2 end
      limit 20;
  elsif at_lat is not null then
    return query
      select sh.* from public.shops sh
      where point(sh.lng, sh.lat) <@ box(point(at_lng - 0.035, at_lat - 0.027), point(at_lng + 0.035, at_lat + 0.027))
        and not exists (select 1 from unnest(words) w where strpos(lower(replace(sh.name || coalesce(sh.branch, ''), ' ', '')), w) = 0)
        and sh.closed_at is null
      order by point(sh.lng, sh.lat) <-> point(at_lng, at_lat)
      limit 20;
  end if;
end;
$$;
grant execute on function public.search_shops(text, double precision, double precision) to anon, authenticated;

-- 같은 건물(도로명주소)의 가게
create or replace function public.shops_at_addr(p_addr text, at_lat double precision, at_lng double precision)
returns setof public.shops
language sql stable set search_path = '' as $$
  select * from public.shops
  where point(lng, lat) <@ box(point(at_lng - 0.0045, at_lat - 0.0036), point(at_lng + 0.0045, at_lat + 0.0036))
    and addr = trim(p_addr)
    and closed_at is null
  order by point(lng, lat) <-> point(at_lng, at_lat)
  limit 300;
$$;
grant execute on function public.shops_at_addr(text, double precision, double precision) to anon, authenticated;
