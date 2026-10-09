-- 공간실록 22단계: 기록에는 내 사진만 넣을 수 있게
-- 사진 목록(photo_paths)은 모양('사용자 번호/임의 번호.jpg')만 검사해서, 다른 사람 사진 주소를 내 공개 기록에 넣으면
-- 그 사진이 공개로 보였다(운영자가 숨긴 기록의 사진도 다시 보일 수 있었다). 사진의 폴더가 기록 주인과 같을 때만 받는다.
-- Supabase SQL Editor에서 전체를 Run. (이미 있는 기록이 규칙에 어긋나면 오류가 나고 아무것도 바뀌지 않는다)

create or replace function public.photos_owned(p text[], owner uuid) returns boolean
language sql immutable set search_path = '' as $$
  select not exists (select 1 from unnest(p) x where split_part(x, '/', 1) <> owner::text);
$$;

alter table public.records add constraint records_photos_owned check (public.photos_owned(photo_paths, user_id));
