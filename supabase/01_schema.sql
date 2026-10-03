-- 공간실록 1단계: 장소, 기록, 사용자 표와 권한 규칙
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run.
--
-- 규칙 요약
--   장소(places)  : 누구나 읽기, 로그인하면 추가, 수정·삭제는 관리자만
--   기록(records) : 공개 기록은 누구나 읽기, 내 기록(나만 보기 포함)은 나만 읽고 쓰기, 관리자는 모두 읽고 지우기
--                   한 사람은 한 장소에 기록 하나(중복 방지). 숨김(hidden)은 관리자만 대시보드에서 바꾼다
--   사용자(profiles): 가입하면 자동으로 생기고, 나는 내 닉네임만 바꿀 수 있다. 역할(role)은 대시보드에서만 바꾼다

-- 사용자
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text check (char_length(nickname) <= 30),
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

-- 장소 (공용, 한 곳에 한 줄)
create table public.places (
  id bigint generated always as identity primary key,
  kakao_id text unique,                                   -- 카카오 장소 번호(있으면 같은 곳 중복을 막는다)
  name text not null check (char_length(name) between 1 and 40),
  type text check (char_length(type) <= 20),
  address text check (char_length(address) <= 60),
  lat double precision not null check (lat between 33 and 39),     -- 국내 좌표만
  lng double precision not null check (lng between 124 and 132),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 기록 (사람마다, 장소마다 하나)
create table public.records (
  id bigint generated always as identity primary key,
  place_id bigint not null references public.places(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  noise text check (noise in ('조용함', '보통', '시끄러움')),
  spacing text check (spacing in ('넓음', '보통', '좁음')),
  light text check (light in ('밝음', '보통', '어두움')),
  outlet text check (outlet in ('많음', '일부', '없음')),
  stay text check (stay in ('장시간 가능', '2시간 내외', '회전 빠름')),
  materials text check (char_length(materials) <= 80),
  furniture text check (char_length(furniture) <= 80),
  note text check (char_length(note) <= 200),
  visited_on date,
  is_public boolean not null default false,               -- 기본은 나만 보기
  hidden boolean not null default false,                  -- 관리자가 숨긴 기록
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (place_id, user_id)
);
create index records_place_idx on public.records (place_id);

-- 관리자인지 확인 (권한 규칙 안에서 쓴다)
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- 가입하면 사용자 줄을 자동으로 만든다 (닉네임은 로그인 서비스가 준 이름)
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'nickname', '기록자'), 30));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 기록을 고치면 고친 시각을 남긴다
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger records_touch before update on public.records
  for each row execute function public.touch_updated_at();

-- 행 단위 권한(RLS) 켜기
alter table public.profiles enable row level security;
alter table public.places enable row level security;
alter table public.records enable row level security;

-- 표·칸 단위 권한: 사용자가 바꿀 수 있는 칸만 연다 (user_id, created_by, role, hidden은 열지 않는다)
grant usage on schema public to anon, authenticated;
grant select on public.places to anon, authenticated;
grant insert (kakao_id, name, type, address, lat, lng) on public.places to authenticated;
grant update (name, type, address, lat, lng) on public.places to authenticated;  -- 실제로는 아래 규칙으로 관리자만
grant delete on public.places to authenticated;                                  -- 실제로는 관리자만
-- 로그인 안 한 사람은 기록을 쓴 사람(user_id)을 볼 수 없다
grant select (id, place_id, noise, spacing, light, outlet, stay, materials, furniture, note, visited_on, is_public, created_at, updated_at) on public.records to anon;
grant select on public.records to authenticated;
grant insert (place_id, noise, spacing, light, outlet, stay, materials, furniture, note, visited_on, is_public) on public.records to authenticated;
grant update (noise, spacing, light, outlet, stay, materials, furniture, note, visited_on, is_public) on public.records to authenticated;
grant delete on public.records to authenticated;
grant select on public.profiles to authenticated;
grant update (nickname) on public.profiles to authenticated;

-- 장소
create policy "places: 누구나 읽기" on public.places for select to anon, authenticated using (true);
create policy "places: 로그인하면 추가" on public.places for insert to authenticated with check (created_by = auth.uid());
create policy "places: 관리자만 수정" on public.places for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "places: 관리자만 삭제" on public.places for delete to authenticated using (public.is_admin());

-- 기록
create policy "records: 공개 기록은 누구나 읽기" on public.records for select to anon, authenticated using (is_public and not hidden);
create policy "records: 내 기록은 내가 읽기" on public.records for select to authenticated using (user_id = auth.uid());
create policy "records: 관리자는 모두 읽기" on public.records for select to authenticated using (public.is_admin());
create policy "records: 내 기록 쓰기" on public.records for insert to authenticated with check (user_id = auth.uid());
create policy "records: 내 기록 고치기" on public.records for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "records: 내 기록 지우기, 관리자도 지우기" on public.records for delete to authenticated using (user_id = auth.uid() or public.is_admin());

-- 사용자
create policy "profiles: 나와 관리자만 읽기" on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy "profiles: 내 닉네임만 바꾸기" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
