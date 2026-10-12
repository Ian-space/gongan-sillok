-- 공간실록 28단계: 공개 기록을 지도에 보이는 영역만큼만 불러오기 + 넓게 볼 때 동네별 개수
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (25_photo_kinds.sql까지 실행했어야 한다)
-- 예전에는 처음에 공개 기록을 한꺼번에(최대 2,000개) 불러와서, 기록이 많아지면 느려지고 넘는 기록은 안 보였다.

-- 위도·경도로 장소를 빨리 찾게
create index if not exists places_lat_lng on public.places (lat, lng);

-- 1) 사각형 영역 안 장소의 공개 기록 (public_records와 같은 칸). 한 번에 최대 3,000개
create or replace function public.public_records_box(min_lat double precision, min_lng double precision, max_lat double precision, max_lng double precision)
returns table (
  id bigint, place_id bigint, nickname text, mine boolean,
  noise text, spacing text, light text, outlet text, stay text, materials text, furniture text, note text,
  visited_on date, created_at timestamptz,
  kakao_id text, place_name text, place_type text, place_address text, lat double precision, lng double precision,
  entrance text, floor_access text, toilet text, kids text, pets text, photo_paths text[],
  parking text, hood text, step_cm smallint, noise_db smallint, visit_hour smallint,
  diaper text, late_night text, lamp text, photo_kinds text[])
language sql stable security definer set search_path = '' as $$
  select r.id, r.place_id, case when public.is_admin() then coalesce(pf.nickname, '기록자') end, r.user_id = auth.uid(),
         r.noise, r.spacing, r.light, r.outlet, r.stay, r.materials, r.furniture, r.note, r.visited_on, r.created_at,
         pl.kakao_id, pl.name, pl.type, pl.address, pl.lat, pl.lng,
         r.entrance, r.floor_access, r.toilet, r.kids, r.pets, r.photo_paths,
         r.parking, r.hood, r.step_cm, r.noise_db, r.visit_hour,
         r.diaper, r.late_night, r.lamp, r.photo_kinds
  from public.places pl
  join public.records r on r.place_id = pl.id
  left join public.profiles pf on pf.id = r.user_id
  where pl.lat between min_lat and max_lat and pl.lng between min_lng and max_lng
    and r.is_public and not r.hidden
    and max_lat - min_lat <= 1 and max_lng - min_lng <= 1   -- 한 번에 너무 넓은 영역은 받지 않는다
  order by r.created_at desc
  limit 3000;
$$;
grant execute on function public.public_records_box(double precision, double precision, double precision, double precision) to anon, authenticated;

-- 2) 넓게 볼 때: 칸(cell, 도 단위)마다 공개 기록이 있는 장소 수와 그 장소들의 가운데 좌표
create or replace function public.public_place_cells(cell double precision, min_lat double precision, min_lng double precision, max_lat double precision, max_lng double precision)
returns table (lat double precision, lng double precision, n bigint)
language sql stable security definer set search_path = '' as $$
  select avg(pl.lat), avg(pl.lng), count(*)
  from public.places pl
  where pl.lat between min_lat and max_lat and pl.lng between min_lng and max_lng
    and cell between 0.01 and 2
    and exists (select 1 from public.records r where r.place_id = pl.id and r.is_public and not r.hidden)
  group by floor(pl.lat / cell), floor(pl.lng / cell)
  limit 2000;
$$;
grant execute on function public.public_place_cells(double precision, double precision, double precision, double precision, double precision) to anon, authenticated;
