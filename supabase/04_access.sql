-- 공간실록 5단계: 접근·동반 항목 (입구, 층 이동, 화장실, 아이 동반, 반려동물)
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (01~03을 먼저 실행했어야 한다)
-- 모두 고르지 않아도 되는 칸이라, 지금까지의 기록은 그대로 유효하다(빈 값).

alter table public.records
  add column entrance     text check (entrance     in ('턱 없음', '경사로 있음', '계단 있음')),
  add column floor_access text check (floor_access in ('1층', '엘리베이터 있음', '계단만')),
  add column toilet       text check (toilet       in ('매장 안', '건물 공용', '없음')),
  add column kids         text check (kids         in ('유아 의자 있음', '동반 가능', '노키즈존')),
  add column pets         text check (pets         in ('실내 가능', '야외만', '불가'));

-- 칸 단위 권한: 로그인 안 한 사람도 공개 기록의 새 칸을 읽고, 로그인한 사람은 내 기록에 쓰고 고친다
grant select (entrance, floor_access, toilet, kids, pets) on public.records to anon;
grant insert (entrance, floor_access, toilet, kids, pets) on public.records to authenticated;
grant update (entrance, floor_access, toilet, kids, pets) on public.records to authenticated;

-- 공개 기록 함수에 새 칸을 더한다 (돌려주는 모양이 바뀌어서 지우고 다시 만든다)
drop function public.public_records();
create function public.public_records() returns table (
  id bigint, place_id bigint, nickname text, mine boolean,
  noise text, spacing text, light text, outlet text, stay text, materials text, furniture text, note text,
  visited_on date, created_at timestamptz,
  kakao_id text, place_name text, place_type text, place_address text, lat double precision, lng double precision,
  entrance text, floor_access text, toilet text, kids text, pets text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.place_id, case when public.is_admin() then coalesce(pf.nickname, '기록자') end, r.user_id = auth.uid(),
         r.noise, r.spacing, r.light, r.outlet, r.stay, r.materials, r.furniture, r.note, r.visited_on, r.created_at,
         pl.kakao_id, pl.name, pl.type, pl.address, pl.lat, pl.lng,
         r.entrance, r.floor_access, r.toilet, r.kids, r.pets
  from public.records r
  join public.places pl on pl.id = r.place_id
  left join public.profiles pf on pf.id = r.user_id
  where r.is_public and not r.hidden
  order by r.created_at desc
  limit 2000;
$$;
grant execute on function public.public_records() to anon, authenticated;
