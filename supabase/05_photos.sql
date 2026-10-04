-- 공간실록 6단계: 기록마다 사진 한 장
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (01~04를 먼저 실행했어야 한다)
--
-- 규칙 요약
--   저장 위치  : 비공개 저장소(photos)의 '내 사용자 번호/임의 번호.jpg'. 사이트가 올리기 전에 크기를 줄이고 위치 정보(EXIF)를 지운다
--   보기       : 공개 중이고 숨겨지지 않은 기록의 사진은 누구나, 내 사진은 나만, 관리자는 모두 (주소는 1시간짜리 임시 주소로 준다)
--   올리기·지우기: 로그인한 사람이 내 폴더에만. 관리자는 지울 수도 있다
--   크기       : 한 장 2MB 이하 JPEG

alter table public.records
  add column photo_path text check (photo_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$');
grant select (photo_path) on public.records to anon;
grant insert (photo_path) on public.records to authenticated;
grant update (photo_path) on public.records to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 2097152, array['image/jpeg']);

-- 이 사진이 공개 중인 기록의 사진인지 (권한 규칙 안에서 쓴다. 숨김 여부는 일반 사용자가 못 읽는 칸이라 함수로 본다)
create function public.photo_is_public(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.records r where r.photo_path = p_path and r.is_public and not r.hidden);
$$;
grant execute on function public.photo_is_public(text) to anon, authenticated;

create policy "photos: 보기" on storage.objects for select to anon, authenticated
  using (bucket_id = 'photos' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_admin()
    or public.photo_is_public(name)));
create policy "photos: 내 폴더에 올리기" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos: 내 사진 지우기, 관리자도 지우기" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- 공개 기록 함수에 사진 칸을 더한다 (돌려주는 모양이 바뀌어서 지우고 다시 만든다)
drop function public.public_records();
create function public.public_records() returns table (
  id bigint, place_id bigint, nickname text, mine boolean,
  noise text, spacing text, light text, outlet text, stay text, materials text, furniture text, note text,
  visited_on date, created_at timestamptz,
  kakao_id text, place_name text, place_type text, place_address text, lat double precision, lng double precision,
  entrance text, floor_access text, toilet text, kids text, pets text, photo_path text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.place_id, case when public.is_admin() then coalesce(pf.nickname, '기록자') end, r.user_id = auth.uid(),
         r.noise, r.spacing, r.light, r.outlet, r.stay, r.materials, r.furniture, r.note, r.visited_on, r.created_at,
         pl.kakao_id, pl.name, pl.type, pl.address, pl.lat, pl.lng,
         r.entrance, r.floor_access, r.toilet, r.kids, r.pets, r.photo_path
  from public.records r
  join public.places pl on pl.id = r.place_id
  left join public.profiles pf on pf.id = r.user_id
  where r.is_public and not r.hidden
  order by r.created_at desc
  limit 2000;
$$;
grant execute on function public.public_records() to anon, authenticated;

-- 관리자 신고 목록에도 사진을 함께 준다 (신고된 사진을 보고 판단할 수 있게)
drop function public.admin_reports();
create function public.admin_reports() returns table (
  record_id bigint, place_name text, nickname text, noise text, outlet text, note text, materials text, furniture text,
  hidden boolean, is_public boolean, report_count bigint, open_count bigint, reasons text[], details text[], last_reported timestamptz,
  photo_path text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception '관리자만 볼 수 있어요'; end if;
  return query
    select r.id, pl.name, coalesce(pf.nickname, '기록자'), r.noise, r.outlet, r.note, r.materials, r.furniture,
           r.hidden, r.is_public, count(rp.id), count(rp.id) filter (where rp.status in ('open', 'auto_hidden')),
           array_agg(rp.reason order by rp.created_at desc), array_remove(array_agg(rp.detail order by rp.created_at desc), null),
           max(rp.created_at), r.photo_path
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
