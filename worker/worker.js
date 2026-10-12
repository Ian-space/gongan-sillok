// 공간실록 중계 서버 (Cloudflare Worker)
// - 외부 서비스 키(TMAP, 카카오, Anthropic)를 사이트 코드 대신 여기 비밀 변수에만 둔다.
//     TMAP_APP_KEY      : TMAP 대중교통·보행자 경로
//     KAKAO_REST_KEY    : 카카오 로컬 장소 검색 (REST API 키)
//     ANTHROPIC_API_KEY : AI 조건 찾기·사진 보고 채우기
//     DATA_GO_KR_KEY    : 공공데이터포털 인증키(아파트 단지 공식 정보, 건축물대장, 서울·경기 버스 도착)
//     SEOUL_SUBWAY_KEY  : 서울 열린데이터광장 실시간 지하철 인증키
// - 결과 저장: KV 바인딩 ROUTE_CACHE. 횟수 제한: 바인딩 LIMIT_ROUTE·LIMIT_PLACE (wrangler.toml)
// - 공간실록 사이트에서 온 요청만 받는다. AI는 로그인한 사람만(Supabase 로그인 토큰을 확인한다).
//
// 경로
//   POST /transit  { startX, startY, endX, endY, searchDttm? }  → TMAP 대중교통
//   POST /walk     { startX, startY, endX, endY }               → TMAP 보행자 경로
//   POST /search   { query, x?, y?, sort?, page? }              → 카카오 키워드 장소 검색 (x, y가 있으면 그 근처부터)
//   POST /station  { x, y }                                     → 1.5km 안 지하철역 (가까운 순)
//   POST /addr     { x, y }                                     → 그 자리의 도로명주소·건물명 (카카오 좌표→주소)
//   POST /apt      { bjd, road?, lot?, name? }                  → 누른 아파트 단지의 공식 이름·주소·동수·세대수 (공공데이터포털)
//   POST /bldreg   { pnu: 필지 번호 19자리 }                     → 그 필지 건물들의 승강기 수·층수·주용도 (건축물대장)
//   POST /arrive   { type: bus|subway, city?, ars?, station? }     → 버스·지하철 실시간 도착 (서울 버스, 경기 버스, 서울 실시간 지하철)
//   POST /elev     { station }                                  → 지하철역 엘리베이터(출구·층·운행 상태, 서울교통공사 1~8호선)
//   POST /nearby   { rect: "왼쪽X,아래Y,오른쪽X,위Y", code? }      → 지도 한 칸 안의 장소 (NEARBY의 업종 코드)
//   POST /intent   { text }                                     → 글로 적은 목적을 기록 항목 조건으로 (로그인 필요)
//   POST /photo    { images: [base64 JPEG, 최대 3장] }          → 사진에서 눈으로 확인되는 기록 항목 제안 (로그인 필요)

const ALLOWED_ORIGINS = ['https://ian-space.github.io', 'http://localhost:8765'];
const VERSION = '2026-10-12.9'; // 응답 머리말 X-GS-Version. 자동 배포가 됐는지 확인할 때 본다
// 로그인 확인용 Supabase 주소와 공개 키(사이트 코드에도 있는 공개 값)
const SUPABASE_URL = 'https://qktrghajroxddrbpwtvn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_j-kp8YKsQTczGcsQX74OxA_mfI7DoZw';
// AI 하루 한도: 한 사람당 / 전체. 넘으면 429와 함께 Cloudflare 로그에 회원번호·IP를 남긴다(남용 확인용)
const AI_LIMITS = { intent: { user: 30, day: 1000 }, photo: { user: 20, day: 200 } };
// 경로 결과 저장 시간(초)
const CACHE_SECONDS = { transit: 600, walk: 86400 };
// 주변 장소 종류. 카카오 업종 코드로 찾고, 업종 분류가 없는 도서관은 검색어로 찾은 뒤 분류에 '도서관'이 있는 곳만 남긴다
const NEARBY = {
  CS2: { api: 'category', params: { category_group_code: 'CS2' } }, // 편의점
  CE7: { api: 'category', params: { category_group_code: 'CE7' } }, // 카페
  FD6: { api: 'category', params: { category_group_code: 'FD6' } }, // 음식점
  PM9: { api: 'category', params: { category_group_code: 'PM9' } }, // 약국
  BK9: { api: 'category', params: { category_group_code: 'BK9' } }, // 은행
  CT1: { api: 'category', params: { category_group_code: 'CT1' } }, // 문화시설
  HP8: { api: 'category', params: { category_group_code: 'HP8' } }, // 병원
  AT4: { api: 'category', params: { category_group_code: 'AT4' } }, // 관광명소
  PO3: { api: 'category', params: { category_group_code: 'PO3' } }, // 공공기관
  MT1: { api: 'category', params: { category_group_code: 'MT1' } }, // 대형마트
  PS3: { api: 'category', params: { category_group_code: 'PS3' } }, // 어린이집·유치원
  LIB: { api: 'keyword', params: { query: '도서관' }, keep: d => /도서관/.test(d.category_name || '') },
};

// 글로 적은 목적 → 조건(/intent): 사이트의 기록 항목과 같아야 한다(index.html ENUMS, TAGS)
const AI_MODEL = 'claude-haiku-4-5-20251001';
const AI_FIELDS = {
  noise:    { label: '소음', values: ['조용함', '보통', '시끄러움'] },
  spacing:  { label: '좌석 간격', values: ['넓음', '보통', '좁음'] },
  light:    { label: '채광', values: ['밝음', '보통', '어두움'] },
  lamp:     { label: '조명 색', values: ['따뜻한 빛', '하얀 빛', '섞여 있음'] },
  outlet:   { label: '콘센트', values: ['많음', '일부', '없음'] },
  stay:     { label: '머무르기', values: ['장시간 가능', '2시간 내외', '회전 빠름'] },
  hood:     { label: '고기 굽는 곳 배기', values: ['하향식', '상향식', '후드 없음'] },
  entrance: { label: '입구', values: ['턱 없음', '경사로 있음', '턱·계단 있음'] },
  floor:    { label: '층 이동', values: ['1층', '엘리베이터 있음', '계단만'] },
  toilet:   { label: '화장실', values: ['매장 안', '건물 공용', '없음'] },
  kids:     { label: '아이 동반', values: ['유아 의자 있음', '동반 가능', '노키즈존'] },
  pets:     { label: '반려동물', values: ['실내 가능', '야외만', '불가'] },
  parking:  { label: '주차', values: ['전용 주차장', '근처 유료 주차', '주차 불가'] },
  diaper:   { label: '기저귀 교환대', values: ['매장 안에 있음', '건물에 있음', '없음'] },
  late:     { label: '심야 영업', values: ['24시간', '자정 넘어 영업', '자정 전 마감'] },
  furniture:{ label: '좌석 종류', tag: true, values: ['등받이 의자', '스툴(등받이 없음)', '소파·쿠션', '높은 바 좌석', '좌식', '큰 공용 테이블', '1인석', '야외 자리'] },
  materials:{ label: '눈에 보이는 마감', tag: true, values: ['나무', '콘크리트', '타일', '벽돌', '돌', '유리', '금속', '페인트 벽', '패브릭·카펫', '식물 많음'] },
};

