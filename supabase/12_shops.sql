-- 공간실록 13단계: 상가 목록(소상공인시장진흥공단 상가(상권)정보, 공공데이터포털, 이용허락범위 제한 없음)
-- 지도에서 아무 가게나 누를 수 있게 하고, 상호 앞부분만 적어도 찾게 한다. 처음엔 강동·송파·성동만 넣는다.
-- 순서: ① 이 SQL을 SQL Editor에서 Run → ② Table Editor에서 shops 표를 열고 Insert → Import data from CSV로
--       shops_gangdong_songpa_seongdong.csv 올리기 → ③ 맨 아래 'analyze'를 한 번 더 Run

create extension if not exists pg_trgm with schema extensions;

create table public.shops (
  id text primary key,          -- 상가업소번호
  name text not null,           -- 상호명
  branch text,                  -- 지점명
  cat1 text, cat2 text, cat3 text, -- 업종 대·중·소분류
  gu text, dong text,           -- 시군구, 행정동
  addr text,                    -- 도로명주소
  floor text,                   -- 층정보(1, 2, 지, B1 … 비어 있을 수 있음)
  lng double precision not null,
  lat double precision not null
);
create index shops_lat_lng_idx on public.shops (lat, lng);
create index shops_name_trgm_idx on public.shops using gin (name extensions.gin_trgm_ops);

-- 누구나 읽기만(쓰기는 SQL·대시보드로만)
alter table public.shops enable row level security;
create policy "shops: 누구나 읽기" on public.shops for select to anon, authenticated using (true);
grant select on public.shops to anon, authenticated;

-- 지도 한 칸 안의 가게(많으면 lim개까지). 확대했을 때만 부른다
create function public.shops_in_box(min_lng double precision, min_lat double precision, max_lng double precision, max_lat double precision, lim int default 400)
returns setof public.shops
language sql stable set search_path = '' as $$
  select * from public.shops
  where lat between min_lat and max_lat and lng between min_lng and max_lng
    and (max_lat - min_lat) < 0.03 and (max_lng - min_lng) < 0.03
  limit least(greatest(lim, 1), 800);
$$;
grant execute on function public.shops_in_box(double precision, double precision, double precision, double precision, int) to anon, authenticated;

-- 상호 일부로 찾기('업사이', '블루보'): 가까운 순 20곳
create function public.search_shops(q text, at_lat double precision default null, at_lng double precision default null)
returns setof public.shops
language sql stable set search_path = '' as $$
  select * from public.shops
  where length(trim(q)) >= 2 and (name ilike '%' || trim(q) || '%' or (name || coalesce(branch, '')) ilike '%' || replace(trim(q), ' ', '') || '%')
  order by case when at_lat is null then 0 else (lat - at_lat) ^ 2 + ((lng - at_lng) * 0.79) ^ 2 end
  limit 20;
$$;
grant execute on function public.search_shops(text, double precision, double precision) to anon, authenticated;

-- ③ CSV를 다 올린 뒤 한 번 더 실행: 검색 속도를 위한 통계 갱신
analyze public.shops;
