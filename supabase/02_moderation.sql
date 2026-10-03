-- 공간실록 3단계: 신고, 자동 숨김, 관리자 숨기기, 공개 기록 닉네임
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (01_schema.sql을 먼저 실행했어야 한다)
--
-- 규칙 요약
--   신고(reports) : 로그인한 사람이 다른 사람의 공개 기록을 신고한다. 한 기록에 한 사람 한 번.
--                   이유는 광고·홍보 / 욕설·불쾌한 내용 / 개인정보 노출 / 기타. ('사실과 다름'은 신고 대신 내 기록을 더해 바로잡는다)
--   자동 숨김      : 처리 전 신고가 설정값(처음 5건) 이상 쌓이면 그 기록을 일단 숨긴다. 관리자가 되돌릴 수 있다.
--   관리자         : 기록 숨기기·되돌리기, 신고 무시하기, 신고 목록 보기
--   공개 기록      : 작성자 닉네임과 함께 보여 준다(누가 썼는지 알 수 있는 다른 정보는 내보내지 않는다)

-- 설정 (자동 숨김 기준 등). 사용자는 읽거나 바꿀 수 없고, 대시보드나 SQL로만 바꾼다
create table public.app_settings (
  key text primary key,
  value text not null
);
alter table public.app_settings enable row level security;
insert into public.app_settings (key, value) values ('auto_hide_reports', '5');
-- 기준을 바꾸려면: update public.app_settings set value = '10' where key = 'auto_hide_reports';

-- 신고
create table public.reports (
  id bigint generated always as identity primary key,
  record_id bigint not null references public.records(id) on delete cascade,
  reporter uuid not null default auth.uid() references auth.users(id) on delete cascade,
  reason text not null check (reason in ('광고·홍보', '욕설·불쾌한 내용', '개인정보 노출', '기타')),
  detail text check (char_length(detail) <= 200),
  status text not null default 'open' check (status in ('open', 'auto_hidden', 'hidden', 'dismissed')),
  created_at timestamptz not null default now(),
  unique (record_id, reporter)
);
create index reports_record_idx on public.reports (record_id);
alter table public.reports enable row level security;
grant insert (record_id, reason, detail) on public.reports to authenticated;
grant select on public.reports to authenticated;
-- 다른 사람의, 지금 공개 중인 기록만 신고할 수 있다
create policy "reports: 로그인하면 신고" on public.reports for insert to authenticated
  with check (reporter = auth.uid() and exists (
    select 1 from public.records r where r.id = record_id and r.is_public and not r.hidden and r.user_id <> auth.uid()));
create policy "reports: 내 신고와 관리자만 보기" on public.reports for select to authenticated
  using (reporter = auth.uid() or public.is_admin());

-- 신고가 기준 이상 쌓이면 자동으로 숨긴다
create function public.auto_hide_on_reports() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  limit_n int;
  n int;
begin
  select coalesce(nullif(value, '')::int, 5) into limit_n from public.app_settings where key = 'auto_hide_reports';
  limit_n := coalesce(limit_n, 5);
  select count(*) into n from public.reports where record_id = new.record_id and status = 'open';
  if n >= limit_n then
    update public.records set hidden = true where id = new.record_id;
    update public.reports set status = 'auto_hidden' where record_id = new.record_id and status = 'open';
  end if;
  return new;
end;
$$;
create trigger reports_auto_hide after insert on public.reports
  for each row execute function public.auto_hide_on_reports();

-- 관리자: 기록 숨기기(p_hide = true) / 되돌리면서 신고 무시하기(p_hide = false)
create function public.moderate_record(p_record_id bigint, p_hide boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception '관리자만 할 수 있어요'; end if;
  update public.records set hidden = p_hide where id = p_record_id;
  update public.reports set status = case when p_hide then 'hidden' else 'dismissed' end
    where record_id = p_record_id and status in ('open', 'auto_hidden', 'hidden');
end;
$$;
revoke execute on function public.moderate_record(bigint, boolean) from public, anon;
grant execute on function public.moderate_record(bigint, boolean) to authenticated;

-- 관리자: 신고가 들어온 기록 목록
create function public.admin_reports() returns table (
  record_id bigint, place_name text, nickname text, noise text, outlet text, note text, materials text, furniture text,
  hidden boolean, is_public boolean, report_count bigint, open_count bigint, reasons text[], details text[], last_reported timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception '관리자만 볼 수 있어요'; end if;
  return query
    select r.id, pl.name, coalesce(pf.nickname, '기록자'), r.noise, r.outlet, r.note, r.materials, r.furniture,
           r.hidden, r.is_public, count(rp.id), count(rp.id) filter (where rp.status in ('open', 'auto_hidden')),
           array_agg(rp.reason order by rp.created_at desc), array_remove(array_agg(rp.detail order by rp.created_at desc), null),
           max(rp.created_at)
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

-- 공개 기록 + 작성자 닉네임 (로그인하지 않아도 볼 수 있다). 사용자 번호는 내보내지 않고 '내 기록인지'만 알려 준다
create function public.public_records() returns table (
  id bigint, place_id bigint, nickname text, mine boolean,
  noise text, spacing text, light text, outlet text, stay text, materials text, furniture text, note text,
  visited_on date, created_at timestamptz,
  kakao_id text, place_name text, place_type text, place_address text, lat double precision, lng double precision)
language sql stable security definer set search_path = '' as $$
  select r.id, r.place_id, coalesce(pf.nickname, '기록자'), r.user_id = auth.uid(),
         r.noise, r.spacing, r.light, r.outlet, r.stay, r.materials, r.furniture, r.note, r.visited_on, r.created_at,
         pl.kakao_id, pl.name, pl.type, pl.address, pl.lat, pl.lng
  from public.records r
  join public.places pl on pl.id = r.place_id
  left join public.profiles pf on pf.id = r.user_id
  where r.is_public and not r.hidden
  order by r.created_at desc
  limit 2000;
$$;
grant execute on function public.public_records() to anon, authenticated;

-- 관리자 역할도 알려 준다 (내 닉네임과 역할)
create function public.my_profile() returns table (nickname text, role text)
language sql stable security definer set search_path = '' as $$
  select nickname, role from public.profiles where id = auth.uid();
$$;
revoke execute on function public.my_profile() from public, anon;
grant execute on function public.my_profile() to authenticated;
