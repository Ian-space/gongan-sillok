// 공간실록 중계 서버 (Cloudflare Worker)
// - 외부 서비스 키(TMAP, 카카오)를 사이트 코드 대신 여기 비밀 변수에만 둔다.
//     TMAP_APP_KEY   : TMAP 대중교통·보행자 경로
//     KAKAO_REST_KEY : 카카오 로컬 장소 검색 (REST API 키)
// - 경로 결과 저장: KV 바인딩 ROUTE_CACHE (Settings → Bindings → KV namespace)
// - 공간실록 사이트에서 온 요청만 받는다.
//
// 경로
//   POST /transit  { startX, startY, endX, endY, searchDttm? }  → TMAP 대중교통
//   POST /walk     { startX, startY, endX, endY }               → TMAP 보행자 경로
//   POST /search   { query, x?, y? }                            → 카카오 키워드 장소 검색 (x, y가 있으면 그 근처부터)
//   POST /station  { x, y }                                     → 1.5km 안 지하철역 (가까운 순)
//   POST /nearby   { rect: "왼쪽X,아래Y,오른쪽X,위Y", code? }      → 지도 한 칸 안의 장소 (code: CS2 편의점, CE7 카페, FD6 음식점, PM9 약국, BK9 은행, CT1 문화시설, LIB 도서관)
//   POST /intent   { text }                                     → 글로 적은 목적을 기록 항목 조건으로 (Claude, 비밀 변수 ANTHROPIC_API_KEY)
//   POST /photo    { images: [base64 JPEG, 최대 3장] }          → 사진에서 눈으로 확인되는 기록 항목 제안 (Claude, 같은 비밀 변수)

