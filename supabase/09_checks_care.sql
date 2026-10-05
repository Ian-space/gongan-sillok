-- 공간실록 10단계: 일치율(지금도 맞나요?)과 최종 확인일, 돌봄 항목(기저귀 교환대, 심야 영업)
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (08_measures.sql까지 실행했어야 한다)

-- 1) 돌봄 항목: 비워 두면 모름
alter table public.records
  add column diaper     text check (diaper     in ('매장 안에 있음', '건물에 있음', '없음')),
  add column late_night text check (late_night in ('24시간', '자정 넘어 영업', '자정 전 마감'));
grant select (diaper, late_night) on public.records to anon;
grant insert (diaper, late_night) on public.records to authenticated;
grant update (diaper, late_night) on public.records to authenticated;

-- 2) 일치율: 장소를 본 사람이 "지금도 맞아요 / 달라졌어요"를 한 번 누른다.
--    한 사람은 한 장소에 응답 하나만 가진다(다시 누르면 바뀌고 시각이 새로 찍힌다). 계정을 지우면 함께 지워진다
create table public.checks (
  id bigint generated always as identity primary key,
  place_id bigint not null references public.places(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  answer text not null check (answer in ('same', 'changed')),
  created_at timestamptz not null default now(),
  unique (user_id, place_id)
);
create index checks_place_idx on public.checks (place_id);
alter table public.checks enable row level security;
grant select on public.checks to authenticated;
create policy "checks: 내 응답만 보기" on public.checks for select to authenticated using (user_id = auth.uid());

-- 응답 남기기: 아래 함수로만 쓴다(같은 사람이 다시 누르면 바꾼다)
create function public.check_place(p_place bigint, p_answer text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  insert into public.checks (place_id, user_id, answer) values (p_place, auth.uid(), p_answer)
  on conflict (user_id, place_id) do update set answer = excluded.answer, created_at = now();
end;
$$;
revoke execute on function public.check_place(bigint, text) from public, anon;
grant execute on function public.check_place(bigint, text) to authenticated;

-- 장소별 모아 보기: 누가 눌렀는지는 내보내지 않는다
create function public.place_checks() returns table (place_id bigint, same_n bigint, changed_n bigint, last_same timestamptz, last_any timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.place_id, count(*) filter (where c.answer = 'same'), count(*) filter (where c.answer = 'changed'),
         max(c.created_at) filter (where c.answer = 'same'), max(c.created_at)
  from public.checks c group by c.place_id;
$$;
grant execute on function public.place_checks() to anon, authenticated;

-- 3) 공개 기록 함수: 돌봄 칸 두 개를 맨 뒤에 더한다
drop function public.public_records();
create function public.public_records() returns table (
  id bigint, place_id bigint, nickname text, mine boolean,
  noise text, spacing text, light text, outlet text, stay text, materials text, furniture text, note text,
  visited_on date, created_at timestamptz,
  kakao_id text, place_name text, place_type text, place_address text, lat double precision, lng double precision,
  entrance text, floor_access text, toilet text, kids text, pets text, photo_paths text[],
  parking text, hood text, step_cm smallint, noise_db smallint, visit_hour smallint,
  diaper text, late_night text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.place_id, case when public.is_admin() then coalesce(pf.nickname, '기록자') end, r.user_id = auth.uid(),
         r.noise, r.spacing, r.light, r.outlet, r.stay, r.materials, r.furniture, r.note, r.visited_on, r.created_at,
         pl.kakao_id, pl.name, pl.type, pl.address, pl.lat, pl.lng,
         r.entrance, r.floor_access, r.toilet, r.kids, r.pets, r.photo_paths,
         r.parking, r.hood, r.step_cm, r.noise_db, r.visit_hour,
         r.diaper, r.late_night
  from public.records r
  join public.places pl on pl.id = r.place_id
  left join public.profiles pf on pf.id = r.user_id
  where r.is_public and not r.hidden
  order by r.created_at desc
  limit 2000;
$$;
grant execute on function public.public_records() to anon, authenticated;
