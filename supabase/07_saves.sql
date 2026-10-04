-- 공간실록 8단계: 찜 (내 장소 모아 보기)
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run.
-- 찜은 나만 보고 나만 바꾼다. 공간실록에 기록이 없는 카카오 장소도 찜할 수 있도록 이름과 좌표를 함께 둔다.
-- 탈퇴하면 계정을 따라 지워진다 (on delete cascade).

create table public.saves (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 80),          -- 같은 곳을 두 번 찜하지 않도록: 카카오 번호, 공용 장소 번호, 또는 이름+좌표
  name text not null check (char_length(name) between 1 and 40),
  lat double precision not null check (lat between 33 and 39),
  lng double precision not null check (lng between 124 and 132),
  kid text check (kid ~ '^\d{1,20}$'),
  pid bigint,
  category text check (char_length(category) <= 100),
  addr text check (char_length(addr) <= 60),
  created_at timestamptz not null default now(),
  unique (user_id, key)
);
create index saves_user_idx on public.saves (user_id);
alter table public.saves enable row level security;
grant select, delete on public.saves to authenticated;
grant insert (key, name, lat, lng, kid, pid, category, addr) on public.saves to authenticated;
create policy "saves: 내 찜만 보기" on public.saves for select to authenticated using (user_id = auth.uid());
create policy "saves: 내 찜 더하기" on public.saves for insert to authenticated with check (user_id = auth.uid());
create policy "saves: 내 찜 지우기" on public.saves for delete to authenticated using (user_id = auth.uid());