// 사진으로 채울 수 있는 항목: 눈으로 확인되는 것만(소음·머무르기·화장실처럼 사진으로 알 수 없는 건 뺀다)
const PHOTO_FIELDS = {
  entrance:  { label: '입구', values: AI_FIELDS.entrance.values, hint: '입구 사진일 때만. 문 앞이나 문지방에 한 칸이라도 턱·계단이 보이면 턱·계단 있음(작은 문턱도 포함), 경사로가 있으면 경사로 있음, 길과 문 바닥이 평평하게 이어질 때만 턱 없음' },
  floor:     { label: '층 이동', values: AI_FIELDS.floor.values, hint: '1층 매장이거나 엘리베이터·계단이 분명할 때만' },
  spacing:   { label: '좌석 간격', values: AI_FIELDS.spacing.values, hint: '넓음 1m 이상, 보통 50cm~1m, 좁음 50cm 미만' },
  light:     { label: '채광', values: AI_FIELDS.light.values, hint: '낮에 찍은 실내 사진에서 분명할 때만' },
  lamp:      { label: '조명 색', values: AI_FIELDS.lamp.values, hint: '켜진 조명의 빛 색. 노란빛·주황빛이면 따뜻한 빛, 하얀빛이면 하얀 빛' },
  outlet:    { label: '콘센트', values: AI_FIELDS.outlet.values, hint: '좌석 근처 콘센트가 보일 때만(많음: 좌석 절반 이상)' },
  hood:      { label: '고기 굽는 곳 배기', values: AI_FIELDS.hood.values, hint: '불판 둘레·아래로 빨아들이면 하향식, 테이블 위 후드면 상향식' },
  kids:      { label: '아이 동반', values: ['유아 의자 있음'], hint: '유아 의자가 보일 때만' },
  furniture: { label: '좌석 종류', tag: true, values: AI_FIELDS.furniture.values },
  materials: { label: '눈에 보이는 마감', tag: true, values: AI_FIELDS.materials.values },
};

const TMAP = {
  transit: 'https://apis.openapi.sk.com/transit/routes',
  walk: 'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1&format=json',
};
const PLACE_KINDS = ['search', 'nearby', 'station', 'addr', 'apt', 'bldreg', 'arrive', 'elev', 'odsay', 'probe'];
const ODSAY_WEB_KEY = 'vpfLJcZCiAwV7L5fibSQjA'; // 사이트(index.html)에도 공개된 웹 키. 따로 넣은 비밀값 ODSAY_API_KEY가 있으면 그걸 쓴다
const AI_KINDS = ['intent', 'photo'];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
      'X-GS-Version': VERSION,
    };
    const send = (text, status, extra) => new Response(text, { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
    const reply = (status, body) => send(JSON.stringify(body), status);

    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return reply(403, { error: 'forbidden origin' });
    if (request.method !== 'POST') return reply(405, { error: 'POST only' });

    const kind = new URL(request.url).pathname.replace(/^\/+/, '');
    if (!TMAP[kind] && !PLACE_KINDS.includes(kind) && !AI_KINDS.includes(kind)) return reply(404, { error: 'unknown path' });

    let input;
    try { input = await request.json(); } catch { return reply(400, { error: 'invalid json' }); }
    try {
      return await handle(kind, input, { request, env, ctx, send, reply });
    } catch (e) {
      if (e instanceof Response) return e; // 도우미들이 실패 응답을 던진다
      return reply(502, { error: 'upstream error' });
    }
  },
};

// 서버 메모리 저장(요청을 받는 Cloudflare 서버마다 따로, 서버가 쉬면 사라진다). KV 쓰기를 아끼려고 쓴다. 최대 2,000개, 오래된 것부터 지운다
const MEM = new Map();
const memGet = k => { const e = MEM.get(k); if (!e) return null; if (e.until < Date.now()) { MEM.delete(k); return null; } return e.v; };
const memPut = (k, v, ttl) => { MEM.delete(k); MEM.set(k, { v, until: Date.now() + Math.min(ttl, 86400) * 1000 }); if (MEM.size > 2000) MEM.delete(MEM.keys().next().value); };

const num = v => (typeof v === 'string' || typeof v === 'number') && /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : NaN;
const inKorea = (x, y) => x >= 124 && x <= 132 && y >= 33 && y <= 39;

