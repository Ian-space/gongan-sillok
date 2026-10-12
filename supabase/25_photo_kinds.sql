-- 공간실록 25단계: 사진마다 무엇을 찍었는지(입구, 내부, 화장실 …)
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (10_lamp.sql까지 실행했어야 한다)
-- 사진 목록(photo_paths)과 같은 순서로 종류(photo_kinds)를 둔다. 고르지 않은 사진은 빈 글자('').
-- 이미 올린 사진은 종류 없이 그대로 남는다(빈 목록이면 모두 '모름'으로 본다).

-- 1) 종류 목록이 올바른지: 비어 있거나 사진 수와 같고, 정해 둔 값만
create function public.valid_photo_kinds(k text[], p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select (coalesce(array_length(k, 1), 0) = 0 or coalesce(array_length(k, 1), 0) = coalesce(array_length(p, 1), 0))
     and not exists (select 1 from unnest(k) x where x is null or x not in ('', '입구', '내부', '화장실', '외관', '층 이동', '안내문', '기타'));
$$;

alter table public.records add column photo_kinds text[] not null default '{}';
alter table public.records add constraint records_photo_kinds_valid check (public.valid_photo_kinds(photo_kinds, photo_paths));
grant select (photo_kinds) on public.records to anon;
grant insert (photo_kinds) on public.records to authenticated;
grant update (photo_kinds) on public.records to authenticated;

-- 2) 공개 기록 함수: 사진 종류 칸을 맨 뒤에 더한다 (돌려주는 모양이 바뀌어서 지우고 다시 만든다)
drop function public.public_records();
create function public.public_records() returns table (
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
  from public.records r
  join public.places pl on pl.id = r.place_id
  left join public.profiles pf on pf.id = r.user_id
  where r.is_public and not r.hidden
  order by r.created_at desc
  limit 2000;
$$;
grant execute on function public.public_records() to anon, authenticated;
