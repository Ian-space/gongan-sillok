-- 공간실록 11단계: 조명 색(따뜻한 빛 / 하얀 빛 / 섞여 있음). 분위기로 찾기(아늑한, 모던 등)에 쓴다
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (09_checks_care.sql까지 실행했어야 한다)

-- 1) 조명 색: 비워 두면 모름
alter table public.records
  add column lamp text check (lamp in ('따뜻한 빛', '하얀 빛', '섞여 있음'));
grant select (lamp) on public.records to anon;
grant insert (lamp) on public.records to authenticated;
grant update (lamp) on public.records to authenticated;

-- 2) 공개 기록 함수: 조명 색 칸을 맨 뒤에 더한다
drop function public.public_records();
create function public.public_records() returns table (
  id bigint, place_id bigint, nickname text, mine boolean,
  noise text, spacing text, light text, outlet text, stay text, materials text, furniture text, note text,
  visited_on date, created_at timestamptz,
  kakao_id text, place_name text, place_type text, place_address text, lat double precision, lng double precision,
  entrance text, floor_access text, toilet text, kids text, pets text, photo_paths text[],
  parking text, hood text, step_cm smallint, noise_db smallint, visit_hour smallint,
  diaper text, late_night text, lamp text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.place_id, case when public.is_admin() then coalesce(pf.nickname, '기록자') end, r.user_id = auth.uid(),
         r.noise, r.spacing, r.light, r.outlet, r.stay, r.materials, r.furniture, r.note, r.visited_on, r.created_at,
         pl.kakao_id, pl.name, pl.type, pl.address, pl.lat, pl.lng,
         r.entrance, r.floor_access, r.toilet, r.kids, r.pets, r.photo_paths,
         r.parking, r.hood, r.step_cm, r.noise_db, r.visit_hour,
         r.diaper, r.late_night, r.lamp
  from public.records r
  join public.places pl on pl.id = r.place_id
  left join public.profiles pf on pf.id = r.user_id
  where r.is_public and not r.hidden
  order by r.created_at desc
  limit 2000;
$$;
grant execute on function public.public_records() to anon, authenticated;
