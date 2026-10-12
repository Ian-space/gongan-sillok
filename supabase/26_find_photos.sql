-- 공간실록 26단계: '사진으로 찾기'에 쓴 사진을 고른 장소와 짝지어 모으기 (동의한 경우만)
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (05_photos.sql까지 실행했어야 한다)
--
-- 규칙 요약
--   언제      : 기록 창 '사진+위치로 찾기'에서 이용자가 "정확도를 높이는 데 써도 돼요"를 직접 체크하고 장소를 골랐을 때만
--   저장 위치 : 비공개 저장소(finds)의 '내 사용자 번호/임의 번호.jpg'. 화면 어디에도 보여 주지 않는다
--   함께 저장 : 고른 장소(카카오 번호·이름·업종·좌표), 사진에서 읽은 글자, 사진 종류. 찍은 사람의 위치는 저장하지 않는다
--   보기      : 관리자만(본인은 탈퇴 때 지우려고 자기 파일 목록만)
--   보관      : 1년. 중계 서버가 매일 1년 지난 것을 지운다(worker.js scheduled). 탈퇴하면 함께 지운다

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finds', 'finds', false, 2097152, array['image/jpeg']);

create table public.find_photos (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  path text not null unique check (path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'),
  kakao_id text check (kakao_id ~ '^[0-9]{1,15}$'),
  place_name text not null check (char_length(place_name) between 1 and 60),
  category text check (char_length(category) <= 80),
  lat double precision not null check (lat between 33 and 39),
  lng double precision not null check (lng between 124 and 132),
  sign text check (char_length(sign) <= 30),
  kind text check (kind in ('입구', '내부', '화장실', '외관', '층 이동', '안내문', '기타')),
  created_at timestamptz not null default now(),
  check (split_part(path, '/', 1) = user_id::text)
);
create index find_photos_created on public.find_photos (created_at);
alter table public.find_photos enable row level security;

-- 넣기: 로그인한 사람이 내 것만. 보기: 관리자만. 지우기: 나와 관리자
grant insert (path, kakao_id, place_name, category, lat, lng, sign, kind) on public.find_photos to authenticated;
grant select, delete on public.find_photos to authenticated;
create policy "find_photos: 내 것만 넣기" on public.find_photos for insert to authenticated
  with check (user_id = auth.uid());
create policy "find_photos: 관리자만 보기" on public.find_photos for select to authenticated
  using (public.is_admin());
create policy "find_photos: 내 것 지우기, 관리자도" on public.find_photos for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- 저장소 권한: 내 폴더에만 올리기, 보기는 나(탈퇴 때 목록)와 관리자, 지우기도 나와 관리자
create policy "finds: 내 폴더에 올리기" on storage.objects for insert to authenticated
  with check (bucket_id = 'finds' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "finds: 나와 관리자만 보기" on storage.objects for select to authenticated
  using (bucket_id = 'finds' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy "finds: 내 것 지우기, 관리자도" on storage.objects for delete to authenticated
  using (bucket_id = 'finds' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
