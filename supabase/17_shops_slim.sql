-- 공간실록 18단계: 쓰지 않는 상가 색인 지우기 (DB 용량 줄이기)
-- 검색은 13번의 '상호+지점(띄어쓰기 뺌)' 색인을, 지도 영역은 15번의 2차원 좌표 색인을 쓴다.
-- 처음(12번)에 만든 두 색인은 이제 쓰지 않아서 자리만 차지한다. 지우면 바로 공간이 돌아온다.
-- Supabase SQL Editor에서 전체를 Run.

drop index if exists public.shops_name_trgm_idx;  -- 상호만 본 글자 색인(13번 색인으로 바뀜)
drop index if exists public.shops_lat_lng_idx;    -- 위도·경도 색인(15번 2차원 색인으로 바뀜)

-- 지운 뒤 크기 확인용: 표와 색인이 각각 얼마나 쓰는지
select pg_size_pretty(pg_table_size('public.shops'))   as table_size,
       pg_size_pretty(pg_indexes_size('public.shops')) as index_size,
       pg_size_pretty(pg_database_size(current_database())) as database_size;
