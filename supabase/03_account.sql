-- 공간실록 4단계: 회원 탈퇴
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 Run. (01, 02를 먼저 실행했어야 한다)
--
-- 탈퇴하면 바로 지운다
--   계정(auth.users)             → 지움. 로그인 기록·세션도 함께 지워진다
--   사용자(profiles)             → 계정을 따라 지워진다 (on delete cascade)
--   내 기록(records, 공개·비공개) → 계정을 따라 지워진다
--   내가 한 신고(reports)        → 계정을 따라 지워진다
--   내 기록에 들어온 신고        → 기록을 따라 지워진다
--   내가 추가한 장소(places)     → 다른 사람 기록이 없으면 지운다. 다른 사람 기록이 있으면 남기고 추가한 사람 칸만 비운다

create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception '로그인이 필요해요'; end if;
  -- 내가 추가했고, 다른 사람 기록이 없는 장소 (직접 입력한 장소 이름·좌표가 남지 않도록)
  delete from public.places p
    where p.created_by = uid
      and not exists (select 1 from public.records r where r.place_id = p.id and r.user_id <> uid);
  delete from auth.users where id = uid;
end;
$$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
