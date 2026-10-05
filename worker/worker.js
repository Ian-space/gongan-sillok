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

const ALLOWED_ORIGINS = ['https://ian-space.github.io', 'http://localhost:8765'];
const VERSION = '2026-10-06.1'; // 응답 머리말 X-GS-Version. 자동 배포가 됐는지 확인할 때 본다
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
    if (!TMAP[kind] && kind !== 'search' && kind !== 'nearby' && kind !== 'station') return reply(404, { error: 'unknown path' });

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
