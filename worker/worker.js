// 공간실록 중계 서버 (Cloudflare Worker)
// - 외부 서비스 키(TMAP, 카카오, Anthropic)를 사이트 코드 대신 여기 비밀 변수에만 둔다.
//     TMAP_APP_KEY      : TMAP 대중교통·보행자 경로
//     KAKAO_REST_KEY    : 카카오 로컬 장소 검색 (REST API 키)
//     ANTHROPIC_API_KEY : AI 조건 찾기·사진 보고 채우기
//     DATA_GO_KR_KEY    : 공공데이터포털 인증키(아파트 단지 공식 정보, 건축물대장, 서울·경기 버스 도착)
//     SEOUL_SUBWAY_KEY  : 서울 열린데이터광장 실시간 지하철 인증키
//     SEOUL_OPEN_KEY    : 서울 열린데이터광장 일반 인증키(지하철 역별 시간표)
//     SUPABASE_SERVICE_KEY : Supabase 관리자(secret) 키. 1년 지난 사진으로 찾기 사진 지우기, 새 신고 읽기에 쓴다
//     RESEND_API_KEY    : 신고 알림 메일 보내기(Resend). 일반 변수 NOTIFY_EMAIL: 받을 메일 주소
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
//   POST /odsay    { SX, SY, EX, EY }                           → ODsay 대중교통 경로(같은 구간은 하루 동안 같이 쓴다)
//   POST /fstexit  { station }                                  → 빠른하차(엘리베이터·에스컬레이터·계단 가까운 문, 서울교통공사 1~8호선)
//   POST /elevpath { station, line? }                         → 엘리베이터 이동 동선(출입구↔승강장, 환승, KRIC, 수도권 모든 운영기관)
//   POST /toilet   { station, line? }                         → 역 화장실(개찰구 안팎, 층, 출구, 기저귀 교환대, KRIC)
//   POST /toiletsum {}                                        → 모든 역 화장실 요약(예약 작업이 채운다, 노선도용)
//   POST /fsttrans { station }                                 → 빠른 환승(갈아탈 노선으로 가장 빨리 가는 칸·문, 국토교통부)
//   POST /lines    {}                                         → 노선별 역 목록(수도권, 서울 열린데이터광장)
//   POST /elevpos  {}                                         → 지하철역 엘리베이터 자리(서울 안 모든 운영사, 서울 열린데이터광장)
//   POST /sched    { type: bus|subway, ... }                    → 첫차·막차(서울·경기 버스, 서울 지하철 역별 시간표)
//   POST /nearby   { rect: "왼쪽X,아래Y,오른쪽X,위Y", code? }      → 지도 한 칸 안의 장소 (NEARBY의 업종 코드)
//   POST /intent   { text }                                     → 글로 적은 목적을 기록 항목 조건으로 (로그인 필요)
//   POST /photo    { images: [base64 JPEG, 최대 3장] }          → 사진에서 눈으로 확인되는 기록 항목 제안 (로그인 필요)
//   POST /photoplace { image: base64 JPEG 1장, x, y }        → 사진+위치로 그 자리의 가게 후보(간판 글자, AI가 고른 곳, 가까운 곳) (로그인 필요)

const ALLOWED_ORIGINS = ['https://ian-space.github.io', 'http://localhost:8765'];
const VERSION = '2026-10-14.21'; // 응답 머리말 X-GS-Version. 자동 배포가 됐는지 확인할 때 본다
// 로그인 확인용 Supabase 주소와 공개 키(사이트 코드에도 있는 공개 값)
const SUPABASE_URL = 'https://qktrghajroxddrbpwtvn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_j-kp8YKsQTczGcsQX74OxA_mfI7DoZw';
// AI 하루 한도: 한 사람당 / 전체. 넘으면 429와 함께 Cloudflare 로그에 회원번호·IP를 남긴다(남용 확인용)
const AI_LIMITS = { intent: { user: 30, day: 1000 }, photo: { user: 20, day: 200 }, photoplace: { user: 30, day: 300 } };
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
const AI_MODEL = 'claude-haiku-5-5';
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
const PLACE_KINDS = ['search', 'nearby', 'station', 'addr', 'apt', 'bldreg', 'arrive', 'elev', 'odsay', 'fstexit', 'sched', 'clienterr', 'elevpath', 'fsttrans', 'lines', 'elevpos', 'toilet', 'toiletsum'];
const ODSAY_WEB_KEY = 'vpfLJcZCiAwV7L5fibSQjA'; // 사이트(index.html)에도 공개된 웹 키. 따로 넣은 비밀값 ODSAY_API_KEY가 있으면 그걸 쓴다
const AI_KINDS = ['intent', 'photo', 'photoplace'];