async function handle(kind, input, { request, env, ctx, send, reply }) {
  const kv = env.ROUTE_CACHE;
  const ip = request.headers.get('CF-Connecting-IP') || 'x';

  // 외부 서비스를 부르기 전 횟수 제한(접속 IP별 1분 단위). 저장해 둔 결과를 줄 때는 세지 않는다
  const limiter = TMAP[kind] ? env.LIMIT_ROUTE : env.LIMIT_PLACE;
  const allow = async () => {
    if (!limiter) return;
    const { success } = await limiter.limit({ key: ip }).catch(() => ({ success: true }));
    if (!success) { console.log(JSON.stringify({ blocked: kind, ip })); throw reply(429, { error: 'too many' }); }
  };
  // 같은 요청은 저장해 둔 결과를 주고, 없으면 make()로 만들어 ttl초 저장한다.
  // KV 무료 한도는 저장(쓰기)이 하루 1,000번뿐이라, 하루 한도가 넉넉한(10만 번) 카카오 결과는 KV에 쓰지 않고
  // 이 서버 메모리에만 잠시 둔다(addr3·station·nearby2). KV에는 한도가 작거나 돈이 드는 것(TMAP 경로, AI, 공공데이터포털)만 쓴다
  const cached = async (key, ttl, make) => {
    const store = !/^(addr[34]|station|nearby2|bldreg1|arr):/.test(key); // 카카오 결과·건축물대장
    const m = memGet(key); if (m) return send(m, 200, { 'X-Cache': 'MEM' });
    if (kv && store) { const hit = await kv.get(key).catch(() => null); if (hit) { memPut(key, hit, ttl); return send(hit, 200, { 'X-Cache': 'HIT' }); } }
    await allow();
    const text = await make();
    memPut(key, text, ttl);
    if (kv && store) ctx.waitUntil(kv.put(key, text, { expirationTtl: ttl }).catch(() => {}));
    return send(text, 200, { 'X-Cache': kv && store ? 'MISS' : 'OFF' });
  };
  const kakao = async (path, params) => {
    if (!env.KAKAO_REST_KEY) throw reply(500, { error: 'KAKAO_REST_KEY is not set' });
    const up = await fetch(`https://dapi.kakao.com/v2/local/${path}.json?` + new URLSearchParams(params), { headers: { Authorization: 'KakaoAK ' + env.KAKAO_REST_KEY } });
    const j = await up.json().catch(() => null);
    if (!up.ok || !j) throw reply(up.status === 200 ? 502 : up.status, { error: (j && (j.message || j.msg)) || 'kakao error' });
    return j;
  };
  const xy = () => { const x = num(input.x), y = num(input.y); if (!inKorea(x, y)) throw reply(400, { error: 'coordinates out of range' }); return [x, y]; };

  /* 대중교통 경로(ODsay searchPubTransPathT): 하루 호출 한도가 작아서, 같은 구간(약 10m 단위)은 여러 사람이 같이 쓰도록 하루 동안 저장해 둔다.
     ODsay 결과는 출발 시각과 상관없다(첫차·막차는 사이트가 따로 거른다). 저장은 KV가 아닌 Cloudflare 캐시(쓰기 한도 없음, 지역 서버마다 따로)에.
     { SX, SY, EX, EY } → ODsay 응답 그대로. 한도 초과 같은 오류 응답은 저장하지 않는다 */
  if (kind === 'odsay') {
    const sx = num(input.SX), sy = num(input.SY), ex = num(input.EX), ey = num(input.EY);
    if (!inKorea(sx, sy) || !inKorea(ex, ey)) return reply(400, { error: 'coordinates out of range' });
    const r4 = v => v.toFixed(4), q = `SX=${r4(sx)}&SY=${r4(sy)}&EX=${r4(ex)}&EY=${r4(ey)}`;
    const key = `ods1:${q}`;
    const m = memGet(key); if (m) return send(m, 200, { 'X-Cache': 'MEM' });
    const edge = caches.default, ck = new Request('https://cache.gongan-sillok/odsay?' + q);
    const hit = await edge.match(ck).catch(() => null);
    if (hit) { const t = await hit.text(); memPut(key, t, 3600); return send(t, 200, { 'X-Cache': 'EDGE' }); }
    await allow();
    // ODsay 웹 키는 등록한 사이트 주소(Referer)로 확인한다
    const up = await fetch(`https://api.odsay.com/v1/api/searchPubTransPathT?${q}&apiKey=${encodeURIComponent(env.ODSAY_API_KEY || ODSAY_WEB_KEY)}`,
      { headers: { Referer: 'https://ian-space.github.io/gongan-sillok/' }, signal: AbortSignal.timeout(8000) });
    const text = await up.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!up.ok || !j) return reply(502, { error: 'odsay upstream' });
    if (!j.error && j.result) {
      memPut(key, text, 3600);
      ctx.waitUntil(edge.put(ck, new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } })).catch(() => {}));
    }
    return send(text, 200, { 'X-Cache': 'MISS' });
  }

  /* 임시 확인용(PROBE): 새 API 응답 모양 보기. 확인 뒤 지운다 */
  if (kind === 'probe') {
    const gk = /%[0-9A-Fa-f]{2}/.test(env.DATA_GO_KR_KEY || '') ? decodeURIComponent(env.DATA_GO_KR_KEY) : (env.DATA_GO_KR_KEY || '');
    const sk = env.SEOUL_OPEN_KEY || '', e = encodeURIComponent, a = String(input.a || ''), b = String(input.b || ''), c = String(input.c || '');
    const U = {
      fst: `https://apis.data.go.kr/B553766/inout/getFstExit?serviceKey=${e(gk)}&pageNo=1&numOfRows=${e(b || '5')}&dataType=JSON${a}`,
      sbr: `http://ws.bus.go.kr/api/rest/busRouteInfo/getRouteInfo?serviceKey=${e(gk)}&busRouteId=${e(a)}&resultType=json`,
      gbr: `https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteInfoItemv2?serviceKey=${e(gk)}&routeId=${e(a)}&format=json`,
      stn: `http://openapi.seoul.go.kr:8088/${e(sk)}/json/SearchInfoBySubwayNameService/1/10/${e(a)}`,
      stt: `http://openapi.seoul.go.kr:8088/${e(sk)}/json/SearchSTNTimeTableByIDService/1/${e(c || '5')}/${e(a)}/${e(b)}`,
    }[String(input.u)];
    if (!U) return reply(400, { error: 'u' });
    const r = await fetch(U, { signal: AbortSignal.timeout(8000) }); let t = await r.text();
    for (const k of [gk, sk, e(gk), e(sk)].filter(x => x && x.length > 8)) t = t.split(k).join('KEY');
    return reply(200, { status: r.status, hasSeoulKey: !!sk, body: t.slice(0, 6000) });
  }

  /* 카카오 장소 검색 */
  if (kind === 'search') {
    const query = String(input.query || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
    if (!query) return reply(400, { error: 'empty query' });
    const params = { query, size: '15' };
    const x = num(input.x), y = num(input.y);
    if (inKorea(x, y)) { Object.assign(params, { x: String(x), y: String(y) }); if (input.sort === 'distance') params.sort = 'distance'; } // 지도 중심 근처 결과부터(distance면 가까운 순)
    if (/^[1-3]$/.test(String(input.page || ''))) params.page = String(input.page);
    await allow();
    const j = await kakao('search/keyword', params);
    // 사이트에 필요한 칸만 넘긴다
    return reply(200, { places: (j.documents || []).map(d => ({
      name: d.place_name, category: d.category_name, address: d.road_address_name || d.address_name,
      phone: d.phone, x: d.x, y: d.y, url: d.place_url, distance: d.distance,
    })) });
  }

  /* 실시간 도착: 길찾기에서 고른 경로의 버스·지하철이 언제 오는지. 20초 동안만 서버 메모리에 둔다(KV에 쓰지 않는다)
     { type: 'bus', city: 'seoul', ars: '24101' }      → 서울 버스(정류소 고유번호, 공공데이터포털 서울특별시_정류소정보조회)
     { type: 'bus', city: 'gg', station: '228000708' }  → 경기 버스(정류소 ID, 공공데이터포털 경기도_버스도착정보)
     { type: 'subway', station: '천호' }                  → 지하철(역 이름, 서울 열린데이터광장 실시간 지하철)
     → { list: [{ name, msg, min, next, low, dir, line }] } (버스: name=노선 번호, 지하철: line=노선 번호·dir=방면) */
  if (kind === 'arrive') {
    const type = String(input.type || '');
    const gk = env.DATA_GO_KR_KEY ? (/%[0-9A-Fa-f]{2}/.test(env.DATA_GO_KR_KEY) ? decodeURIComponent(env.DATA_GO_KR_KEY) : env.DATA_GO_KR_KEY) : '';
    const get = async u => { const r = await fetch(u, { signal: AbortSignal.timeout(6000) }); const t = await r.text(); try { return JSON.parse(t); } catch { throw reply(502, { error: 'arrive upstream' }); } };
    const arr = v => !v ? [] : Array.isArray(v) ? v : [v];
    if (type === 'bus' && input.city === 'seoul') {
      const ars = String(input.ars || ''); if (!/^\d{5}$/.test(ars) || !gk) return reply(400, { error: 'bad ars' });
      return cached(`arr:sb:${ars}`, 20, async () => {
        const j = await get(`http://ws.bus.go.kr/api/rest/stationinfo/getStationByUid?serviceKey=${encodeURIComponent(gk)}&arsId=${ars}&resultType=json`);
        const items = arr(j && j.msgBody && j.msgBody.itemList);
        // arrmsg: '3분12초후[2번째 전]', '곧 도착', '운행종료', '출발대기'. busType1: 1이면 저상버스
        return JSON.stringify({ list: items.slice(0, 40).map(x => ({ name: String(x.rtNm || ''), msg: String(x.arrmsg1 || ''), next: String(x.arrmsg2 || ''), low: String(x.busType1) === '1' })) });
      });
    }
    if (type === 'bus' && input.city === 'gg') {
      const st = String(input.station || ''); if (!/^\d{6,10}$/.test(st) || !gk) return reply(400, { error: 'bad station' });
      return cached(`arr:gb:${st}`, 20, async () => {
        const j = await get(`https://apis.data.go.kr/6410000/busarrivalservice/v2/getBusArrivalListv2?serviceKey=${encodeURIComponent(gk)}&stationId=${st}&format=json`);
        const items = arr(j && j.response && j.response.msgBody && j.response.msgBody.busArrivalList);
        const n = v => (v === '' || v == null) ? null : +v;
        return JSON.stringify({ list: items.slice(0, 40).map(x => ({ name: String(x.routeName || ''), min: n(x.predictTime1), stops: n(x.locationNo1), next: n(x.predictTime2), low: String(x.lowPlate1) === '1', flag: String(x.flag || '') })) });
      });
    }
    if (type === 'subway') {
      const st = String(input.station || '').replace(/역$/, '').replace(/\(.*\)$/, '').trim();
      if (!st || st.length > 20 || !env.SEOUL_SUBWAY_KEY) return reply(400, { error: 'bad station' });
      return cached(`arr:sw:${st}`, 20, async () => {
        const j = await get(`http://swopenapi.seoul.go.kr/api/subway/${encodeURIComponent(env.SEOUL_SUBWAY_KEY)}/json/realtimeStationArrival/0/20/${encodeURIComponent(st)}`);
        // subwayId: 1001~1009 = 1~9호선 등. updnLine: 상행·하행·내선·외선. arvlMsg2: '전역 도착', '3분 후 (천호)'. barvlDt: 도착까지 초
        return JSON.stringify({ list: arr(j && j.realtimeArrivalList).slice(0, 20).map(x => ({ line: String(x.subwayId || ''), updn: String(x.updnLine || ''), dir: String(x.trainLineNm || ''),
          msg: String(x.arvlMsg2 || ''), sec: +x.barvlDt || 0, express: String(x.btrainSttus || '') })) });
      });
    }
    return reply(400, { error: 'bad type' });
  }

  /* 지하철역 엘리베이터(공공데이터포털 서울교통공사_교통약자이용정보, 1~8호선): 역 이름 → 그 역의 엘리베이터 목록
     → { list: [{ line, exit, from, to, pos, ok }] } exit: 가까운 출입구 번호('8', 없으면 '내부'), from·to: 잇는 층('B1'·'1'), ok: 운행 상태 정상(M)인지.
     운행 상태가 5분마다 바뀌어서 전체 목록을 5분 동안 서버 메모리에만 둔다(KV에 쓰지 않는다) */
  if (kind === 'elev') {
    const st = String(input.station || '').replace(/역$/, '').replace(/\(.*\)$/, '').trim();
    if (!st || st.length > 20) return reply(400, { error: 'bad station' });
    const gk = /%[0-9A-Fa-f]{2}/.test(env.DATA_GO_KR_KEY || '') ? decodeURIComponent(env.DATA_GO_KR_KEY) : (env.DATA_GO_KR_KEY || '');
    if (!gk) return reply(503, { error: 'elev off' });
    let all = memGet('elev1:all');
    if (!all) {
      await allow();
      const items = [];
      for (let page = 1; page <= 3; page++) {
        const r = await fetch(`https://apis.data.go.kr/B553766/wksn/getWksnElvtr?pageNo=${page}&numOfRows=1000&dataType=JSON&serviceKey=${encodeURIComponent(gk)}`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => null);
        const b = j && j.response && j.response.body; if (!b) break;
        const it = b.items && b.items.item; const list = !it ? [] : Array.isArray(it) ? it : [it];
        items.push(...list);
        if (list.length < 1000) break;
      }
      if (!items.length) return reply(502, { error: 'elev upstream' });
      const flr = (se, f) => String(f || '').trim() ? (se === '지하' && !/^B/i.test(f) ? 'B' + f : String(f).trim()) : '';
      all = JSON.stringify(items.map(x => ({ st: String(x.stnNm || '').replace(/\(.*\)$/, '').trim(), line: String(x.lineNm || ''), exit: String(x.vcntEntrcNo || '').trim(),
        from: flr(x.bgngFlrGrndUdgdSe, x.bgngFlr), to: flr(x.endFlrGrndUdgdSe, x.endFlr), pos: String(x.dtlPstn || '').slice(0, 40), ok: String(x.oprtngSitu || '') === 'M', code: String(x.oprtngSitu || '') })));
      memPut('elev1:all', all, 300);
    }
    const list = JSON.parse(all).filter(x => x.st === st).map(({ st: _, ...x }) => x);
    return reply(200, { list, covered: list.length > 0 });
  }

  /* 좌표 → 주소(카카오): 지도에서 누른 자리의 건물(도로명주소·건물명). 주소는 잘 바뀌지 않아 약 1m 단위로 30일 저장 */
  if (kind === 'addr') {
    const [x, y] = xy();
    return cached(`addr4:${x.toFixed(5)},${y.toFixed(5)}`, 30 * 86400, async () => {
      const j = await kakao('geo/coord2address', { x: x.toFixed(6), y: y.toFixed(6) });
      const d = (j.documents || [])[0] || {}, ra = d.road_address || null, ad = d.address || null;
      let building = ra ? ra.building_name || '' : '', places = [];
      // 건물 이름이 없거나 '112동'처럼 동 번호만 오면, 같은 도로명주소로 카카오 장소를 찾는다.
      // 아파트 단지면 단지 이름을 붙이고, 아니면 그 주소의 장소들(places)을 함께 준다(상가정보에 없는 건물도 장소 이름으로 보이게).
      // 주소가 같은 곳만 쓴다(근처 다른 건물 이름이 붙지 않게). 주소 앞의 '서울'/'서울특별시' 표기는 달라서 빼고 비교한다
      if (ra && ra.address_name && (!building || /^[\dA-Za-z가-힣]{0,4}\d+동$/.test(building))) {
        const tail = s => String(s || '').trim().split(/\s+/).slice(1).join(' ');
        const kj = await kakao('search/keyword', { query: ra.address_name, x: x.toFixed(6), y: y.toFixed(6), radius: '500', sort: 'distance', size: '15' }).catch(() => null);
        const same = ((kj && kj.documents) || []).filter(p => tail(p.road_address_name) === tail(ra.address_name));
        const apt = same.find(p => /아파트|주거시설|오피스텔/.test(p.category_name || '') && !/동$/.test(p.place_name));
        if (apt && !building.includes(apt.place_name)) building = (apt.place_name + ' ' + building).trim();
        if (!building) places = same.filter(p => !/주거시설|아파트/.test(p.category_name || '')).slice(0, 8).map(p => ({ name: p.place_name, category: p.category_name,
          address: p.road_address_name, phone: p.phone, x: p.x, y: p.y, url: p.place_url }));
      }
      return JSON.stringify({ road: ra ? ra.address_name : '', building, jibun: ad ? ad.address_name : '',
        roadName: ra ? ra.road_name : '', mainNo: ra ? ra.main_building_no : '', subNo: ra ? ra.sub_building_no : '', places });
    });
  }

  /* 가까운 지하철역: 카카오 업종 검색(SW8)으로 1.5km 안의 역을 가까운 순으로. 역은 잘 바뀌지 않아 약 100m 단위로 30일 저장 */
  if (kind === 'station') {
    const [x, y] = xy();
    return cached(`station:${x.toFixed(3)},${y.toFixed(3)}`, 30 * 86400, async () => {
      const j = await kakao('search/category', { category_group_code: 'SW8', x: x.toFixed(4), y: y.toFixed(4), radius: '1500', sort: 'distance', size: '5' });
      return JSON.stringify({ stations: (j.documents || []).map(d => ({ name: d.place_name, line: String(d.category_name || '').split('>').pop().trim(), x: d.x, y: d.y })) });
    });
  }

  /* 건축물대장 표제부(공공데이터포털 국토교통부 건축HUB): 필지(pnu 19자리) 하나의 건물들 → 승강기 수·층수·주용도.
     → { blds: [{ name, dong, use, floors, under, elev }] }. 엘리베이터가 있는지(층 이동)를 공공 기록으로 보여 주는 데 쓴다.
     KV 쓰기를 아끼려고 서버 메모리에만 잠시 둔다(공공데이터포털 하루 한도 안) */
  if (kind === 'bldreg') {
    const pnu = String(input.pnu || '');
    if (!/^\d{19}$/.test(pnu)) return reply(400, { error: 'bad pnu' });
    if (!env.DATA_GO_KR_KEY) return reply(503, { error: 'bldreg off' });
    return cached(`bldreg1:${pnu}`, 7 * 86400, async () => {
      const key = /%[0-9A-Fa-f]{2}/.test(env.DATA_GO_KR_KEY) ? decodeURIComponent(env.DATA_GO_KR_KEY) : env.DATA_GO_KR_KEY;
      // 필지 번호 → 시군구 5자리, 법정동 5자리, 대지(0)/산(1), 번 4자리, 지 4자리
      const up = await fetch('https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?' + new URLSearchParams({ serviceKey: key, _type: 'json',
        sigunguCd: pnu.slice(0, 5), bjdongCd: pnu.slice(5, 10), platGbCd: pnu[10] === '2' ? '1' : '0', bun: pnu.slice(11, 15), ji: pnu.slice(15, 19), numOfRows: '100', pageNo: '1' }),
        { signal: AbortSignal.timeout(6000) });
      const raw = await up.text().catch(() => ''); let j = null; try { j = JSON.parse(raw); } catch {}
      const body = j && j.response && j.response.body;
      if (!body) { const err = (/<errMsg>([A-Z_]+)/.exec(raw) || [])[1] || (j && j.response && j.response.header && j.response.header.resultCode); console.log(JSON.stringify({ bldreg: pnu, err, status: up.status })); throw reply(502, { error: 'bldreg upstream', code: err || up.status }); }
      const it = body.items && (body.items.item || body.items), list = !it ? [] : Array.isArray(it) ? it : [it];
      const n = v => parseInt(v, 10) || 0;
      return JSON.stringify({ blds: list.slice(0, 100).map(x => ({ name: String(x.bldNm || '').trim(), dong: String(x.dongNm || '').trim(), use: String(x.mainPurpsCdNm || ''),
        floors: n(x.grndFlrCnt), under: n(x.ugrndFlrCnt), elev: n(x.rideUseElvtCnt) + n(x.emgenUseElvtCnt), main: String(x.mainAtchGbCdNm || '') })) });
    });
  }

  /* 아파트 단지 공식 정보(공공데이터포털, 국토교통부 공동주택 단지 목록·기본 정보 = K-apt)
     { bjd: 누른 필지의 법정동 코드, road: 도로명주소, lot: '22'·'19-1' 같은 지번, name: 알고 있는 단지 이름 }
     → { apt: { code, name, addr, road, dongs, units, year } | null }
     법정동의 단지 목록(이름만)에서 이름이 비슷한 단지부터 기본 정보를 몇 개만 받아, 도로명주소나 지번이 맞는 단지를 고른다.
     공공데이터포털은 한꺼번에 많이 물으면 막혀서, 한 번에 많아야 7번만 묻는다. 목록·기본 정보는 30일 저장 */
  if (kind === 'apt') {
    const bjd = String(input.bjd || ''), road = String(input.road || '').slice(0, 80), lot = String(input.lot || ''), hint = String(input.name || '').slice(0, 40);
    if (!/^\d{10}$/.test(bjd) || (lot && !/^산?\d{1,4}(-\d{1,4})?$/.test(lot))) return reply(400, { error: 'bad input' });
    if (!env.DATA_GO_KR_KEY) return reply(503, { error: 'apt off' });
    const key = /%[0-9A-Fa-f]{2}/.test(env.DATA_GO_KR_KEY) ? decodeURIComponent(env.DATA_GO_KR_KEY) : env.DATA_GO_KR_KEY; // 인코딩된 키를 넣었어도
    let asked = false;
    const gov = async (path, params) => {
      if (!asked) { await allow(); asked = true; } // 저장해 둔 것만 쓸 때는 횟수를 세지 않는다
      const up = await fetch(`https://apis.data.go.kr/1613000/${path}?` + new URLSearchParams({ serviceKey: key, _type: 'json', ...params }), { signal: AbortSignal.timeout(6000) }); // 공공데이터포털은 몰리면 가끔 멈춘다
      const raw = await up.text().catch(() => ''); let j = null; try { j = JSON.parse(raw); } catch {}
      const body = j && j.response && j.response.body;
      const err = (j && ((j.response && j.response.header && j.response.header.resultCode) || (j.OpenAPI_ServiceResponse && j.OpenAPI_ServiceResponse.cmmMsgHeader && j.OpenAPI_ServiceResponse.cmmMsgHeader.errMsg))) || (/<errMsg>([A-Z_]+)/.exec(raw) || [])[1];
      if (!body) { console.log(JSON.stringify({ apt: path, err, status: up.status })); throw reply(502, { error: 'apt upstream', code: err || up.status }); } // LIMITED_…: 하루 한도
      return body;
    };
    const kvGet = async k => { const m = memGet(k); if (m) return m; const v = kv ? await kv.get(k).catch(() => null) : null; if (v) memPut(k, v, 86400); return v; };
    const kvPut = (k, v) => { memPut(k, v, 86400); if (kv) ctx.waitUntil(kv.put(k, v, { expirationTtl: 30 * 86400 }).catch(() => {})); };
    const arr = v => !v ? [] : Array.isArray(v) ? v : [v];
    // 법정동의 단지 목록 [{ code, name }]
    let list = JSON.parse(await kvGet(`aptl1:${bjd}`) || 'null');
    if (!list) {
      const b = await gov('AptListService4/getLegaldongAptList4', { bjdCode: bjd, pageNo: '1', numOfRows: '300' });
      list = arr(b.items && (b.items.item || b.items)).map(it => ({ code: String(it.kaptCode || ''), name: String(it.kaptName || '') })).filter(x => /^[A-Z0-9]{5,12}$/.test(x.code));
      kvPut(`aptl1:${bjd}`, JSON.stringify(list));
    }
    // 단지 기본 정보
    const info = async code => {
      const hit = await kvGet(`aptb1:${code}`);
      if (hit) return JSON.parse(hit);
      const b = await gov('AptBasisInfoServiceV5/getAphusBassInfoV5', { kaptCode: code });
      const d = b.item || (b.items && (b.items.item || b.items)), x = Array.isArray(d) ? d[0] : d;
      if (!x) return null;
      const o = { code, name: String(x.kaptName || ''), addr: String(x.kaptAddr || ''), road: String(x.doroJuso || ''), dongs: +x.kaptDongCnt || 0,
        units: +x.kaptdaCnt || +x.hoCnt || 0, year: /^\d{8}$/.test(String(x.kaptUsedate || '')) ? String(x.kaptUsedate).slice(0, 4) : '' };
      kvPut(`aptb1:${code}`, JSON.stringify(o));
      return o;
    };
    // 이름이 비슷한 단지부터(같으면 3, 한쪽이 다른 쪽을 품으면 2), 그다음 목록 순서
    const sq = s => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').replace(/아파트$/, '');
    const h = sq(hint);
    const score = n => { const s = sq(n); return !h || !s ? 0 : s === h ? 3 : s.includes(h) || h.includes(s) ? 2 : 0; };
    const ranked = list.map(x => ({ ...x, s: score(x.name) })).sort((a, b) => b.s - a.s);
    const tail = s => String(s || '').trim().split(/\s+/).slice(1).join(' '); // '서울'/'서울특별시' 표기 차이를 뺀다
    const byLot = lot && new RegExp('\\s' + lot + '(\\s|$)');
    let fetched = 0;
    for (const c of ranked.slice(0, 12)) { // 이름이 비슷한 쪽부터 12곳까지만 본다
      const kept = await kvGet(`aptb1:${c.code}`);
      if (!kept && fetched >= 6) continue;
      if (!kept) fetched++;
      const a = kept ? JSON.parse(kept) : await info(c.code).catch(e => { if (e instanceof Response && fetched <= 1) throw e; return null; });
      if (a && ((road && a.road && tail(a.road) === tail(road)) || (byLot && byLot.test(a.addr)) || (c.s === 3 && !road && !lot))) return reply(200, { apt: a });
    }
    return reply(200, { apt: null });
  }

  /* 카카오 업종 검색: 지도 한 칸(사각형) 안의 장소. 카카오는 한 번에 최대 45곳(15곳씩 3쪽)만 준다.
     그보다 많고 칸이 아직 크면 { split: true }만 돌려줘서, 사이트가 칸을 4등분해 다시 묻게 한다. 하루 동안 저장 */
  if (kind === 'nearby') {
    const r = String(input.rect || '').split(',').map(num);
    if (r.length !== 4 || !inKorea(r[0], r[1]) || !inKorea(r[2], r[3]) || r[2] <= r[0] || r[3] <= r[1] || r[2] - r[0] > 0.03 || r[3] - r[1] > 0.03)
      return reply(400, { error: 'bad rect' });
    const code = NEARBY[input.code] ? input.code : 'CE7';
    const how = NEARBY[code];
    const rect = r.map(v => v.toFixed(4)).join(',');
    const canSplit = r[2] - r[0] > 0.0016;
    return cached(`nearby2:${code}:${rect}`, 86400, async () => {
      const places = [];
      for (let page = 1; page <= 3; page++) {
        const j = await kakao(`search/${how.api}`, { rect, page: String(page), size: '15', ...how.params });
        if (page === 1 && canSplit && j.meta && j.meta.total_count > 45) return JSON.stringify({ places: [], split: true });
        for (const d of j.documents || []) {
          if (how.keep && !how.keep(d)) continue;
          places.push({ name: d.place_name, category: d.category_name, address: d.road_address_name || d.address_name, phone: d.phone, x: d.x, y: d.y, url: d.place_url });
        }
        if (!j.meta || j.meta.is_end) break;
      }
      return JSON.stringify({ places });
    });
  }

  /* AI (Anthropic Claude): 로그인한 사람만, 한 사람당·전체 하루 한도 안에서. 누가 물었는지는 Anthropic에 보내지 않는다 */
  if (AI_KINDS.includes(kind)) {
    if (!env.ANTHROPIC_API_KEY) return reply(503, { error: 'ai off' });
    const uid = await userOf(request);
    if (!uid) return reply(401, { error: 'login required' });
    // 하루 한도 확인(저장해 둔 결과를 줄 때는 세지 않는다)
    const count = async () => {
      if (!kv) return;
      const day = new Date().toISOString().slice(0, 10), lim = AI_LIMITS[kind];
      const kU = `rl:${kind}:u:${uid}:${day}`, kD = `rl:${kind}:day:${day}`;
      const [nU, nD] = await Promise.all([kU, kD].map(k => kv.get(k).then(v => Number(v) || 0).catch(() => 0)));
      if (nU >= lim.user || nD >= lim.day) { console.log(JSON.stringify({ blocked: kind, user: uid, ip, nU, nD })); throw reply(429, { error: 'too many' }); }
      ctx.waitUntil(Promise.all([kv.put(kU, String(nU + 1), { expirationTtl: 86400 }), kv.put(kD, String(nD + 1), { expirationTtl: 86400 })]).catch(() => {}));
    };
    const askClaude = async (system, content) => {
      const up = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 500, temperature: 0, system, messages: [{ role: 'user', content }] }),
      });
      const j = await up.json().catch(() => null);
      if (!up.ok || !j) throw reply(502, { error: 'ai error' });
      const out = String((j.content || []).map(c => c.text || '').join(''));
      let parsed = null;
      try { parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch {}
      if (!parsed || typeof parsed !== 'object') throw reply(502, { error: 'ai parse', stop: j.stop_reason, raw: out.slice(0, 300) }); // 원인 확인용(AI 답의 앞부분만, 키·사진은 없음)
      return parsed;
    };
    // 기록 항목 안의 값만 남긴다: w는 한 값 항목, t는 여러 값 항목
    const keepFields = (conds, fields) => {
      const w = {}, t = {};
      for (const [k, vals] of Object.entries(conds || {})) {
        const f = fields[k]; if (!f || !Array.isArray(vals)) continue;
        const ok = [...new Set(vals.map(String).filter(v => f.values.includes(v)))];
        if (ok.length) (f.tag ? t : w)[k] = ok;
      }
      return { w, t };
    };

    /* 글로 적은 목적 → 기록 항목 조건. 같은 문장은 30일 저장해 다시 쓴다 */
    if (kind === 'intent') {
      const text = String(input.text || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (text.length < 2) return reply(400, { error: 'empty text' });
      const cacheKey = 'intent4:' + text; // 지시문을 바꾸면 번호를 올려 예전 저장 결과를 쓰지 않게 한다
      if (kv) { const hit = await kv.get(cacheKey).catch(() => null); if (hit) return send(hit, 200, { 'X-Cache': 'HIT' }); }
      await count();
      const list = Object.entries(AI_FIELDS).map(([k, f]) => `${k} (${f.label}): ${f.values.join(' | ')}`).join('\n');
      const system = `너는 공간 기록 지도의 검색 도우미다. 이용자가 적은 목적 문장을 아래 기록 항목의 값으로만 바꾼다.
- 목록에 없는 항목이나 값은 절대 만들지 않는다. 값은 글자 그대로 쓴다.
- 문장에서 분명히 드러나거나 그 목적에 일반적으로 꼭 필요한 조건만 고른다. 애매하면 고르지 않는다.
- 한 항목에서 그 목적에 괜찮은 값은 모두 고른다(예: 휠체어면 entrance에 "턱 없음", "경사로 있음").
- 'kids'는 아이·아기·유아와 함께 갈 때만 고른다(부모님·엄마와 가는 것은 아이 동반이 아니다).
- 이 목적에 좋은 값만 고르고, '보통'은 그 목적에 꼭 맞을 때만 고른다.
- 위 항목으로 전혀 나타낼 수 없는 요구만 missing에 짧은 낱말로 적는다(최대 3개). 이미 고른 항목으로 나타낸 것은 missing에 넣지 않는다.
항목:
${list}
출력은 JSON 하나만, 설명 없이: {"conds":{"항목키":["값"]},"missing":["낱말"]}`;
      const parsed = await askClaude(system, text);
      const { w, t } = keepFields(parsed.conds, AI_FIELDS);
      const missing = (Array.isArray(parsed.missing) ? parsed.missing : []).map(s => String(s).slice(0, 12)).slice(0, 3);
      const body = JSON.stringify({ w, t, missing });
      if (kv) ctx.waitUntil(kv.put(cacheKey, body, { expirationTtl: 30 * 86400 }).catch(() => {}));
      return send(body, 200, { 'X-Cache': kv ? 'MISS' : 'OFF' });
    }

    /* 사진으로 항목 채우기. 사진은 저장하지 않고 바로 넘기며, 눈으로 확인할 수 있는 항목만 고르게 한다.
       잰 숫자(단차 cm, 소음 dB)는 고르지 않는다 */
    const imgs = (Array.isArray(input.images) ? input.images : []).slice(0, 3).map(String)
      .filter(s => s.length > 100 && s.length < 1500000 && /^[A-Za-z0-9+/=]+$/.test(s));
    if (!imgs.length) return reply(400, { error: 'no image' });
    await count();
    const list = Object.entries(PHOTO_FIELDS).map(([k, f]) => `${k} (${f.label}${f.tag ? ', 여러 개 가능' : ', 하나만'}): ${f.values.join(' | ')}${f.hint ? ` — ${f.hint}` : ''}`).join('\n');
    const system = `너는 공간 기록 지도의 기록 도우미다. 이용자가 매장에서 찍은 사진을 보고, 아래 기록 항목 중 사진에서 눈으로 분명히 확인되는 것만 고른다.
- 목록에 없는 항목이나 값은 만들지 않는다. 값은 글자 그대로 쓴다.
- 사진에 보이지 않거나 애매하면 그 항목은 고르지 않는다. 추측하지 않는다. 적게 고르는 편이 낫다.
- '하나만' 항목은 값 하나, '여러 개 가능' 항목은 분명히 보이는 것을 모두.
- floor(층 이동)는 엘리베이터·계단·건물 바깥이 사진에 직접 보일 때만 고른다. 실내 사진만으로는 고르지 않는다.
- materials(마감)는 바닥·벽·천장처럼 넓게 보이는 재료만. 조명·소품의 재료는 넣지 않는다. '식물 많음'은 식물이 공간을 채울 만큼 많을 때만.
- furniture(좌석 종류)에서 '1인석'은 혼자 앉는 자리가 따로 줄지어 있을 때만, '큰 공용 테이블'은 여러 명이 함께 앉는 긴 테이블이 보이면 고른다.
항목:
${list}
출력은 JSON 하나만, 설명 없이: {"conds":{"항목키":["값"]}}`;
    const content = [...imgs.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })), { type: 'text', text: '이 사진들에서 확인되는 항목을 골라 줘.' }];
    const { w, t } = keepFields((await askClaude(system, content)).conds, PHOTO_FIELDS);
    for (const k of Object.keys(w)) w[k] = w[k][0]; // 사진은 한 값 항목마다 값 하나
    return reply(200, { w, t });
  }

  /* TMAP 경로: 국내 좌표만, 정해진 칸만 넘긴다 */
  if (!env.TMAP_APP_KEY) return reply(500, { error: 'TMAP_APP_KEY is not set' });
  const sx = num(input.startX), sy = num(input.startY), ex = num(input.endX), ey = num(input.endY);
  if (!inKorea(sx, sy) || !inKorea(ex, ey)) return reply(400, { error: 'coordinates out of range' });
  const stamp = /^\d{12}$/.test(String(input.searchDttm || '')) ? String(input.searchDttm) : '';
  const body = kind === 'transit'
    ? { startX: String(sx), startY: String(sy), endX: String(ex), endY: String(ey), lang: 0, format: 'json', count: 10, ...(stamp && { searchDttm: stamp }) }
    : { startX: String(sx), startY: String(sy), endX: String(ex), endY: String(ey), startName: encodeURIComponent('출발'), endName: encodeURIComponent('도착') };
  // 같은 구간(약 10m 단위) 요청은 저장해 둔 결과를 준다. 대중교통은 같은 10분대만, 도보는 하루 동안. 누가 요청했는지는 저장하지 않는다
  const r4 = v => v.toFixed(4);
  const cacheKey = `${kind}:${r4(sx)},${r4(sy)},${r4(ex)},${r4(ey)}` + (kind === 'transit' ? `:${stamp.slice(0, 11)}` : '');
  return cached(cacheKey, CACHE_SECONDS[kind], async () => {
    const upstream = await fetch(TMAP[kind], {
      method: 'POST',
      headers: { appKey: env.TMAP_APP_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    if (!upstream.ok) throw send(text, upstream.status, { 'X-Cache': 'MISS' });
    return text;
  });
}

// Supabase 로그인 토큰 → 회원번호. 토큰이 없거나 틀리면 null
async function userOf(request) {
  const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + m[1] } }).catch(() => null);
  if (!r || !r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && typeof u.id === 'string' ? u.id : null;
}
