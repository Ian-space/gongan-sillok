// 공간실록 중계 서버 (Cloudflare Worker)
// - 외부 서비스 키(TMAP, 카카오)를 사이트 코드 대신 여기 비밀 변수에만 둔다.
//     TMAP_APP_KEY   : TMAP 대중교통·보행자 경로
//     KAKAO_REST_KEY : 카카오 로컬 장소 검색 (REST API 키)
// - 공간실록 사이트에서 온 요청만 받는다.
//
// 경로
//   POST /transit  { startX, startY, endX, endY, searchDttm? }  → TMAP 대중교통
//   POST /walk     { startX, startY, endX, endY }               → TMAP 보행자 경로
//   POST /search   { query, x?, y? }                            → 카카오 키워드 장소 검색 (x, y가 있으면 그 근처부터)

const ALLOWED_ORIGINS = ['https://ian-space.github.io', 'http://localhost:8765'];
const CACHE_SECONDS = 600; // 사용자 지정 도메인에서만 동작한다(workers.dev 주소에서는 저장되지 않음)

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
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return reply(403, { error: 'forbidden origin' });
    if (request.method !== 'POST') return reply(405, { error: 'POST only' });

    const kind = new URL(request.url).pathname.replace(/^\/+/, '');
    if (!TMAP[kind] && kind !== 'search') return reply(404, { error: 'unknown path' });

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

    /* TMAP 경로: 국내 좌표만, 정해진 칸만 넘긴다 */
    if (!env.TMAP_APP_KEY) return reply(500, { error: 'TMAP_APP_KEY is not set' });
    const sx = num(input.startX), sy = num(input.startY), ex = num(input.endX), ey = num(input.endY);
    if (!inKorea(sx, sy) || !inKorea(ex, ey)) return reply(400, { error: 'coordinates out of range' });
    const stamp = /^\d{12}$/.test(String(input.searchDttm || '')) ? String(input.searchDttm) : '';

    const body = kind === 'transit'
      ? { startX: String(sx), startY: String(sy), endX: String(ex), endY: String(ey), lang: 0, format: 'json', count: 10, ...(stamp && { searchDttm: stamp }) }
      : { startX: String(sx), startY: String(sy), endX: String(ex), endY: String(ey), startName: encodeURIComponent('출발'), endName: encodeURIComponent('도착') };

    // 같은 구간(약 10m 단위)·같은 10분대 요청은 저장해 둔 결과를 준다
    const r4 = v => v.toFixed(4);
    const cacheKey = new Request(`https://cache.gongan-sillok/${kind}?${r4(sx)},${r4(sy)},${r4(ex)},${r4(ey)},${stamp.slice(0, 11)}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { status: hit.status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' } });

    const upstream = await fetch(TMAP[kind], {
      method: 'POST',
      headers: { appKey: env.TMAP_APP_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    const res = new Response(text, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' } });
    if (upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, new Response(text, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `max-age=${CACHE_SECONDS}` } })));
    }
    return res;
  },
};