export default {
  // 예약 작업(wrangler.toml [triggers]): 매일 한 번 1년 지난 '사진으로 찾기' 사진 지우기, 10분마다 새 신고를 운영자 메일로
  async scheduled(event, env, ctx) {
    if (event.cron === '*/10 * * * *') { ctx.waitUntil(notifyReports(env)); ctx.waitUntil(fillToiletSum(env)); }
    else ctx.waitUntil(expireFinds(env));
  },
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
      // 예상 못 한 오류: 원인을 Cloudflare 대시보드 로그에 남긴다(요청 내용·IP는 남기지 않는다)
      console.log(JSON.stringify({ error: kind, name: (e && e.name) || '', msg: String((e && e.message) || e).slice(0, 300) }));
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

  // 외부 서비스를 부르기 전 횟수 제한(접속 IP별 1분 단위). 저장해 둔 결과를 줄 때는 세지 않는다.
  // 하루 한도가 작은 경로 서비스(TMAP, ODsay)는 빡빡한 쪽(1분 30번)으로
  const limiter = TMAP[kind] || kind === 'odsay' ? env.LIMIT_ROUTE : env.LIMIT_PLACE;
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
    // SearchPathType 1: 지하철만(지하철 노선도에서 역끼리 찾을 때)
    const r4 = v => v.toFixed(4), q = `SX=${r4(sx)}&SY=${r4(sy)}&EX=${r4(ex)}&EY=${r4(ey)}${String(input.SearchPathType || '') === '1' ? '&SearchPathType=1' : ''}`;
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

  // Cloudflare 캐시(쓰기 한도 없음, 지역 서버마다 따로)에 ttl초 저장. 하루에 한 번이면 되는 시간표·빠른하차 자료용
  const edgeCached = async (key, ttl, make) => {
    const m = memGet(key); if (m) return m;
    const ck = new Request('https://cache.gongan-sillok/' + encodeURIComponent(key));
    const hit = await caches.default.match(ck).catch(() => null);
    if (hit) { const t = await hit.text(); memPut(key, t, Math.min(ttl, 3600)); return t; }
    await allow();
    const t = await make();
    if (t == null) return null; // 실패는 저장하지 않는다
    memPut(key, t, Math.min(ttl, 3600));
    ctx.waitUntil(caches.default.put(ck, new Response(t, { headers: { 'Cache-Control': `public, max-age=${ttl}` } })).catch(() => {}));
    return t;
  };
  const dataKey = () => /%[0-9A-Fa-f]{2}/.test(env.DATA_GO_KR_KEY || '') ? decodeURIComponent(env.DATA_GO_KR_KEY) : (env.DATA_GO_KR_KEY || '');
  const stName = v => String(v || '').replace(/\(.*\)$/, '').replace(/역$/, '').trim();

  /* 사이트 화면에서 난 스크립트 오류: 대시보드 로그에 한 줄만 남긴다(IP·입력 내용은 남기지 않는다) */
  /* 엘리베이터 이동 동선(KRIC 교통약자 역사 내 엘리베이터 이동동선, 수도권 모든 운영기관):
     { station, line: 1~9 또는 ODsay 노선 번호(101 공항철도 등), 없으면 그 역 모든 노선 } → { paths: [{ kind: '출입구-승강장'|'환승경로'…, steps: [...] }] }
     역 코드는 KRIC 도시철도 전체노선정보. 받은 동선은 KV에 두고 7일 지나면 새로, 실패하면 전 것 */
  if (kind === 'elevpath') {
    const st = stName(input.station), line = String(input.line || '');
    if (!st || st.length > 20) return reply(400, { error: 'bad input' });
    if (!env.KRIC_KEY) return reply(503, { error: 'elevpath off' });
    await allow();
    const all = await kricStations(env, ctx); if (!all) return reply(502, { error: 'elevpath upstream' });
    const want = /^[1-9]$/.test(line) ? line : ODSAY_KRIC[line] || '';
    const codes = (all[st] || []).filter(c => !want || c[1] === want).slice(0, 4);
    const lists = await Promise.all(codes.map(([op, ln, stin]) => kvFresh(env, ctx, `kric2:em:${op}:${ln}:${stin}`, 7 * 86400000, async () => {
      const b = await kricGet(env, 'trafficWeekInfo/stinElevatorMovement', { railOprIsttCd: op, lnCd: ln, stinCd: stin }); if (b == null) return null;
      const g = new Map();
      for (const x of b) {
        const k = `${x.mvPathDvCd}:${x.mvPathMgNo}`;
        if (!g.has(k)) g.set(k, { kind: String(x.mvPathDvNm || ''), steps: [] });
        g.get(k).steps.push([+x.mvTpOrdr || 0, String(x.mvContDtl || '').replace(/^\s*\d+\)\s*/, '').trim()]);
      }
      return [...g.values()].map(p => ({ kind: p.kind, steps: p.steps.sort((a, b) => a[0] - b[0]).map(s => s[1]).filter(Boolean) }));
    })));
    return reply(200, { paths: lists.flatMap(l => l || []) });
  }

  /* 역 화장실(KRIC 역사별 화장실 현황): { station, line? } → { list: [{ gate: '내'(개찰구 안)|'외', floor: 'B1', exit, loc, sex, n, diaper }] } */
  if (kind === 'toilet') {
    const st = stName(input.station), line = String(input.line || '');
    if (!st || st.length > 20) return reply(400, { error: 'bad input' });
    if (!env.KRIC_KEY) return reply(503, { error: 'toilet off' });
    await allow();
    const all = await kricStations(env, ctx); if (!all) return reply(502, { error: 'toilet upstream' });
    const want = /^[1-9]$/.test(line) ? line : ODSAY_KRIC[line] || '';
    const codes = (all[st] || []).filter(c => !want || c[1] === want).slice(0, 4);
    const lists = await Promise.all(codes.map(c => kricToilets(env, ctx, c).then(l => (l || []).map(x => ({ ...x, line: c[3] })))));
    const seen = new Set(), list = lists.flat().filter(x => { const k = `${x.loc}|${x.sex}`; return !seen.has(k) && seen.add(k); });
    return reply(200, { list });
  }

  /* 노선도 화장실 표시: 예약 작업이 모아 둔 요약 → { stations: { 역: [화장실 수, 개찰구 안에 있음 1|0, 기저귀 교환대 1|0] } } */
  if (kind === 'toiletsum') {
    const m = memGet('tlsum'); if (m) return send(m, 200);
    const sum = kv ? await kv.get('kric2:tlsum', 'json').catch(() => null) : null;
    const text = JSON.stringify({ stations: Object.fromEntries(Object.entries(sum || {}).map(([k, v]) => [k, v.slice(0, 3)])) });
    memPut('tlsum', text, 600);
    return send(text, 200);
  }

  if (kind === 'clienterr') {
    await allow();
    const s = (v, n) => String(v || '').replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, n);
    console.log(JSON.stringify({ clienterr: s(input.msg, 200), where: s(input.where, 120), ua: s(input.ua, 10), b: s(input.b, 10), lang: s(input.lang, 5) }));
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': request.headers.get('Origin') || '' } });
  }

  /* 빠른하차(공공데이터포털 서울교통공사_빠른하차정보, 1~8호선): 역 이름 → 그 역의 방면별 '이 문에서 내리면 엘리베이터·에스컬레이터·계단이 가깝다'
     → { list: [{ line: '8호선', dir: '다음 역 이름(방면)', door: '4-4', fac: '엘리베이터' }] }. 전체(약 2,400줄)를 하루 동안 저장해 두고 역별로 나눠 준다 */
  if (kind === 'fstexit') {
    const st = stName(input.station);
    if (!st || st.length > 20) return reply(400, { error: 'bad station' });
    const gk = dataKey(); if (!gk) return reply(503, { error: 'fstexit off' });
    const all = await edgeCached('fst1:all', 86400, async () => {
      const rows = [];
      for (let page = 1; page <= 4; page++) {
        const r = await fetch(`https://apis.data.go.kr/B553766/inout/getFstExit?serviceKey=${encodeURIComponent(gk)}&pageNo=${page}&numOfRows=1000&dataType=JSON`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => null);
        const b = j && j.response && j.response.body; if (!b) return rows.length ? JSON.stringify(rows) : null;
        const it = b.items && b.items.item; const list = !it ? [] : Array.isArray(it) ? it : [it];
        for (const x of list) rows.push([stName(x.stnNm), String(x.lineNm || ''), stName(x.drtnInfo), String(x.qckgffVhclDoorNo || ''), String(x.plfmCmgFac || '')]);
        if (rows.length >= +b.totalCount || list.length < 1000) break;
      }
      return JSON.stringify(rows);
    });
    if (!all) return reply(502, { error: 'fstexit upstream' });
    const list = JSON.parse(all).filter(x => x[0] === st).map(([, line, dir, door, fac]) => ({ line, dir, door, fac }));
    return reply(200, { list });
  }

  /* 지하철역 엘리베이터 위치(서울 열린데이터광장 교통약자 엘리베이터 위치, 서울 안 모든 운영사 역): → { list: [[역, 위도, 경도]] }.
     출구 번호는 없고 자리만 있다. 서울교통공사 자료가 없는 9호선·우이신설선·코레일 서울 구간 등을 채운다. 7일 동안 저장 */
  if (kind === 'elevpos') {
    const sk = env.SEOUL_OPEN_KEY; if (!sk) return reply(503, { error: 'elevpos off' });
    const text = await edgeCached('epos1:all', 7 * 86400, async () => {
      const rows = [];
      for (let start = 1; start <= 3001; start += 1000) {
        const r = await fetch(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(sk)}/json/tbTraficElvtr/${start}/${start + 999}/`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => null); const s = j && j.tbTraficElvtr;
        if (!s) return rows.length ? JSON.stringify({ list: rows }) : null;
        for (const x of s.row || []) {
          const m = /POINT\(([\d.]+) ([\d.]+)\)/.exec(String(x.NODE_WKT || '')); if (!m) continue;
          rows.push([stName(x.SBWY_STN_NM), +(+m[2]).toFixed(6), +(+m[1]).toFixed(6)]);
        }
        if (rows.length >= +s.list_total_count || (s.row || []).length < 1000) break;
      }
      return JSON.stringify({ list: rows });
    });
    return text ? send(text, 200) : reply(502, { error: 'elevpos upstream' });
  }

  /* 노선별 역 목록(서울 열린데이터광장 지하철역 정보, 수도권 노선): → { lines: { '01호선': [['서울역', '133'], …] } } 외부코드(FR_CODE) 순.
     노선도(엘리베이터 노선도)에 쓴다. 30일 동안 저장 */
  if (kind === 'lines') {
    const sk = env.SEOUL_OPEN_KEY; if (!sk) return reply(503, { error: 'lines off' });
    const all = await edgeCached('lin1:all', 30 * 86400, async () => {
      const rows = [];
      for (let start = 1; start <= 3001; start += 1000) {
        const r = await fetch(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(sk)}/json/SearchSTNBySubwayLineInfo/${start}/${start + 999}/`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => null); const s = j && j.SearchSTNBySubwayLineInfo;
        if (!s) return rows.length ? JSON.stringify(rows) : null;
        for (const x of s.row || []) rows.push([String(x.LINE_NUM || ''), stName(x.STATION_NM), String(x.FR_CODE || ''), String(x.STATION_CD || '')]);
        if (rows.length >= +s.list_total_count) break;
      }
      return JSON.stringify(rows);
    });
    if (!all) return reply(502, { error: 'lines upstream' });
    // 역 좌표(서울 열린데이터광장 역사마스터): 역 이름(+노선)으로 붙인다. 못 받으면 좌표 없이
    const geo = await edgeCached('lin1:geo', 30 * 86400, async () => {
      const rows = [];
      for (let start = 1; start <= 3001; start += 1000) {
        const r = await fetch(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(sk)}/json/subwayStationMaster/${start}/${start + 999}/`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => null); const s = j && j.subwayStationMaster;
        if (!s) return rows.length ? JSON.stringify(rows) : null;
        for (const x of s.row || []) rows.push([stName(x.BLDN_NM), String(x.ROUTE || ''), +x.LAT || 0, +x.LOT || 0]);
        if (rows.length >= +s.list_total_count) break;
      }
      return JSON.stringify(rows);
    }).catch(() => null);
    const pos = new Map(), num = l => String(l).replace(/^0/, '').replace(/[^0-9A-Za-z가-힣]/g, '');
    for (const [name, route, lat, lng] of geo ? JSON.parse(geo) : []) if (lat && lng) { pos.set(`${name}|${num(route)}`, [lat, lng]); if (!pos.has(name)) pos.set(name, [lat, lng]); }
    const lines = {};
    for (const [line, name, fr, cd] of JSON.parse(all)) (lines[line] = lines[line] || []).push([name, fr, cd, ...(pos.get(`${name}|${num(line)}`) || pos.get(name) || [])]);
    for (const k of Object.keys(lines)) lines[k].sort((a, b) => a[1].localeCompare(b[1], 'en', { numeric: true }));
    return reply(200, { lines });
  }

  /* 빠른 환승(공공데이터포털 국토교통부_철도역 빠른 환승 정보, odcloud): 역 이름 → 그 역에서 갈아탈 노선으로 가장 빨리 가는 칸·문
     → { list: [{ op, line, end, xop, xline, xnext, xfrom, car, door }] } end: 타고 온 열차의 방향(종착역), xline·xnext: 갈아탈 노선과 그 방향(다음 역).
     전체(수천 줄)를 하루 동안 저장해 두고 역별로 나눠 준다 */
  if (kind === 'fsttrans') {
    const st = stName(input.station);
    if (!st || st.length > 20) return reply(400, { error: 'bad station' });
    const gk = dataKey(); if (!gk) return reply(503, { error: 'fsttrans off' });
    const s = v => String(v ?? '').trim();
    const all = await edgeCached('ftr1:all', 86400, async () => {
      const rows = [];
      for (let page = 1; page <= 10; page++) {
        const r = await fetch(`https://api.odcloud.kr/api/15151816/v1/uddi:e9c2bb71-05e8-4767-8397-9df787ee70f6?page=${page}&perPage=1000&returnType=JSON&serviceKey=${encodeURIComponent(gk)}`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => null);
        if (!j || !Array.isArray(j.data)) return rows.length ? JSON.stringify(rows) : null;
        for (const x of j.data) rows.push([stName(x['역명']), s(x['철도운영기관명']), s(x['노선명']), stName(x['종착역명']), s(x['환승철도운영기관명']), s(x['환승선']), stName(x['환승이후역명']), stName(x['환승기점역명']), +x['차량순서'] || 0, +x['차량출입문번호'] || 0]);
        if (rows.length >= +j.totalCount || j.data.length < 1000) break;
      }
      return JSON.stringify(rows);
    });
    if (!all) return reply(502, { error: 'fsttrans upstream' });
    const list = JSON.parse(all).filter(x => x[0] === st).map(([, op, line, end, xop, xline, xnext, xfrom, car, door]) => ({ op, line, end, xop, xline, xnext, xfrom, car, door }));
    return reply(200, { list });
  }

  /* 첫차·막차
     { type: 'bus', city: 'seoul', ars }   → 그 정류장에 서는 서울 버스들의 첫차·막차(차고지 출발 기준, 서울특별시_정류소정보조회) { list: [{ name, first, last }] }
     { type: 'bus', city: 'gg', route }    → 경기 버스 한 노선의 평일·토·일 첫차·막차(경기도_버스노선 조회) { wd, sat, sun: { first: [상행, 하행], last: [상행, 하행] } }
     { type: 'subway', station, line, lineName?, next, to?, week } → 그 역에서 그 방향(다음 역 쪽)으로 가는, 내리는 역(to)까지 가는 열차의 첫차·막차
       (1~9호선은 서울 열린데이터광장 역별 시간표, 그 밖의 노선은 국토교통부 TAGO 지하철정보). list: true면 times: [['HH:MM', 행선지]…]도
       line: 1~9, week: 1 평일·2 토요일·3 휴일 → { first, last, lastTo } */
  if (kind === 'sched') {
    const hm = v => { const m = /^(\d{1,2}):?(\d{2})/.exec(String(v || '').trim()); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
    if (input.type === 'bus' && input.city === 'seoul') {
      const ars = String(input.ars || ''); if (!/^\d{5}$/.test(ars)) return reply(400, { error: 'bad ars' });
      const gk = dataKey(); if (!gk) return reply(503, { error: 'off' });
      const t = await edgeCached(`sch1:sb:${ars}`, 86400, async () => {
        const r = await fetch(`http://ws.bus.go.kr/api/rest/stationinfo/getStationByUid?serviceKey=${encodeURIComponent(gk)}&arsId=${ars}&resultType=json`, { signal: AbortSignal.timeout(6000) });
        const j = await r.json().catch(() => null); const it = j && j.msgBody && j.msgBody.itemList; if (!it) return null;
        return JSON.stringify({ list: (Array.isArray(it) ? it : [it]).map(x => ({ name: String(x.rtNm || ''), first: hm(x.firstTm), last: hm(x.lastTm) })) });
      });
      return t ? send(t, 200) : reply(502, { error: 'sched upstream' });
    }
    if (input.type === 'bus' && input.city === 'gg') {
      const route = String(input.route || ''); if (!/^\d{6,10}$/.test(route)) return reply(400, { error: 'bad route' });
      const gk = dataKey(); if (!gk) return reply(503, { error: 'off' });
      const t = await edgeCached(`sch1:gb:${route}`, 86400, async () => {
        const r = await fetch(`https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteInfoItemv2?serviceKey=${encodeURIComponent(gk)}&routeId=${route}&format=json`, { signal: AbortSignal.timeout(6000) });
        const j = await r.json().catch(() => null); const x = j && j.response && j.response.msgBody && j.response.msgBody.busRouteInfoItem; if (!x) return null;
        const pair = (p, q) => [hm(x[p]), hm(x[q])];
        return JSON.stringify({ name: String(x.routeName || ''),
          wd: { first: pair('upFirstTime', 'downFirstTime'), last: pair('upLastTime', 'downLastTime') },
          sat: { first: pair('satUpFirstTime', 'satDownFirstTime'), last: pair('satUpLastTime', 'satDownLastTime') },
          sun: { first: pair('sunUpFirstTime', 'sunDownFirstTime'), last: pair('sunUpLastTime', 'sunDownLastTime') } });
      });
      return t ? send(t, 200) : reply(502, { error: 'sched upstream' });
    }
    if (input.type === 'subway') {
      const st = stName(input.station), nx = stName(input.next), line = String(input.line || ''), week = String(input.week || '1');
      if (!st || !nx || st.length > 20 || nx.length > 20 || !/^([1-9]|[가-힣A-Za-z0-9-]{2,10})$/.test(line) || !/^[123]$/.test(week)) return reply(400, { error: 'bad subway' });
      const to = stName(input.to).slice(0, 20), hint = String(input.lineName || '').slice(0, 20);
      // 하루 운행 순서의 분(새벽 3시 전은 전날 밤의 연장). 시간표의 '24:46'은 '00:46'으로 보여 준다
      const key = v => { const [h, m] = String(v).split(':').map(Number); return (h < 3 ? h + 24 : h) * 60 + m; };
      const show = v => { const [h, m] = v.split(':'); return `${String(+h % 24).padStart(2, '0')}:${m}`; };
      // 두 방향 시간표(rows: [출발 'HH:MM', 종착역 코드, 종착역 이름, (열차 번호)]) 중 다음 역 쪽으로 가는 것을 골라 첫차·막차·시간표를 낸다.
      // 먼저 역 코드의 숫자가 노선을 따라 커지거나 작아지는 것으로 가리고(num: 코드 → 숫자), 그걸로 안 되면(2호선 순환, 신림선 등)
      // resolve()가 다음 역 시간표와 맞춰 본다: 내 역을 떠난 열차가 몇 분 뒤 다음 역에 나타나는 쪽이 가는 방향
      const finish = async (t1, t2, cur, nxt, end, num, resolve) => {
        const want = Math.sign(num(nxt) - num(cur));
        const side = rows => Math.sign(rows.reduce((a, [, d]) => a + Math.sign(num(d) - num(cur)), 0));
        let pick = side(t1) === want && side(t2) !== want ? t1 : side(t2) === want && side(t1) !== want ? t2 : null;
        // 내리는 역까지 가는 열차만(중간 역에서 끝나는 열차는 막차가 아니다): 종착역이 내리는 역이거나 그 너머
        let reach = r => !end || r[1] === end || Math.sign(num(r[1]) - num(end)) === want;
        if (!pick && resolve) { const got = await resolve().catch(e => { diag = { err: e instanceof Response ? 'reply ' + e.status : String((e && e.message) || e).slice(0, 120) }; return null; }); if (got) { pick = got.rows; reach = got.reach || (() => true); } }
        // 그래도 못 가리면 두 방향을 합친다(가장 이른 첫차·가장 늦은 막차, 대략)
        const both = !pick;
        const far = pick ? pick.filter(reach) : [];
        // 다 걸러지면(갈래가 있는 노선, 2호선처럼 열차 번호가 중간에 바뀌는 노선) 거르지 않고, 내리는 역까지 가는지 확인 못 했다고 알린다
        const use = pick ? (far.length ? far : pick) : [...t1, ...t2];
        const rows = use.filter(r => r[0]).sort((a, b) => key(a[0]) - key(b[0]));
        if (!rows.length) return null;
        const lastRow = rows[rows.length - 1];
        // list: 시간표(출발 시각, 행선지)도 함께. 하루 운행 순서대로, 같은 시각 겹침은 하나로. 방향을 못 가렸으면(대략) 주지 않는다
        const times = input.list && !both ? [...new Map(rows.map(r => [r[0], [show(r[0]), r[2]]])).values()] : undefined;
        return { first: show(rows[0][0]), last: show(lastRow[0]), lastTo: both ? '' : lastRow[2], rough: both, ...(pick && end && !far.length && { unsure: true }), ...(times && { times }) };
      };

      // 1) 1~9호선: 서울 열린데이터광장 역별 시간표
      const seoul = async () => {
        const sk = env.SEOUL_OPEN_KEY; if (!sk || !/^[1-9]$/.test(line)) return null;
        const base = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(sk)}/json`;
        const code = async name => { // 역 이름 → 그 노선의 역 코드(30일 저장)
          const t = await edgeCached(`sch1:stc:${name}`, 30 * 86400, async () => {
            const r = await fetch(`${base}/SearchInfoBySubwayNameService/1/20/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
            const j = await r.json().catch(() => null); const s = j && j.SearchInfoBySubwayNameService; if (!s) return null;
            return JSON.stringify((s.row || []).map(x => [String(x.LINE_NUM || ''), String(x.STATION_CD || '')]));
          });
          const hit = t && JSON.parse(t).find(([l]) => l === `0${line}호선`);
          return hit ? hit[1] : '';
        };
        const [cur, nxt, end] = await Promise.all([code(st), code(nx), to ? code(to) : '']);
        if (!cur || !nxt) return null;
        const table = async (at, dir) => { // 역 코드·방향(1·2) → [출발, 종착역 코드, 종착역 이름, 열차 번호]
          const t = await edgeCached(`sch2:stt:${at}:${week}:${dir}`, 86400, async () => {
            const r = await fetch(`${base}/SearchSTNTimeTableByIDService/1/600/${at}/${week}/${dir}`, { signal: AbortSignal.timeout(8000) });
            const j = await r.json().catch(() => null); const s = j && j.SearchSTNTimeTableByIDService; if (!s) return null;
            return JSON.stringify((s.row || []).map(x => [hm(x.LEFTTIME || x.ARRIVETIME), String(x.DESTSTATION || ''), String(x.SUBWAYENAME || ''), String(x.TRAIN_NO || '')]));
          });
          return t ? JSON.parse(t) : [];
        };
        const [t1, t2] = await Promise.all([table(cur, 1), table(cur, 2)]);
        // 열차 번호로 맞춰 보기: 같은 번호의 열차가 0~6분 뒤 다음 역 시간표(같은 방향)에 있는 쪽
        // 열차 번호는 하루에 여러 번 다시 쓰이기도 해서, 번호마다 시각 목록으로 두고 '몇 분 안에 뒤따라 나타나는지'로 본다
        const byNo = rows => { const m = new Map(); for (const r of rows) if (r[3] && r[0]) (m.get(r[3]) || m.set(r[3], []).get(r[3])).push(key(r[0])); return m; };
        const after = (m, r, lo, hi) => (m.get(r[3]) || []).some(t => t - key(r[0]) >= lo && t - key(r[0]) <= hi);
        const resolve = async () => {
          const [n1, n2] = await Promise.all([table(nxt, 1), table(nxt, 2)]);
          const score = (a, b) => { const m = byNo(b); return a.filter(r => after(m, r, 0, 6)).length; };
          const s1 = score(t1, n1), s2 = score(t2, n2);
          diag = { s1, s2 };
          if (Math.max(s1, s2) < 5 || s1 === s2) return null;
          const dir = s1 > s2 ? 1 : 2, rows = dir === 1 ? t1 : t2;
          // 내리는 역까지 가는지도 열차 번호로: 그 열차가 내 역을 떠나고 100분 안에 내리는 역 시간표(같은 방향)에 나타나면
          let reachBy = null;
          if (end) {
            const m = byNo(await table(end, dir));
            if (m.size) reachBy = r => after(m, r, 1, 100);
          }
          return { rows, reach: reachBy };
        };
        return finish(t1, t2, cur, nxt, end, v => +v, resolve);
      };

      // 2) 그 밖의 노선(수인분당·신분당·공항철도·경의중앙·서해·신림선·인천1호선·경전철 등): 공공데이터포털 국토교통부_(TAGO)_지하철정보
      const tago = async () => {
        const gk = dataKey(); if (!gk) return null;
        const T = (op, q) => `https://apis.data.go.kr/1613000/SubwayInfo/${op}?serviceKey=${encodeURIComponent(gk)}&_type=json&${new URLSearchParams(q)}`;
        const items = j => { const it = j && j.response && j.response.body && j.response.body.items && j.response.body.items.item; return !it ? [] : Array.isArray(it) ? it : [it]; };
        const ids = async name => { // 역 이름 → [노선 이름, 역 ID] 목록(30일 저장)
          const t = await edgeCached(`sch1:tgs:${name}`, 30 * 86400, async () => {
            const r = await fetch(T('GetKwrdFndSubwaySttnList', { subwayStationName: name, numOfRows: 50, pageNo: 1 }), { signal: AbortSignal.timeout(6000) });
            const j = await r.json().catch(() => null); if (!j || !j.response) return null;
            return JSON.stringify(items(j).filter(x => stName(x.subwayStationName) === name).map(x => [String(x.subwayRouteName || ''), String(x.subwayStationId || '')]));
          });
          return t ? JSON.parse(t) : [];
        };
        const [a, b, c] = await Promise.all([ids(st), ids(nx), to ? ids(to) : []]);
        // 타는 역과 다음 역에 같이 있는 노선. 여럿이면 ODsay 노선 이름(hint)과 맞는 것
        const common = a.filter(([r]) => b.some(([r2]) => r2 === r));
        if (!common.length) return null;
        const core = v => v.replace(/^수도권\s*/, '').replace(/(선|라인)$/, '');
        const [route, cur] = common.find(([r]) => hint && (core(hint).includes(core(r)) || core(r).includes(core(hint)))) || common[0];
        const nxt = b.find(([r]) => r === route)[1], end = (c.find(([r]) => r === route) || [])[1] || '';
        const day = { 1: '01', 2: '02', 3: '03' }[week];
        const table = async (at, ud) => {
          const t = await edgeCached(`sch1:tgt:${at}:${day}:${ud}`, 86400, async () => {
            const r = await fetch(T('GetSubwaySttnAcctoSchdulList', { subwayStationId: at, dailyTypeCode: day, upDownTypeCode: ud, numOfRows: 1000, pageNo: 1 }), { signal: AbortSignal.timeout(8000) });
            const j = await r.json().catch(() => null); if (!j || !j.response) return null;
            // 같은 줄이 여러 번 오는 경우가 있어 한 번씩만
            return JSON.stringify([...new Set(items(j).map(x => [hm(x.depTime) || hm(x.arrTime), String(x.endSubwayStationId || ''), stName(x.endSubwayStationNm)].join('|')))].map(v => v.split('|')));
          });
          return t ? JSON.parse(t) : [];
        };
        const [t1, t2] = await Promise.all([table(cur, 'U'), table(cur, 'D')]);
        const numOf = id => +((/(\d+)$/.exec(id) || [])[1] || 0), want = Math.sign(numOf(nxt) - numOf(cur));
        // 1) 종착역 이름으로: 방향마다 가장 많은 종착역을 같은 노선의 역 ID로 바꿔, 다음 역과 같은 쪽에 있는 방향
        // 2) 그래도 안 되면 시각으로 맞춰 보기(열차 번호가 없어서): 내 역 출발마다 1~3분 뒤 다음 역(같은 방향) 출발이 있는 비율이 높은 쪽
        const resolve = async () => {
          const term = rows => { const c = new Map(); for (const r of rows) if (r[2]) c.set(r[2], (c.get(r[2]) || 0) + 1); return ([...c].sort((p, q) => q[1] - p[1])[0] || [''])[0]; };
          const idOf = async nm => nm ? ((await ids(stName(nm))).find(([r]) => r === route) || [])[1] || '' : '';
          const [e1, e2] = await Promise.all([idOf(term(t1)), idOf(term(t2))]);
          const d1 = e1 ? Math.sign(numOf(e1) - numOf(cur)) : 0, d2 = e2 ? Math.sign(numOf(e2) - numOf(cur)) : 0;
          // 방향별 표가 제대로 나뉘었을 때만(가장 많은 종착역 쪽 열차가 대부분일 때) 이 방법을 믿는다
          const pure = (rows, e) => { const s = e ? Math.sign(numOf(e) - numOf(cur)) : 0; return s !== 0 && rows.filter(r => r[1] && Math.sign(numOf(r[1]) - numOf(cur)) === s).length >= rows.length * 0.8; };
          if (want && d1 && d2 && d1 !== d2 && pure(t1, e1) && pure(t2, e2)) return { rows: d1 === want ? t1 : t2, reach: null };
          // 방향 구분 없이 두 방향 열차가 섞여 오는 노선(신림선 등): 열차마다 종착역이 다음 역 쪽에 있는 것만 모은다
          if (want) {
            const names = [...new Set([...t1, ...t2].map(r => r[2]).filter(Boolean))].slice(0, 12);
            const side = new Map(await Promise.all(names.map(async nm => { const id = await idOf(nm); return [nm, id ? Math.sign(numOf(id) - numOf(cur)) : 0]; })));
            const seen = new Set(), rows = [];
            for (const r of [...t1, ...t2]) { const k = r[0] + '|' + r[2]; if (r[0] && side.get(r[2]) === want && !seen.has(k)) { seen.add(k); rows.push(r); } }
            if (rows.length >= 10) return { rows, reach: null };
          }
          const [n1, n2] = await Promise.all([table(nxt, 'U'), table(nxt, 'D')]);
          const score = (a, b) => { const bs = new Set(b.filter(r => r[0]).map(r => key(r[0]))); const as = a.filter(r => r[0]); if (as.length < 10) return 0;
            return as.filter(r => [1, 2, 3].some(k => bs.has(key(r[0]) + k))).length / as.length; };
          const s1 = score(t1, n1), s2 = score(t2, n2);
          diag = { s1: +s1.toFixed(2), s2: +s2.toFixed(2), ends: [term(t1), term(t2), e1, e2], ids: [cur, nxt] };
          if (Math.max(s1, s2) < 0.85 || Math.abs(s1 - s2) < 0.2) return null;
          return { rows: s1 > s2 ? t1 : t2, reach: null };
        };
        return finish(t1, t2, cur, nxt, end, id => +((/(\d+)$/.exec(id) || [])[1] || 0), resolve);
      };

      let diag = null; // 방향을 못 가렸을 때 원인 확인용(판별 점수만)
      const out = (await seoul()) || (await tago());
      if (out && out.rough && diag) out.diag = diag;
      return reply(200, out || { none: true });
    }
    return reply(400, { error: 'bad type' });
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
    if (input.all !== true && (!st || st.length > 20)) return reply(400, { error: 'bad station' }); // all: 모든 역 요약(노선도용)
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
    // 모든 역 요약(엘리베이터 노선도): { stations: { 역: [지상 엘리베이터 출구 '1·6·9', 승강장 엘리베이터 수, 점검·중지 수, 지상 엘리베이터 수] } }
    if (input.all === true) {
      const ground = f => /^1F?$/i.test(f);
      const exitsOf = x => [...(/^\d/.test(x.exit) ? x.exit.split(',') : []), ...((/(\d+(?:,\d+)*)번 출입구/.exec(x.pos) || [])[1] || '').split(',')].map(v => v.trim()).filter(Boolean);
      const by = new Map();
      for (const x of JSON.parse(all)) { const k = x.st.replace(/역$/, ''); (by.get(k) || by.set(k, []).get(k)).push(x); }
      const stations = {};
      for (const [k, xs] of by) {
        const outs = xs.filter(x => ground(x.from) || ground(x.to));
        const exits = [...new Set(outs.flatMap(exitsOf))].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
        stations[k] = [exits.join('·'), xs.length - outs.length, xs.filter(x => !x.ok).length, outs.length];
      }
      return reply(200, { stations });
    }
    const list = JSON.parse(all).filter(x => x.st.replace(/역$/, '') === st).map(({ st: _, ...x }) => x);
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
        // Claude Haiku 5.5: temperature 등 표본 추출 값은 보내면 400. 생각(thinking)이 기본으로 켜져 있어 답 앞에 생각 블록이 올 수 있고
        // 그만큼 max_tokens를 쓴다 → 생각은 짧게(effort low), 한도는 넉넉히
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 2048, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content }] }),
      });
      const j = await up.json().catch(() => null);
      if (!up.ok || !j) { console.log(JSON.stringify({ ai: 'error', status: up.status, type: j && j.error && j.error.type })); throw reply(502, { error: 'ai error' }); }
      if (j.stop_reason === 'refusal') throw reply(422, { error: 'ai refusal' }); // 안전 분류기가 거절한 경우(답 없음)
      const out = String((j.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('')); // 생각 블록은 건너뛰고 답 글자만
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
      const cacheKey = 'intent5:' + text; // (5: Haiku 5.5로 바꿈) 지시문이나 모델을 바꾸면 번호를 올려 예전 저장 결과를 쓰지 않게 한다
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

    /* 사진+위치로 장소 찾기: { image: base64 JPEG 1장, x, y } → 그 자리 근처에서 사진의 가게 후보.
       1) 카카오 업종별로 반경 150m 안 가게를 모으고 2) AI가 사진의 간판·메뉴판 글자와 생김새로 후보 중에서 고르고
       3) 읽은 간판 글자로 반경 500m 안을 한 번 더 찾는다. 사진과 위치는 저장하지 않는다. 위치는 AI에 보내지 않는다(가게 이름 목록만) */
    if (kind === 'photoplace') {
      const data = String(input.image || '');
      if (data.length < 100 || data.length > 1500000 || !/^[A-Za-z0-9+/=]+$/.test(data)) return reply(400, { error: 'no image' });
      const x = num(input.x), y = num(input.y);
      if (!inKorea(x, y)) return reply(400, { error: 'coordinates out of range' });
      await count();
      const pick = d => ({ name: d.place_name, category: d.category_name, address: d.road_address_name || d.address_name, phone: d.phone, x: d.x, y: d.y, url: d.place_url, distance: d.distance, id: String(d.id || '') });
      const groups = ['CE7', 'FD6', 'CS2', 'PM9', 'HP8', 'BK9', 'MT1', 'AC5', 'AD5', 'CT1'];
      const near = (await Promise.all(groups.map(g => kakao('search/category', { category_group_code: g, x: String(x), y: String(y), radius: '150', sort: 'distance', size: '15' })
        .then(j => j.documents || []).catch(() => [])))).flat();
      const seen = new Set(), cands = [];
      for (const d of near.sort((a, b) => +a.distance - +b.distance)) if (!seen.has(d.id)) { seen.add(d.id); cands.push(pick(d)); }
      const list = cands.slice(0, 50);
      const system = `너는 공간 기록 지도의 장소 찾기 도우미다. 이용자가 지금 있는 가게 안이나 앞에서 찍은 사진 한 장과, 그 자리 근처 가게 목록을 받는다.
- sign: 사진에 보이는 가게 이름으로 보이는 글자(간판, 메뉴판, 컵, 영수증, 안내문)를 그대로 적는다. 없으면 빈 글자. 가게 이름이 아닌 일반 낱말(OPEN, 커피, 메뉴)은 적지 않는다.
- picks: 목록에서 이 사진의 가게일 가능성이 높은 번호를 높은 순으로 최대 3개. 간판 글자가 맞거나, 업종과 생김새(예: 커피 머신·진열대·약 진열장)가 분명히 맞을 때만. 애매하면 비운다.
- kind: 이 사진이 무엇을 찍었는지 하나: 입구 | 내부 | 화장실 | 외관 | 층 이동 | 안내문 | 기타
목록:
${list.map((c, i) => `${i}. ${c.name} (${String(c.category || '').split('>').slice(-2).join('>').trim()}, ${c.distance}m)`).join('\n') || '(근처 가게 없음)'}
출력은 JSON 하나만, 설명 없이: {"sign":"","picks":[0],"kind":"내부"}`;
      const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }, { type: 'text', text: '이 사진은 어느 가게일까?' }];
      const ai = await askClaude(system, content);
      const sign = String(ai.sign || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 30);
      const kinds = ['입구', '내부', '화장실', '외관', '층 이동', '안내문', '기타'];
      const out = [], has = new Set();
      const add = (c, why) => { const k = c.id || c.name + c.x; if (has.has(k)) return; has.add(k); out.push({ ...c, why }); };
      for (const i of (Array.isArray(ai.picks) ? ai.picks : []).slice(0, 3)) if (Number.isInteger(i) && list[i]) add(list[i], '사진과 맞음');
      // 간판 글자로 근처를 다시 찾는다(업종 분류가 없는 옷가게·미용실 같은 곳도 찾게)
      if (sign.length >= 2) {
        const j = await kakao('search/keyword', { query: sign, x: String(x), y: String(y), radius: '500', sort: 'distance', size: '5' }).catch(() => null);
        for (const d of (j && j.documents) || []) add(pick(d), '간판 글자');
      }
      for (const c of list.slice(0, 8)) add(c, '가까운 곳');
      return reply(200, { sign, kind: kinds.includes(ai.kind) ? ai.kind : '', places: out.slice(0, 15).map(({ id, ...c }) => c) });
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