const ALLOWED_ORIGINS = ['https://ian-space.github.io', 'http://localhost:8765'];
const VERSION = '2026-10-07.4'; // 응답 머리말 X-GS-Version. 자동 배포가 됐는지 확인할 때 본다
// 경로 결과 저장 시간(초). KV 바인딩(ROUTE_CACHE)이 없으면 저장하지 않고 그대로 동작한다
const CACHE_SECONDS = { transit: 600, walk: 86400 };
// 주변 장소 종류. 카카오 업종 코드(CE7 카페, FD6 음식점, CT1 문화시설)로 찾고,
// 업종 분류가 없는 도서관은 검색어로 찾은 뒤 분류에 '도서관'이 있는 곳만 남긴다
const NEARBY = {
  CS2: { api: 'category', params: { category_group_code: 'CS2' } },
  CE7: { api: 'category', params: { category_group_code: 'CE7' } },
  FD6: { api: 'category', params: { category_group_code: 'FD6' } },
  PM9: { api: 'category', params: { category_group_code: 'PM9' } },
  BK9: { api: 'category', params: { category_group_code: 'BK9' } },
  CT1: { api: 'category', params: { category_group_code: 'CT1' } },
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

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
      'X-GS-Version': VERSION,
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return reply(403, { error: 'forbidden origin' });
    if (request.method !== 'POST') return reply(405, { error: 'POST only' });

    const kind = new URL(request.url).pathname.replace(/^\/+/, '');
    if (!TMAP[kind] && !['search', 'nearby', 'station', 'intent', 'photo'].includes(kind)) return reply(404, { error: 'unknown path' });

    let input;
    try { input = await request.json(); } catch { return reply(400, { error: 'invalid json' }); }
    const num = v => (typeof v === 'string' || typeof v === 'number') && /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : NaN;
    const inKorea = (x, y) => x >= 124 && x <= 132 && y >= 33 && y <= 39;

    /* 카카오 장소 검색 */
    if (kind === 'search') {
      if (!env.KAKAO_REST_KEY) return reply(500, { error: 'KAKAO_REST_KEY is not set' });
      const query = String(input.query || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
      if (!query) return reply(400, { error: 'empty query' });
      const params = new URLSearchParams({ query, size: '15' });
      const x = num(input.x), y = num(input.y);
      if (inKorea(x, y)) { params.set('x', String(x)); params.set('y', String(y)); } // 지도 중심 근처 결과부터
      const up = await fetch('https://dapi.kakao.com/v2/local/search/keyword.json?' + params, { headers: { Authorization: 'KakaoAK ' + env.KAKAO_REST_KEY } });
      const j = await up.json().catch(() => null);
      if (!up.ok || !j) return reply(up.status === 200 ? 502 : up.status, { error: (j && (j.message || j.msg)) || 'kakao error' });
      // 사이트에 필요한 칸만 넘긴다
      return reply(200, { places: (j.documents || []).map(d => ({
        name: d.place_name, category: d.category_name, address: d.road_address_name || d.address_name,
        phone: d.phone, x: d.x, y: d.y, url: d.place_url, distance: d.distance,
      })) });
    }

    /* 가까운 지하철역: 카카오 업종 검색(SW8)으로 1.5km 안의 역을 가까운 순으로. 역은 잘 바뀌지 않아 약 100m 단위로 30일 저장 */
    if (kind === 'station') {
      if (!env.KAKAO_REST_KEY) return reply(500, { error: 'KAKAO_REST_KEY is not set' });
      const x = num(input.x), y = num(input.y);
      if (!inKorea(x, y)) return reply(400, { error: 'coordinates out of range' });
      const cacheKey = `station:${x.toFixed(3)},${y.toFixed(3)}`;
      const kv = env.ROUTE_CACHE;
      if (kv) { const hit = await kv.get(cacheKey).catch(() => null); if (hit) return new Response(hit, { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' } }); }
      const params = new URLSearchParams({ category_group_code: 'SW8', x: x.toFixed(4), y: y.toFixed(4), radius: '1500', sort: 'distance', size: '5' });
      const up = await fetch('https://dapi.kakao.com/v2/local/search/category.json?' + params, { headers: { Authorization: 'KakaoAK ' + env.KAKAO_REST_KEY } });
      const j = await up.json().catch(() => null);
      if (!up.ok || !j) return reply(up.status === 200 ? 502 : up.status, { error: (j && (j.message || j.msg)) || 'kakao error' });
      const text = JSON.stringify({ stations: (j.documents || []).map(d => ({ name: d.place_name, line: String(d.category_name || '').split('>').pop().trim(), x: d.x, y: d.y })) });
      if (kv) ctx.waitUntil(kv.put(cacheKey, text, { expirationTtl: 30 * 86400 }).catch(() => {}));
      return new Response(text, { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': kv ? 'MISS' : 'OFF' } });
    }

    /* 카카오 업종 검색: 지도 한 칸(사각형) 안의 장소. 카카오는 한 번에 최대 45곳(15곳씩 3쪽)만 준다.
       그보다 많고 칸이 아직 크면 { split: true }만 돌려줘서, 사이트가 칸을 4등분해 다시 묻게 한다.
       가게 정보라 하루 동안 저장해 다시 쓴다 */
    if (kind === 'nearby') {
      if (!env.KAKAO_REST_KEY) return reply(500, { error: 'KAKAO_REST_KEY is not set' });
      const r = String(input.rect || '').split(',').map(num);
      if (r.length !== 4 || !inKorea(r[0], r[1]) || !inKorea(r[2], r[3]) || r[2] <= r[0] || r[3] <= r[1] || r[2] - r[0] > 0.03 || r[3] - r[1] > 0.03)
        return reply(400, { error: 'bad rect' });
      const code = NEARBY[input.code] ? input.code : 'CE7';
      const how = NEARBY[code];
      const rect = r.map(v => v.toFixed(4)).join(',');
      const canSplit = r[2] - r[0] > 0.0016;
      const cacheKey = `nearby2:${code}:${rect}`;
      const kv = env.ROUTE_CACHE;
      if (kv) { const hit = await kv.get(cacheKey).catch(() => null); if (hit) return new Response(hit, { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' } }); }
      const places = [];
      let split = false;
      for (let page = 1; page <= 3; page++) {
        const params = new URLSearchParams({ rect, page: String(page), size: '15', ...how.params });
        const up = await fetch(`https://dapi.kakao.com/v2/local/search/${how.api}.json?` + params, { headers: { Authorization: 'KakaoAK ' + env.KAKAO_REST_KEY } });
        const j = await up.json().catch(() => null);
        if (!up.ok || !j) return reply(up.status === 200 ? 502 : up.status, { error: (j && (j.message || j.msg)) || 'kakao error' });
        if (page === 1 && canSplit && j.meta && j.meta.total_count > 45) { split = true; break; }
        for (const d of j.documents || []) {
          if (how.keep && !how.keep(d)) continue;
          places.push({ name: d.place_name, category: d.category_name, address: d.road_address_name || d.address_name, phone: d.phone, x: d.x, y: d.y, url: d.place_url });
        }
        if (!j.meta || j.meta.is_end) break;
      }
      const text = JSON.stringify(split ? { places: [], split: true } : { places });
      if (kv) ctx.waitUntil(kv.put(cacheKey, text, { expirationTtl: 86400 }).catch(() => {}));
      return new Response(text, { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': kv ? 'MISS' : 'OFF' } });
    }



    /* 글로 적은 목적 → 기록 항목 조건 (Anthropic Claude). 사이트에서 이용자가 'AI로 조건 찾기'를 눌렀을 때만 온다.
       기록 항목 안의 값만 돌려주고, 같은 문장은 30일 저장해 다시 쓴다. 누가 물었는지는 저장하지 않는다 */
    if (kind === 'intent') {
      if (!env.ANTHROPIC_API_KEY) return reply(503, { error: 'ai off' });
      const text = String(input.text || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (text.length < 2) return reply(400, { error: 'empty text' });
      const kv = env.ROUTE_CACHE;
      const cacheKey = 'intent4:' + text; // 지시문을 바꾸면 번호를 올려 예전 저장 결과를 쓰지 않게 한다
      if (kv) {
        const hit = await kv.get(cacheKey).catch(() => null);
        if (hit) return new Response(hit, { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' } });
        // 비용 보호: 한 접속 주소당 시간마다 20번, 전체 하루 2000번까지
        const ip = request.headers.get('CF-Connecting-IP') || 'x';
        const now = new Date().toISOString();
        const kIp = `rl:ai:${ip}:${now.slice(0, 13)}`, kDay = `rl:ai:day:${now.slice(0, 10)}`;
        const [nIp, nDay] = await Promise.all([kv.get(kIp), kv.get(kDay)].map(p => p.then(v => Number(v) || 0).catch(() => 0)));
        if (nIp >= 20 || nDay >= 2000) return reply(429, { error: 'too many' });
        ctx.waitUntil(Promise.all([kv.put(kIp, String(nIp + 1), { expirationTtl: 3600 }), kv.put(kDay, String(nDay + 1), { expirationTtl: 86400 })]).catch(() => {}));
      }
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
      const up = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 500, temperature: 0, system, messages: [{ role: 'user', content: text }] }),
      });
      const j = await up.json().catch(() => null);
      if (!up.ok || !j) return reply(502, { error: 'ai error' });
      const out = String((j.content || []).map(c => c.text || '').join(''));
      let parsed = null;
      try { parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch {}
      if (!parsed || typeof parsed !== 'object') return reply(502, { error: 'ai parse', stop: j.stop_reason, raw: out.slice(0, 300) }); // 원인 확인용(AI 답의 앞부분만, 키·사진은 없음)
      // 기록 항목 안의 값만 남긴다
      const w = {}, t = {};
      for (const [k, vals] of Object.entries(parsed.conds || {})) {
        const f = AI_FIELDS[k]; if (!f || !Array.isArray(vals)) continue;
        const ok = [...new Set(vals.map(String).filter(v => f.values.includes(v)))];
        if (ok.length) (f.tag ? t : w)[k] = ok;
      }
      const missing = (Array.isArray(parsed.missing) ? parsed.missing : []).map(s => String(s).slice(0, 12)).slice(0, 3);
      const body = JSON.stringify({ w, t, missing });
      if (kv) ctx.waitUntil(kv.put(cacheKey, body, { expirationTtl: 30 * 86400 }).catch(() => {}));
      return new Response(body, { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': kv ? 'MISS' : 'OFF' } });
    }


    /* 사진으로 항목 채우기 (Anthropic Claude, 이미지). 기록 창에서 이용자가 'AI로 사진 보고 채우기'를 눌렀을 때만 온다.
       사진은 저장하지 않고 바로 넘기며, 눈으로 확인할 수 있는 항목만 고르게 한다. 잰 숫자(단차 cm, 소음 dB)는 고르지 않는다 */
    if (kind === 'photo') {
      if (!env.ANTHROPIC_API_KEY) return reply(503, { error: 'ai off' });
      const imgs = (Array.isArray(input.images) ? input.images : []).slice(0, 3).map(String)
        .filter(s => s.length > 100 && s.length < 1500000 && /^[A-Za-z0-9+/=]+$/.test(s));
      if (!imgs.length) return reply(400, { error: 'no image' });
      const kv = env.ROUTE_CACHE;
      if (kv) { // 비용 보호: 한 접속 주소당 시간마다 10번, 전체 하루 500번까지
        const ip = request.headers.get('CF-Connecting-IP') || 'x';
        const now = new Date().toISOString();
        const kIp = `rl:ph:${ip}:${now.slice(0, 13)}`, kDay = `rl:ph:day:${now.slice(0, 10)}`;
        const [nIp, nDay] = await Promise.all([kv.get(kIp), kv.get(kDay)].map(p => p.then(v => Number(v) || 0).catch(() => 0)));
        if (nIp >= 10 || nDay >= 500) return reply(429, { error: 'too many' });
        ctx.waitUntil(Promise.all([kv.put(kIp, String(nIp + 1), { expirationTtl: 3600 }), kv.put(kDay, String(nDay + 1), { expirationTtl: 86400 })]).catch(() => {}));
      }
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
      const up = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 500, temperature: 0, system, messages: [{ role: 'user', content }] }),
      });
      const j = await up.json().catch(() => null);
      if (!up.ok || !j) return reply(502, { error: 'ai error' });
      const out = String((j.content || []).map(c => c.text || '').join(''));
      let parsed = null;
      try { parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch {}
      if (!parsed || typeof parsed !== 'object') return reply(502, { error: 'ai parse', stop: j.stop_reason, raw: out.slice(0, 300) }); // 원인 확인용(AI 답의 앞부분만, 키·사진은 없음)
      const w = {}, t = {};
      for (const [k, vals] of Object.entries(parsed.conds || {})) {
        const f = PHOTO_FIELDS[k]; if (!f || !Array.isArray(vals)) continue;
        const ok = [...new Set(vals.map(String).filter(v => f.values.includes(v)))];
        if (!ok.length) continue;
        if (f.tag) t[k] = ok; else w[k] = ok[0];
      }
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

    // 같은 구간(약 10m 단위) 요청은 저장해 둔 결과를 준다 (Cloudflare KV, 바인딩 이름 ROUTE_CACHE)
    // 대중교통은 시각에 따라 달라서 같은 10분대만, 도보는 하루 동안 다시 쓴다. 누가 요청했는지는 저장하지 않는다
    const r4 = v => v.toFixed(4);
    const cacheKey = `${kind}:${r4(sx)},${r4(sy)},${r4(ex)},${r4(ey)}` + (kind === 'transit' ? `:${stamp.slice(0, 11)}` : '');
    const kv = env.ROUTE_CACHE;
    const json = (text, state) => new Response(text, { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': state } });
    if (kv) {
      const hit = await kv.get(cacheKey).catch(() => null);
      if (hit) return json(hit, 'HIT');
    }

    const upstream = await fetch(TMAP[kind], {
      method: 'POST',
      headers: { appKey: env.TMAP_APP_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    if (!upstream.ok) return new Response(text, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' } });
    if (kv) ctx.waitUntil(kv.put(cacheKey, text, { expirationTtl: CACHE_SECONDS[kind] }).catch(() => {}));
    return json(text, kv ? 'MISS' : 'OFF');
  },
};
