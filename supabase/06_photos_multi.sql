-- 공간실록 7단계: 기록마다 사진 여러 장 (최대 5장)
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (05_photos.sql을 먼저 실행했어야 한다)
-- 사진 한 장 칸(photo_path)을 여러 장 칸(photo_paths)으로 옮기고, 한 장 칸은 지운다. 이미 올린 사진은 그대로 남는다.

-- 사진 목록이 올바른지: 5장 이하, 모두 '사용자 번호/임의 번호.jpg' 모양
create function public.valid_photo_paths(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(array_length(p, 1), 0) <= 5
     and not exists (select 1 from unnest(p) x where x is null or x !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$');
$$;

alter table public.records add column photo_paths text[] not null default '{}' check (public.valid_photo_paths(photo_paths));
update public.records set photo_paths = array[photo_path] where photo_path is not null;
grant select (photo_paths) on public.records to anon;
grant insert (photo_paths) on public.records to authenticated;
grant update (photo_paths) on public.records to authenticated;

-- 사진 보기 권한: 공개 중인 기록의 사진 목록에 들어 있으면 누구나
create or replace function public.photo_is_public(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.records r where p_path = any(r.photo_paths) and r.is_public and not r.hidden);
$$;

-- 공개 기록 함수: photo_path 대신 photo_paths
drop function public.public_records();
create function public.public_records() returns table (
  id bigint, place_id bigint, nickname text, mine boolean,
  noise text, spacing text, light text, outlet text, stay text, materials text, furniture text, note text,
  visited_on date, created_at timestamptz,
  kakao_id text, place_name text, place_type text, place_address text, lat double precision, lng double precision,
  entrance text, floor_access text, toilet text, kids text, pets text, photo_paths text[])
language sql stable security definer set search_path = '' as $$
  select r.id, r.place_id, case when public.is_admin() then coalesce(pf.nickname, '기록자') end, r.user_id = auth.uid(),
         r.noise, r.spacing, r.light, r.outlet, r.stay, r.materials, r.furniture, r.note, r.visited_on, r.created_at,
         pl.kakao_id, pl.name, pl.type, pl.address, pl.lat, pl.lng,
         r.entrance, r.floor_access, r.toilet, r.kids, r.pets, r.photo_paths
  from public.records r
  join public.places pl on pl.id = r.place_id
  left join public.profiles pf on pf.id = r.user_id
  where r.is_public and not r.hidden
  order by r.created_at desc
  limit 2000;
$$;
grant execute on function public.public_records() to anon, authenticated;

-- 관리자 신고 목록: 사진 여러 장
drop function public.admin_reports();
create function public.admin_reports() returns table (
  record_id bigint, place_name text, nickname text, noise text, outlet text, note text, materials text, furniture text,
  hidden boolean, is_public boolean, report_count bigint, open_count bigint, reasons text[], details text[], last_reported timestamptz,
  photo_paths text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception '관리자만 볼 수 있어요'; end if;
  return query
    select r.id, pl.name, coalesce(pf.nickname, '기록자'), r.noise, r.outlet, r.note, r.materials, r.furniture,
           r.hidden, r.is_public, count(rp.id), count(rp.id) filter (where rp.status in ('open', 'auto_hidden')),
           array_agg(rp.reason order by rp.created_at desc), array_remove(array_agg(rp.detail order by rp.created_at desc), null),
           max(rp.created_at), r.photo_paths
    from public.reports rp
    join public.records r on r.id = rp.record_id
    join public.places pl on pl.id = r.place_id
    left join public.profiles pf on pf.id = r.user_id
    group by r.id, pl.name, pf.nickname
    order by count(rp.id) filter (where rp.status in ('open', 'auto_hidden')) desc, max(rp.created_at) desc;
end;
$$;
revoke execute on function public.admin_reports() from public, anon;
grant execute on function public.admin_reports() to authenticated;

-- 한 장 칸은 더 이상 쓰지 않는다
alter table public.records drop column photo_path;
