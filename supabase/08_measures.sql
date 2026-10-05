-- 공간실록 9단계: 주차, 배기 방식(고기 굽는 곳), 입구 단차 높이(cm), 잰 소음(dB), 방문 시각(몇 시)
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (06_photos_multi.sql까지 실행했어야 한다)
-- 모두 비워 둘 수 있다(모름). 숫자는 직접 잰 경우에만 남긴다.

alter table public.records
  add column parking  text check (parking in ('전용 주차장', '근처 유료 주차', '주차 불가')),
  add column hood     text check (hood    in ('하향식', '상향식', '후드 없음')),
  add column step_cm  smallint check (step_cm  between 0 and 100),
  add column noise_db smallint check (noise_db between 20 and 130),
  add column visit_hour smallint check (visit_hour between 0 and 23);  -- 소음·채광은 시간대마다 달라서 몇 시에 갔는지 함께 남긴다

grant select (parking, hood, step_cm, noise_db, visit_hour) on public.records to anon;
grant insert (parking, hood, step_cm, noise_db, visit_hour) on public.records to authenticated;
grant update (parking, hood, step_cm, noise_db, visit_hour) on public.records to authenticated;

-- 공개 기록 함수: 새 칸 다섯 개를 맨 뒤에 더한다
drop function public.public_records();
create function public.public_records() returns table (
  id bigint, place_id bigint, nickname text, mine boolean,
  noise text, spacing text, light text, outlet text, stay text, materials text, furniture text, note text,
  visited_on date, created_at timestamptz,
  kakao_id text, place_name text, place_type text, place_address text, lat double precision, lng double precision,
  entrance text, floor_access text, toilet text, kids text, pets text, photo_paths text[],
  parking text, hood text, step_cm smallint, noise_db smallint, visit_hour smallint)
language sql stable security definer set search_path = '' as $$
  select r.id, r.place_id, case when public.is_admin() then coalesce(pf.nickname, '기록자') end, r.user_id = auth.uid(),
         r.noise, r.spacing, r.light, r.outlet, r.stay, r.materials, r.furniture, r.note, r.visited_on, r.created_at,
         pl.kakao_id, pl.name, pl.type, pl.address, pl.lat, pl.lng,
         r.entrance, r.floor_access, r.toilet, r.kids, r.pets, r.photo_paths,
         r.parking, r.hood, r.step_cm, r.noise_db, r.visit_hour
  from public.records r
  join public.places pl on pl.id = r.place_id
  left join public.profiles pf on pf.id = r.user_id
  where r.is_public and not r.hidden
  order by r.created_at desc
  limit 2000;
$$;
grant execute on function public.public_records() to anon, authenticated;