// 1년 지난 '사진으로 찾기' 사진(supabase/26_find_photos.sql) 지우기: 저장소 파일을 먼저, 그다음 표의 줄. 한 번에 500개씩.
// 관리자 키(비밀 변수 SUPABASE_SERVICE_KEY)가 있어야 한다. 없으면 아무것도 하지 않는다

/* ---------- KRIC(철도산업정보센터) 공통: 수도권 모든 역의 운영기관·노선·역 코드, 엘리베이터 동선, 화장실 ----------
   KRIC 서버가 자주 멈춰서 받은 것은 KV에 두고(정해진 기간이 지나면 새로), 못 받으면 전에 받은 것을 쓴다 */
const KRIC_LINES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'K1', 'K2', 'K4', 'K5', 'A1', 'D1', 'U1', 'UI', 'E1', 'G1', 'I1', 'I2', 'WS', 'A'];
// ODsay 지하철 노선 번호 → KRIC 노선 코드(1~9호선은 같다)
const ODSAY_KRIC = { 101: 'A1', 104: 'K4', 107: 'E1', 108: 'K2', 109: 'D1', 110: 'U1', 112: 'K5', 113: 'UI', 114: 'WS', 115: 'G1', 116: 'K1', 21: 'I1', 22: 'I2' };
const kStName = v => String(v || '').replace(/\(.*\)$/, '').replace(/역$/, '').trim();
async function kricGet(env, path, params){
  const qs = new URLSearchParams({ serviceKey: env.KRIC_KEY, format: 'json', ...params });
  const r = await fetch(`https://openapi.kric.go.kr/openapi/${path}?${qs}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  const j = r ? await r.json().catch(() => null) : null; const h = j && j.header;
  if (!h || (h.resultCode !== '00' && h.resultCode !== '03')) return null; // 03: 자료 없음(빈 목록)
  return Array.isArray(j.body) ? j.body : [];
}
// KV 값: maxAge 안이면 그대로, 지났으면 새로 받고, 못 받으면 전 것. 서버 메모리에도 1시간
async function kvFresh(env, ctx, key, maxAgeMs, make){
  const m = memGet(key); if (m) return m;
  const kv = env.ROUTE_CACHE;
  const old = kv ? await kv.get(key, 'json').catch(() => null) : null;
  if (old && Date.now() - old.t < maxAgeMs) { memPut(key, old.v, 3600); return old.v; }
  const v = await make().catch(() => null);
  if (v != null) {
    memPut(key, v, 3600);
    if (kv) { const p = kv.put(key, JSON.stringify({ t: Date.now(), v })).catch(() => {}); if (ctx) ctx.waitUntil(p); else await p; }
    return v;
  }
  return old ? old.v : null;
}
// 역 이름 → [[운영기관, 노선 코드, 역 코드, 노선 이름]](30일마다 새로)
function kricStations(env, ctx){
  return kvFresh(env, ctx, 'kric2:stations', 30 * 86400000, async () => {
    const lists = await Promise.all(KRIC_LINES.map(ln => kricGet(env, 'trainUseInfo/subwayRouteInfo', { mreaWideCd: '01', lnCd: ln })));
    if (lists.filter(l => l && l.length).length < KRIC_LINES.length / 2) return null; // 반 넘게 못 받았으면 실패로
    const out = {};
    for (const list of lists) for (const x of list || []) {
      const n = kStName(x.stinNm), c = [String(x.railOprIsttCd || ''), String(x.lnCd || ''), String(x.stinCd || ''), String(x.routNm || '')];
      if (!(out[n] = out[n] || []).some(o => o[0] === c[0] && o[1] === c[1] && o[2] === c[2])) out[n].push(c);
    }
    return out;
  });
}
// 역 하나(운영기관·노선·역 코드)의 화장실 → [{ gate: '내'|'외', floor: 'B1', exit, loc, sex, n, diaper }]
function kricToilets(env, ctx, [op, ln, stin]){
  return kvFresh(env, ctx, `kric2:tl:${op}:${ln}:${stin}`, 30 * 86400000, async () => {
    const b = await kricGet(env, 'convenientInfo/stationToilet', { railOprIsttCd: op, lnCd: ln, stinCd: stin }); if (b == null) return null;
    return b.map(x => ({ gate: String(x.gateInotDvNm || ''), floor: `${x.grndDvNm === '지하' ? 'B' : ''}${x.stinFlor ?? ''}`, exit: String(x.exitNo || ''),
      loc: String(x.dtlLoc || '').slice(0, 80), sex: String(x.mlFmlDvNm || ''), n: +x.toltNum || 0, diaper: +x.diapExchNum || 0 }));
  });
}
// 예약 작업(10분마다): 노선도에 화장실 표시를 하려고 모든 역의 화장실 요약을 조금씩(한 번에 10역) 채운다. 7일 지나면 다시
async function fillToiletSum(env){
  if (!env.KRIC_KEY || !env.ROUTE_CACHE) return;
  const all = await kricStations(env, null); if (!all) return;
  const kv = env.ROUTE_CACHE, sum = (await kv.get('kric2:tlsum', 'json').catch(() => null)) || {}, now = Date.now();
  // 무료 요금제는 한 번 실행에 외부 호출 50번까지라, 한 번에 10역(역마다 노선 2개까지)만
  const names = Object.keys(all).filter(n => !sum[n] || now - sum[n][3] > 7 * 86400000).slice(0, 10);
  if (!names.length) return;
  let changed = false;
  for (const n of names) {
    const lists = []; let ok = true;
    // KV 쓰기 한도(하루 1,000번)를 아끼려고 역마다 따로 저장하지 않고 바로 묻는다. 요약만 한 번 저장
    for (const [op, ln, stin] of all[n].slice(0, 2)) { const b = await kricGet(env, 'convenientInfo/stationToilet', { railOprIsttCd: op, lnCd: ln, stinCd: stin }); if (b == null) { ok = false; break; } lists.push(...b.map(x => ({ gate: String(x.gateInotDvNm || ''), diaper: +x.diapExchNum || 0 }))); }
    if (!ok) continue; // KRIC가 멈췄으면 다음에
    sum[n] = [lists.length, lists.some(x => x.gate === '내') ? 1 : 0, lists.some(x => x.diaper > 0) ? 1 : 0, now]; changed = true;
  }
  if (changed) await kv.put('kric2:tlsum', JSON.stringify(sum)).catch(() => {});
}
async function expireFinds(env) {
  const key = env.SUPABASE_SERVICE_KEY; if (!key) { console.log(JSON.stringify({ expireFinds: 'no key' })); return; }
  const h = { apikey: key, ...(/^eyJ/.test(key) && { Authorization: 'Bearer ' + key }) }; // 예전 형식(JWT) 키는 Authorization도
  const cutoff = new Date(Date.now() - 365 * 86400e3).toISOString();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/find_photos?select=id,path&created_at=lt.${encodeURIComponent(cutoff)}&order=id&limit=500`, { headers: h });
  const rows = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(rows)) { console.log(JSON.stringify({ expireFinds: 'list failed', status: r.status })); return; }
  if (!rows.length) return;
  const del = await fetch(`${SUPABASE_URL}/storage/v1/object/finds`, { method: 'DELETE', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: rows.map(x => x.path) }) });
  if (!del.ok) { console.log(JSON.stringify({ expireFinds: 'storage failed', status: del.status })); return; }
  const d2 = await fetch(`${SUPABASE_URL}/rest/v1/find_photos?id=in.(${rows.map(x => +x.id).join(',')})`, { method: 'DELETE', headers: h });
  console.log(JSON.stringify({ expireFinds: rows.length, rows: d2.status }));
}

