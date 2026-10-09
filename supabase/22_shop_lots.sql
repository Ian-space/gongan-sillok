-- 공간실록 23단계: 도로명주소가 여러 개인 건물·단지를 하나로 묶기
-- 큰 건물·단지는 한 필지(지번)에 도로명주소가 두 개 이상이다(예: 분당 AK플라자 = 성남대로 601 + 황새울로360번길 42, 둘 다 서현동 263).
-- 도로명주소 하나로만 찾으면 다른 주소로 등록된 가게가 빠진다. 상가정보에서 '한 필지에 주소가 여럿인 곳'만 뽑아(약 1,900필지)
-- 작은 표에 두고, 지도에서 건물을 누르면 같은 필지의 다른 주소 가게도 함께 보여 준다.
-- 순서: ① 이 파일을 Run → ② 공간실록_상가 CSV 폴더의 shop_lots_data.sql을 Run (분기 갱신 때 다시 만든다)

create table if not exists public.shop_lots (
  lot text not null,   -- 시도를 뺀 지번주소 (예: '성남시 분당구 서현동 263')
  addr text not null,  -- 그 필지의 도로명주소 (shops.addr와 같은 표기)
  primary key (lot, addr)
);
create index if not exists shop_lots_addr_idx on public.shop_lots (addr);
alter table public.shop_lots enable row level security;
create policy "shop_lots: 누구나 읽기" on public.shop_lots for select to anon, authenticated using (true);
grant select on public.shop_lots to anon, authenticated;

-- 같은 건물의 가게: 누른 자리의 도로명주소, 그 지번에 딸린 다른 도로명주소, 그 도로명주소와 같은 필지의 다른 주소
create or replace function public.shops_at_place(p_addr text, p_lot text, at_lat double precision, at_lng double precision)
returns setof public.shops
language sql stable set search_path = '' as $$
  with a as (
    select trim(p_addr) as addr where coalesce(trim(p_addr), '') <> ''
    union select l.addr from public.shop_lots l where l.lot = trim(coalesce(p_lot, ''))
    union select l2.addr from public.shop_lots l1 join public.shop_lots l2 on l2.lot = l1.lot where l1.addr = trim(coalesce(p_addr, ''))
  )
  select s.* from public.shops s
  where point(s.lng, s.lat) <@ box(point(at_lng - 0.0045, at_lat - 0.0036), point(at_lng + 0.0045, at_lat + 0.0036))
    and s.addr in (select addr from a)
    and s.closed_at is null
  order by point(s.lng, s.lat) <-> point(at_lng, at_lat)
  limit 300;
$$;
grant execute on function public.shops_at_place(text, text, double precision, double precision) to anon, authenticated;