// 새 신고 알림: 지난번에 알린 뒤로 들어온 신고를 모아 운영자 메일(NOTIFY_EMAIL)로 한 통 보낸다(Resend, 비밀 변수 RESEND_API_KEY).
// 신고 사유·내용·장소 이름만 보내고 신고한 사람은 보내지 않는다. 어디까지 알렸는지는 KV에 시각 하나로 둔다(새 신고가 있을 때만 쓴다)
async function notifyReports(env) {
  const key = env.SUPABASE_SERVICE_KEY, rk = env.RESEND_API_KEY, to = env.NOTIFY_EMAIL, kv = env.ROUTE_CACHE;
  if (!key || !rk || !to || !kv) return;
  const h = { apikey: key, ...(/^eyJ/.test(key) && { Authorization: 'Bearer ' + key }) };
  const since = (await kv.get('notify:reports:since').catch(() => null)) || new Date(Date.now() - 3600e3).toISOString();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/reports?select=id,reason,detail,status,created_at,records(id,places(name))&created_at=gt.${encodeURIComponent(since)}&order=created_at&limit=50`, { headers: h });
  const rows = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(rows)) { console.log(JSON.stringify({ notifyReports: 'list failed', status: r.status })); return; }
  if (!rows.length) return;
  const clean = (v, n) => String(v || '').replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, n);
  const lines = rows.map(x => `• [${clean(x.reason, 20)}] ${clean(x.records && x.records.places && x.records.places.name, 40) || '(지워진 기록)'}${x.detail ? ` — ${clean(x.detail, 200)}` : ''}${x.status === 'auto_hidden' ? ' (신고가 쌓여 자동으로 숨김)' : ''}`);
  const text = `새 신고 ${rows.length}건이 들어왔어요.\n\n${lines.join('\n')}\n\n처리: 공간실록 → 계정 메뉴 → 관리자 (현황·신고)\nhttps://ian-space.github.io/gongan-sillok/`;
  const m = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + rk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: '공간실록 알림 <onboarding@resend.dev>', to: [to], subject: `[공간실록] 새 신고 ${rows.length}건`, text }) });
  if (!m.ok) { console.log(JSON.stringify({ notifyReports: 'mail failed', status: m.status })); return; } // 못 보냈으면 다음 차례에 다시
  await kv.put('notify:reports:since', rows[rows.length - 1].created_at).catch(() => {});
  console.log(JSON.stringify({ notifyReports: rows.length }));
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
