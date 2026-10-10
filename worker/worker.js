// 怨듦컙?ㅻ줉 以묎퀎 ?쒕쾭 (Cloudflare Worker)
// - ?몃? ?쒕퉬????TMAP, 移댁뭅?? Anthropic)瑜??ъ씠??肄붾뱶 ????ш린 鍮꾨? 蹂?섏뿉留??붾떎.
//     TMAP_APP_KEY      : TMAP ?以묎탳?돠룸낫?됱옄 寃쎈줈
//     KAKAO_REST_KEY    : 移댁뭅??濡쒖뺄 ?μ냼 寃??(REST API ??
//     ANTHROPIC_API_KEY : AI 議곌굔 李얘린쨌?ъ쭊 蹂닿퀬 梨꾩슦湲?//     DATA_GO_KR_KEY    : 怨듦났?곗씠?고룷???몄쬆???꾪뙆???⑥? 怨듭떇 ?뺣낫)
// - 寃곌낵 ??? KV 諛붿씤??ROUTE_CACHE. ?잛닔 ?쒗븳: 諛붿씤??LIMIT_ROUTE쨌LIMIT_PLACE (wrangler.toml)
// - 怨듦컙?ㅻ줉 ?ъ씠?몄뿉?????붿껌留?諛쏅뒗?? AI??濡쒓렇?명븳 ?щ엺留?Supabase 濡쒓렇???좏겙???뺤씤?쒕떎).
//
// 寃쎈줈
//   POST /transit  { startX, startY, endX, endY, searchDttm? }  ??TMAP ?以묎탳??//   POST /walk     { startX, startY, endX, endY }               ??TMAP 蹂댄뻾??寃쎈줈
//   POST /search   { query, x?, y?, sort?, page? }              ??移댁뭅???ㅼ썙???μ냼 寃??(x, y媛 ?덉쑝硫?洹?洹쇱쿂遺??
//   POST /station  { x, y }                                     ??1.5km ??吏?섏쿋??(媛源뚯슫 ??
//   POST /addr     { x, y }                                     ??洹??먮━???꾨줈紐낆＜?뙿룰굔臾쇰챸 (移댁뭅??醫뚰몴?믪＜??
//   POST /apt      { bjd: 踰뺤젙??肄붾뱶 10?먮━ }                  ??洹??숇꽕 ?꾪뙆???⑥???怨듭떇 ?대쫫쨌二쇱냼쨌?숈닔쨌?몃???(怨듦났?곗씠?고룷??
//   POST /nearby   { rect: "?쇱そX,?꾨옒Y,?ㅻⅨ履폵,?꼄", code? }      ??吏????移??덉쓽 ?μ냼 (NEARBY???낆쥌 肄붾뱶)
//   POST /intent   { text }                                     ??湲濡??곸? 紐⑹쟻??湲곕줉 ??ぉ 議곌굔?쇰줈 (濡쒓렇???꾩슂)
//   POST /photo    { images: [base64 JPEG, 理쒕? 3?? }          ???ъ쭊?먯꽌 ?덉쑝濡??뺤씤?섎뒗 湲곕줉 ??ぉ ?쒖븞 (濡쒓렇???꾩슂)

const ALLOWED_ORIGINS = ['https://ian-space.github.io', 'http://localhost:8765'];
const VERSION = '2026-10-11.2'; // ?묐떟 癒몃━留?X-GS-Version. ?먮룞 諛고룷媛 ?먮뒗吏 ?뺤씤????蹂몃떎
// 濡쒓렇???뺤씤??Supabase 二쇱냼? 怨듦컻 ???ъ씠??肄붾뱶?먮룄 ?덈뒗 怨듦컻 媛?
const SUPABASE_URL = 'https://qktrghajroxddrbpwtvn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_j-kp8YKsQTczGcsQX74OxA_mfI7DoZw';
// AI ?섎（ ?쒕룄: ???щ엺??/ ?꾩껜. ?섏쑝硫?429? ?④퍡 Cloudflare 濡쒓렇???뚯썝踰덊샇쨌IP瑜??④릿???⑥슜 ?뺤씤??
const AI_LIMITS = { intent: { user: 30, day: 1000 }, photo: { user: 20, day: 200 } };
// 寃쎈줈 寃곌낵 ????쒓컙(珥?
const CACHE_SECONDS = { transit: 600, walk: 86400 };
// 二쇰? ?μ냼 醫낅쪟. 移댁뭅???낆쥌 肄붾뱶濡?李얘퀬, ?낆쥌 遺꾨쪟媛 ?녿뒗 ?꾩꽌愿? 寃?됱뼱濡?李얠? ??遺꾨쪟??'?꾩꽌愿'???덈뒗 怨노쭔 ?④릿??const NEARBY = {
  CS2: { api: 'category', params: { category_group_code: 'CS2' } }, // ?몄쓽??  CE7: { api: 'category', params: { category_group_code: 'CE7' } }, // 移댄럹
  FD6: { api: 'category', params: { category_group_code: 'FD6' } }, // ?뚯떇??  PM9: { api: 'category', params: { category_group_code: 'PM9' } }, // ?쎄뎅
  BK9: { api: 'category', params: { category_group_code: 'BK9' } }, // ???  CT1: { api: 'category', params: { category_group_code: 'CT1' } }, // 臾명솕?쒖꽕
  HP8: { api: 'category', params: { category_group_code: 'HP8' } }, // 蹂묒썝
  AT4: { api: 'category', params: { category_group_code: 'AT4' } }, // 愿愿묐챸??  PO3: { api: 'category', params: { category_group_code: 'PO3' } }, // 怨듦났湲곌?
  MT1: { api: 'category', params: { category_group_code: 'MT1' } }, // ??뺣쭏??  PS3: { api: 'category', params: { category_group_code: 'PS3' } }, // ?대┛?댁쭛쨌?좎튂??  LIB: { api: 'keyword', params: { query: '?꾩꽌愿' }, keep: d => /?꾩꽌愿/.test(d.category_name || '') },
};

// 湲濡??곸? 紐⑹쟻 ??議곌굔(/intent): ?ъ씠?몄쓽 湲곕줉 ??ぉ怨?媛숈븘???쒕떎(index.html ENUMS, TAGS)
const AI_MODEL = 'claude-haiku-4-5-20251001';
const AI_FIELDS = {
  noise:    { label: '?뚯쓬', values: ['議곗슜??, '蹂댄넻', '?쒕걚?ъ?'] },
  spacing:  { label: '醫뚯꽍 媛꾧꺽', values: ['?볦쓬', '蹂댄넻', '醫곸쓬'] },
  light:    { label: '梨꾧킅', values: ['諛앹쓬', '蹂댄넻', '?대몢?'] },
  lamp:     { label: '議곕챸 ??, values: ['?곕쑜??鍮?, '?섏? 鍮?, '?욎뿬 ?덉쓬'] },
  outlet:   { label: '肄섏꽱??, values: ['留롮쓬', '?쇰?', '?놁쓬'] },
  stay:     { label: '癒몃Т瑜닿린', values: ['?μ떆媛?媛??, '2?쒓컙 ?댁쇅', '?뚯쟾 鍮좊쫫'] },
  hood:     { label: '怨좉린 援쎈뒗 怨?諛곌린', values: ['?섑뼢??, '?곹뼢??, '?꾨뱶 ?놁쓬'] },
  entrance: { label: '?낃뎄', values: ['???놁쓬', '寃쎌궗濡??덉쓬', '?굿룰퀎???덉쓬'] },
  floor:    { label: '痢??대룞', values: ['1痢?, '?섎━踰좎씠???덉쓬', '怨꾨떒留?] },
  toilet:   { label: '?붿옣??, values: ['留ㅼ옣 ??, '嫄대Ъ 怨듭슜', '?놁쓬'] },
  kids:     { label: '?꾩씠 ?숇컲', values: ['?좎븘 ?섏옄 ?덉쓬', '?숇컲 媛??, '?명궎利덉〈'] },
  pets:     { label: '諛섎젮?숇Ъ', values: ['?ㅻ궡 媛??, '?쇱쇅留?, '遺덇?'] },
  parking:  { label: '二쇱감', values: ['?꾩슜 二쇱감??, '洹쇱쿂 ?좊즺 二쇱감', '二쇱감 遺덇?'] },
  diaper:   { label: '湲곗?洹 援먰솚?', values: ['留ㅼ옣 ?덉뿉 ?덉쓬', '嫄대Ъ???덉쓬', '?놁쓬'] },
  late:     { label: '?ъ빞 ?곸뾽', values: ['24?쒓컙', '?먯젙 ?섏뼱 ?곸뾽', '?먯젙 ??留덇컧'] },
  furniture:{ label: '醫뚯꽍 醫낅쪟', tag: true, values: ['?깅컺???섏옄', '?ㅽ댋(?깅컺???놁쓬)', '?뚰뙆쨌荑좎뀡', '?믪? 諛?醫뚯꽍', '醫뚯떇', '??怨듭슜 ?뚯씠釉?, '1?몄꽍', '?쇱쇅 ?먮━'] },
  materials:{ label: '?덉뿉 蹂댁씠??留덇컧', tag: true, values: ['?섎Т', '肄섑겕由ы듃', '???, '踰쎈룎', '??, '?좊━', '湲덉냽', '?섏씤??踰?, '?⑤툕由?룹뭅??, '?앸Ъ 留롮쓬'] },
};

// ?ъ쭊?쇰줈 梨꾩슱 ???덈뒗 ??ぉ: ?덉쑝濡??뺤씤?섎뒗 寃껊쭔(?뚯쓬쨌癒몃Т瑜닿린쨌?붿옣?ㅼ쿂???ъ쭊?쇰줈 ?????녿뒗 嫄?類??
const PHOTO_FIELDS = {
  entrance:  { label: '?낃뎄', values: AI_FIELDS.entrance.values, hint: '?낃뎄 ?ъ쭊???뚮쭔. 臾??욎씠??臾몄?諛⑹뿉 ??移몄씠?쇰룄 ?굿룰퀎?⑥씠 蹂댁씠硫??굿룰퀎???덉쓬(?묒? 臾명꽦???ы븿), 寃쎌궗濡쒓? ?덉쑝硫?寃쎌궗濡??덉쓬, 湲멸낵 臾?諛붾떏???됲룊?섍쾶 ?댁뼱吏??뚮쭔 ???놁쓬' },
  floor:     { label: '痢??대룞', values: AI_FIELDS.floor.values, hint: '1痢?留ㅼ옣?닿굅???섎━踰좎씠?걔룰퀎?⑥씠 遺꾨챸???뚮쭔' },
  spacing:   { label: '醫뚯꽍 媛꾧꺽', values: AI_FIELDS.spacing.values, hint: '?볦쓬 1m ?댁긽, 蹂댄넻 50cm~1m, 醫곸쓬 50cm 誘몃쭔' },
  light:     { label: '梨꾧킅', values: AI_FIELDS.light.values, hint: '??뿉 李띿? ?ㅻ궡 ?ъ쭊?먯꽌 遺꾨챸???뚮쭔' },
  lamp:      { label: '議곕챸 ??, values: AI_FIELDS.lamp.values, hint: '耳쒖쭊 議곕챸??鍮??? ?몃?鍮쎛룹＜?⑸튆?대㈃ ?곕쑜??鍮? ?섏?鍮쏆씠硫??섏? 鍮? },
  outlet:    { label: '肄섏꽱??, values: AI_FIELDS.outlet.values, hint: '醫뚯꽍 洹쇱쿂 肄섏꽱?멸? 蹂댁씪 ?뚮쭔(留롮쓬: 醫뚯꽍 ?덈컲 ?댁긽)' },
  hood:      { label: '怨좉린 援쎈뒗 怨?諛곌린', values: AI_FIELDS.hood.values, hint: '遺덊뙋 ?섎젅쨌?꾨옒濡?鍮⑥븘?ㅼ씠硫??섑뼢?? ?뚯씠釉????꾨뱶硫??곹뼢?? },
  kids:      { label: '?꾩씠 ?숇컲', values: ['?좎븘 ?섏옄 ?덉쓬'], hint: '?좎븘 ?섏옄媛 蹂댁씪 ?뚮쭔' },
  furniture: { label: '醫뚯꽍 醫낅쪟', tag: true, values: AI_FIELDS.furniture.values },
  materials: { label: '?덉뿉 蹂댁씠??留덇컧', tag: true, values: AI_FIELDS.materials.values },
};

const TMAP = {
  transit: 'https://apis.openapi.sk.com/transit/routes',
  walk: 'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1&format=json',
};
const PLACE_KINDS = ['search', 'nearby', 'station', 'addr', 'apt'];
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
      if (e instanceof Response) return e; // ?꾩슦誘몃뱾???ㅽ뙣 ?묐떟???섏쭊??      return reply(502, { error: 'upstream error' });
    }
  },
};

const num = v => (typeof v === 'string' || typeof v === 'number') && /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : NaN;
const inKorea = (x, y) => x >= 124 && x <= 132 && y >= 33 && y <= 39;

async function handle(kind, input, { request, env, ctx, send, reply }) {
  const kv = env.ROUTE_CACHE;
  const ip = request.headers.get('CF-Connecting-IP') || 'x';

  // ?몃? ?쒕퉬?ㅻ? 遺瑜닿린 ???잛닔 ?쒗븳(?묒냽 IP蹂?1遺??⑥쐞). ??ν빐 ??寃곌낵瑜?以??뚮뒗 ?몄? ?딅뒗??  const limiter = TMAP[kind] ? env.LIMIT_ROUTE : env.LIMIT_PLACE;
  const allow = async () => {
    if (!limiter) return;
    const { success } = await limiter.limit({ key: ip }).catch(() => ({ success: true }));
    if (!success) { console.log(JSON.stringify({ blocked: kind, ip })); throw reply(429, { error: 'too many' }); }
  };
  // 媛숈? ?붿껌? ??ν빐 ??寃곌낵瑜?二쇨퀬, ?놁쑝硫?make()濡?留뚮뱾??ttl珥???ν븳??  const cached = async (key, ttl, make) => {
    if (kv) { const hit = await kv.get(key).catch(() => null); if (hit) return send(hit, 200, { 'X-Cache': 'HIT' }); }
    await allow();
    const text = await make();
    if (kv) ctx.waitUntil(kv.put(key, text, { expirationTtl: ttl }).catch(() => {}));
    return send(text, 200, { 'X-Cache': kv ? 'MISS' : 'OFF' });
  };
  const kakao = async (path, params) => {
    if (!env.KAKAO_REST_KEY) throw reply(500, { error: 'KAKAO_REST_KEY is not set' });
    const up = await fetch(`https://dapi.kakao.com/v2/local/${path}.json?` + new URLSearchParams(params), { headers: { Authorization: 'KakaoAK ' + env.KAKAO_REST_KEY } });
    const j = await up.json().catch(() => null);
    if (!up.ok || !j) throw reply(up.status === 200 ? 502 : up.status, { error: (j && (j.message || j.msg)) || 'kakao error' });
    return j;
  };
  const xy = () => { const x = num(input.x), y = num(input.y); if (!inKorea(x, y)) throw reply(400, { error: 'coordinates out of range' }); return [x, y]; };

  /* 移댁뭅???μ냼 寃??*/
  if (kind === 'search') {
    const query = String(input.query || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
    if (!query) return reply(400, { error: 'empty query' });
    const params = { query, size: '15' };
    const x = num(input.x), y = num(input.y);
    if (inKorea(x, y)) { Object.assign(params, { x: String(x), y: String(y) }); if (input.sort === 'distance') params.sort = 'distance'; } // 吏??以묒떖 洹쇱쿂 寃곌낵遺??distance硫?媛源뚯슫 ??
    if (/^[1-3]$/.test(String(input.page || ''))) params.page = String(input.page);
    await allow();
    const j = await kakao('search/keyword', params);
    // ?ъ씠?몄뿉 ?꾩슂??移몃쭔 ?섍릿??    return reply(200, { places: (j.documents || []).map(d => ({
      name: d.place_name, category: d.category_name, address: d.road_address_name || d.address_name,
      phone: d.phone, x: d.x, y: d.y, url: d.place_url, distance: d.distance,
    })) });
  }

  /* 醫뚰몴 ??二쇱냼(移댁뭅??: 吏?꾩뿉???꾨Ⅸ ?먮━??嫄대Ъ(?꾨줈紐낆＜?뙿룰굔臾쇰챸). 二쇱냼????諛붾뚯? ?딆븘 ??1m ?⑥쐞濡?30?????*/
  if (kind === 'addr') {
    const [x, y] = xy();
    return cached(`addr3:${x.toFixed(5)},${y.toFixed(5)}`, 30 * 86400, async () => {
      const j = await kakao('geo/coord2address', { x: x.toFixed(6), y: y.toFixed(6) });
      const d = (j.documents || [])[0] || {}, ra = d.road_address || null, ad = d.address || null;
      let building = ra ? ra.building_name || '' : '';
      // ?꾪뙆???⑥???嫄대Ъ紐낆씠 '112??泥섎읆 ??踰덊샇留??⑤떎 ??媛숈? ?꾨줈紐낆＜?뚯쓽 ?꾪뙆?맞룹＜嫄곗떆?ㅼ쓣 李얠븘 ?⑥? ?대쫫??遺숈씤??
      // 二쇱냼媛 媛숈? 怨노쭔 ?대떎(洹쇱쿂 ?ㅻⅨ ?⑥? ?대쫫??鍮뚮씪??遺숈? ?딄쾶). 二쇱냼 ?욎쓽 '?쒖슱'/'?쒖슱?밸퀎?? ?쒓린???щ씪??鍮쇨퀬 鍮꾧탳?쒕떎
      if (ra && ra.address_name && (!building || /^[\dA-Za-z媛-??{0,4}\d+??/.test(building))) {
        const tail = s => String(s || '').trim().split(/\s+/).slice(1).join(' ');
        const kj = await kakao('search/keyword', { query: ra.address_name, x: x.toFixed(6), y: y.toFixed(6), radius: '500', sort: 'distance', size: '5' }).catch(() => null);
        const apt = ((kj && kj.documents) || []).find(p => /?꾪뙆??二쇨굅?쒖꽕|?ㅽ뵾?ㅽ뀛/.test(p.category_name || '') && !/??/.test(p.place_name) && tail(p.road_address_name) === tail(ra.address_name));
        if (apt && !building.includes(apt.place_name)) building = (apt.place_name + ' ' + building).trim();
      }
      return JSON.stringify({ road: ra ? ra.address_name : '', building, jibun: ad ? ad.address_name : '',
        roadName: ra ? ra.road_name : '', mainNo: ra ? ra.main_building_no : '', subNo: ra ? ra.sub_building_no : '' });
    });
  }

  /* 媛源뚯슫 吏?섏쿋?? 移댁뭅???낆쥌 寃??SW8)?쇰줈 1.5km ?덉쓽 ??쓣 媛源뚯슫 ?쒖쑝濡? ??? ??諛붾뚯? ?딆븘 ??100m ?⑥쐞濡?30?????*/
  if (kind === 'station') {
    const [x, y] = xy();
    return cached(`station:${x.toFixed(3)},${y.toFixed(3)}`, 30 * 86400, async () => {
      const j = await kakao('search/category', { category_group_code: 'SW8', x: x.toFixed(4), y: y.toFixed(4), radius: '1500', sort: 'distance', size: '5' });
      return JSON.stringify({ stations: (j.documents || []).map(d => ({ name: d.place_name, line: String(d.category_name || '').split('>').pop().trim(), x: d.x, y: d.y })) });
    });
  }

  /* ?꾪뙆???⑥? 怨듭떇 ?뺣낫(怨듦났?곗씠?고룷?? 援?넗援먰넻遺 怨듬룞二쇳깮 ?⑥? 紐⑸줉쨌湲곕낯 ?뺣낫 = K-apt): 踰뺤젙???섎굹???⑥???     ??{ apts: [{ code, name, addr, road, dongs, units, year }] }. ?ъ씠?멸? ?꾨Ⅸ ?꾩???吏踰댟룹씠由꾩쑝濡?留욌뒗 ?⑥?瑜?怨좊Ⅸ??
     ?⑥? 紐⑸줉? ??諛붾뚯? ?딆븘 踰뺤젙?숇쭏??30????? 湲곕낯 ?뺣낫???⑥?留덈떎 ?곕줈 ??ν빐?? ?⑥?媛 留롮? ?숇꽕??紐?踰덉뿉 ?섎닠 梨꾩슫??*/
  if (kind === 'apt') {
    const bjd = String(input.bjd || '');
    if (!/^\d{10}$/.test(bjd)) return reply(400, { error: 'bad bjd' });
    if (!env.DATA_GO_KR_KEY) return reply(503, { error: 'apt off' });
    const hit = kv && await kv.get(`apt1:${bjd}`).catch(() => null);
    if (hit) return send(hit, 200, { 'X-Cache': 'HIT' });
    await allow();
    const key = /%[0-9A-Fa-f]{2}/.test(env.DATA_GO_KR_KEY) ? decodeURIComponent(env.DATA_GO_KR_KEY) : env.DATA_GO_KR_KEY; // ?몄퐫?⑸맂 ?ㅻ? ?ｌ뿀?대룄
    const gov = async (path, params) => {
      const up = await fetch(`https://apis.data.go.kr/1613000/${path}?` + new URLSearchParams({ serviceKey: key, _type: 'json', ...params }), { signal: AbortSignal.timeout(6000) }); // 怨듦났?곗씠?고룷?몄? 紐곕━硫?媛??硫덉텣??      const raw = await up.text().catch(() => ''); let j = null; try { j = JSON.parse(raw); } catch {}
      const body = j && j.response && j.response.body;
      const err = (j && ((j.response && j.response.header && j.response.header.resultCode) || (j.OpenAPI_ServiceResponse && j.OpenAPI_ServiceResponse.cmmMsgHeader && j.OpenAPI_ServiceResponse.cmmMsgHeader.errMsg))) || (/<errMsg>([A-Z_]+)/.exec(raw) || [])[1];
      if (!body) { console.log(JSON.stringify({ apt: path, err, status: up.status })); throw reply(502, { error: 'apt upstream', code: err || up.status }); } // 22쨌LIMITED_?? ?섎（ ?쒕룄
      return body;
    };
    const arr = v => !v ? [] : Array.isArray(v) ? v : [v];
    const listBody = await gov('AptListService4/getLegaldongAptList4', { bjdCode: bjd, pageNo: '1', numOfRows: '200' });
    const list = arr(listBody.items && (listBody.items.item || listBody.items));
    let full = true;
    const apts = [];
    for (const it of list.slice(0, 120)) {
      const code = String(it.kaptCode || '');
      if (!/^[A-Z0-9]{5,12}$/.test(code)) continue;
      let info = kv && await kv.get(`aptb1:${code}`).catch(() => null);
      if (!info && apts.filter(a => a.fresh).length < 40) { // ??踰덉뿉 ?몃? ?붿껌 40踰덇퉴吏(Cloudflare 臾대즺 ?쒕룄 50踰?
        const b = await gov('AptBasisInfoServiceV5/getAphusBassInfoV5', { kaptCode: code }).catch(() => null);
        const d = b && (b.item || (b.items && (b.items.item || b.items)));
        const x = Array.isArray(d) ? d[0] : d;
        if (x) {
          info = JSON.stringify({ code, name: String(x.kaptName || it.kaptName || ''), addr: String(x.kaptAddr || ''), road: String(x.doroJuso || ''),
            dongs: +x.kaptDongCnt || 0, units: +x.kaptdaCnt || +x.hoCnt || 0, year: /^\d{8}$/.test(String(x.kaptUsedate || '')) ? String(x.kaptUsedate).slice(0, 4) : '' });
          if (kv) ctx.waitUntil(kv.put(`aptb1:${code}`, info, { expirationTtl: 30 * 86400 }).catch(() => {}));
          apts.push({ ...JSON.parse(info), fresh: true }); continue;
        }
      }
      if (info) apts.push(JSON.parse(info));
      else { full = false; apts.push({ code, name: String(it.kaptName || ''), addr: '', road: '', dongs: 0, units: 0, year: '' }); }
    }
    const text = JSON.stringify({ apts: apts.map(({ fresh, ...a }) => a), ...(!full && { partial: true }) }); // partial: ?꾩쭅 紐?梨꾩슫 ?⑥?媛 ?덈떎(?ㅼ쓬???댁뼱??
    if (kv && full) ctx.waitUntil(kv.put(`apt1:${bjd}`, text, { expirationTtl: 30 * 86400 }).catch(() => {}));
    return send(text, 200, { 'X-Cache': 'MISS' });
  }

  /* 移댁뭅???낆쥌 寃?? 吏????移??ш컖?? ?덉쓽 ?μ냼. 移댁뭅?ㅻ뒗 ??踰덉뿉 理쒕? 45怨?15怨녹뵫 3履?留?以??
     洹몃낫??留롪퀬 移몄씠 ?꾩쭅 ?щ㈃ { split: true }留??뚮젮以섏꽌, ?ъ씠?멸? 移몄쓣 4?깅텇???ㅼ떆 臾산쾶 ?쒕떎. ?섎（ ?숈븞 ???*/
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

  /* AI (Anthropic Claude): 濡쒓렇?명븳 ?щ엺留? ???щ엺?뮤룹쟾泥??섎（ ?쒕룄 ?덉뿉?? ?꾧? 臾쇱뿀?붿???Anthropic??蹂대궡吏 ?딅뒗??*/
  if (AI_KINDS.includes(kind)) {
    if (!env.ANTHROPIC_API_KEY) return reply(503, { error: 'ai off' });
    const uid = await userOf(request);
    if (!uid) return reply(401, { error: 'login required' });
    // ?섎（ ?쒕룄 ?뺤씤(??ν빐 ??寃곌낵瑜?以??뚮뒗 ?몄? ?딅뒗??
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
      const raw = await up.text().catch(() => ''); let j = null; try { j = JSON.parse(raw); } catch {}
      const body = j && j.response && j.response.body;
      const out = String((j.content || []).map(c => c.text || '').join(''));
      let parsed = null;
      try { parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch {}
      if (!parsed || typeof parsed !== 'object') throw reply(502, { error: 'ai parse', stop: j.stop_reason, raw: out.slice(0, 300) }); // ?먯씤 ?뺤씤??AI ?듭쓽 ?욌?遺꾨쭔, ?ㅒ룹궗吏꾩? ?놁쓬)
      return parsed;
    };
    // 湲곕줉 ??ぉ ?덉쓽 媛믩쭔 ?④릿?? w????媛???ぉ, t???щ윭 媛???ぉ
    const keepFields = (conds, fields) => {
      const w = {}, t = {};
      for (const [k, vals] of Object.entries(conds || {})) {
        const f = fields[k]; if (!f || !Array.isArray(vals)) continue;
        const ok = [...new Set(vals.map(String).filter(v => f.values.includes(v)))];
        if (ok.length) (f.tag ? t : w)[k] = ok;
      }
      return { w, t };
    };

    /* 湲濡??곸? 紐⑹쟻 ??湲곕줉 ??ぉ 議곌굔. 媛숈? 臾몄옣? 30????ν빐 ?ㅼ떆 ?대떎 */
    if (kind === 'intent') {
      const text = String(input.text || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (text.length < 2) return reply(400, { error: 'empty text' });
      const cacheKey = 'intent4:' + text; // 吏?쒕Ц??諛붽씀硫?踰덊샇瑜??щ젮 ?덉쟾 ???寃곌낵瑜??곗? ?딄쾶 ?쒕떎
      if (kv) { const hit = await kv.get(cacheKey).catch(() => null); if (hit) return send(hit, 200, { 'X-Cache': 'HIT' }); }
      await count();
      const list = Object.entries(AI_FIELDS).map(([k, f]) => `${k} (${f.label}): ${f.values.join(' | ')}`).join('\n');
      const system = `?덈뒗 怨듦컙 湲곕줉 吏?꾩쓽 寃???꾩슦誘몃떎. ?댁슜?먭? ?곸? 紐⑹쟻 臾몄옣???꾨옒 湲곕줉 ??ぉ??媛믪쑝濡쒕쭔 諛붽씔??
- 紐⑸줉???녿뒗 ??ぉ?대굹 媛믪? ?덈? 留뚮뱾吏 ?딅뒗?? 媛믪? 湲??洹몃?濡??대떎.
- 臾몄옣?먯꽌 遺꾨챸???쒕윭?섍굅??洹?紐⑹쟻???쇰컲?곸쑝濡?瑗??꾩슂??議곌굔留?怨좊Ⅸ?? ?좊ℓ?섎㈃ 怨좊Ⅴ吏 ?딅뒗??
- ????ぉ?먯꽌 洹?紐⑹쟻??愿쒖갖? 媛믪? 紐⑤몢 怨좊Ⅸ???? ?좎껜?대㈃ entrance??"???놁쓬", "寃쎌궗濡??덉쓬").
- 'kids'???꾩씠쨌?꾧린쨌?좎븘? ?④퍡 媛??뚮쭔 怨좊Ⅸ??遺紐⑤떂쨌?꾨쭏? 媛??寃껋? ?꾩씠 ?숇컲???꾨땲??.
- ??紐⑹쟻??醫뗭? 媛믩쭔 怨좊Ⅴ怨? '蹂댄넻'? 洹?紐⑹쟻??瑗?留욎쓣 ?뚮쭔 怨좊Ⅸ??
- ????ぉ?쇰줈 ?꾪? ?섑??????녿뒗 ?붽뎄留?missing??吏㏃? ?깅쭚濡??곷뒗??理쒕? 3媛?. ?대? 怨좊Ⅸ ??ぉ?쇰줈 ?섑???寃껋? missing???ｌ? ?딅뒗??
??ぉ:
${list}
異쒕젰? JSON ?섎굹留? ?ㅻ챸 ?놁씠: {"conds":{"??ぉ??:["媛?]},"missing":["?깅쭚"]}`;
      const parsed = await askClaude(system, text);
      const { w, t } = keepFields(parsed.conds, AI_FIELDS);
      const missing = (Array.isArray(parsed.missing) ? parsed.missing : []).map(s => String(s).slice(0, 12)).slice(0, 3);
      const body = JSON.stringify({ w, t, missing });
      if (kv) ctx.waitUntil(kv.put(cacheKey, body, { expirationTtl: 30 * 86400 }).catch(() => {}));
      return send(body, 200, { 'X-Cache': kv ? 'MISS' : 'OFF' });
    }

    /* ?ъ쭊?쇰줈 ??ぉ 梨꾩슦湲? ?ъ쭊? ??ν븯吏 ?딄퀬 諛붾줈 ?섍린硫? ?덉쑝濡??뺤씤?????덈뒗 ??ぉ留?怨좊Ⅴ寃??쒕떎.
       ???レ옄(?⑥감 cm, ?뚯쓬 dB)??怨좊Ⅴ吏 ?딅뒗??*/
    const imgs = (Array.isArray(input.images) ? input.images : []).slice(0, 3).map(String)
      .filter(s => s.length > 100 && s.length < 1500000 && /^[A-Za-z0-9+/=]+$/.test(s));
    if (!imgs.length) return reply(400, { error: 'no image' });
    await count();
    const list = Object.entries(PHOTO_FIELDS).map(([k, f]) => `${k} (${f.label}${f.tag ? ', ?щ윭 媛?媛?? : ', ?섎굹留?}): ${f.values.join(' | ')}${f.hint ? ` ??${f.hint}` : ''}`).join('\n');
    const system = `?덈뒗 怨듦컙 湲곕줉 吏?꾩쓽 湲곕줉 ?꾩슦誘몃떎. ?댁슜?먭? 留ㅼ옣?먯꽌 李띿? ?ъ쭊??蹂닿퀬, ?꾨옒 湲곕줉 ??ぉ 以??ъ쭊?먯꽌 ?덉쑝濡?遺꾨챸???뺤씤?섎뒗 寃껊쭔 怨좊Ⅸ??
- 紐⑸줉???녿뒗 ??ぉ?대굹 媛믪? 留뚮뱾吏 ?딅뒗?? 媛믪? 湲??洹몃?濡??대떎.
- ?ъ쭊??蹂댁씠吏 ?딄굅???좊ℓ?섎㈃ 洹???ぉ? 怨좊Ⅴ吏 ?딅뒗?? 異붿륫?섏? ?딅뒗?? ?곴쾶 怨좊Ⅴ???몄씠 ?ル떎.
- '?섎굹留? ??ぉ? 媛??섎굹, '?щ윭 媛?媛?? ??ぉ? 遺꾨챸??蹂댁씠??寃껋쓣 紐⑤몢.
- floor(痢??대룞)???섎━踰좎씠?걔룰퀎?㉱룰굔臾?諛붽묑???ъ쭊??吏곸젒 蹂댁씪 ?뚮쭔 怨좊Ⅸ?? ?ㅻ궡 ?ъ쭊留뚯쑝濡쒕뒗 怨좊Ⅴ吏 ?딅뒗??
- materials(留덇컧)??諛붾떏쨌踰승룹쿇?μ쿂???볤쾶 蹂댁씠???щ즺留? 議곕챸쨌?뚰뭹???щ즺???ｌ? ?딅뒗?? '?앸Ъ 留롮쓬'? ?앸Ъ??怨듦컙??梨꾩슱 留뚰겮 留롮쓣 ?뚮쭔.
- furniture(醫뚯꽍 醫낅쪟)?먯꽌 '1?몄꽍'? ?쇱옄 ?됰뒗 ?먮━媛 ?곕줈 以꾩????덉쓣 ?뚮쭔, '??怨듭슜 ?뚯씠釉?? ?щ윭 紐낆씠 ?④퍡 ?됰뒗 湲??뚯씠釉붿씠 蹂댁씠硫?怨좊Ⅸ??
??ぉ:
${list}
異쒕젰? JSON ?섎굹留? ?ㅻ챸 ?놁씠: {"conds":{"??ぉ??:["媛?]}}`;
    const content = [...imgs.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })), { type: 'text', text: '???ъ쭊?ㅼ뿉???뺤씤?섎뒗 ??ぉ??怨⑤씪 以?' }];
    const { w, t } = keepFields((await askClaude(system, content)).conds, PHOTO_FIELDS);
    for (const k of Object.keys(w)) w[k] = w[k][0]; // ?ъ쭊? ??媛???ぉ留덈떎 媛??섎굹
    return reply(200, { w, t });
  }

  /* TMAP 寃쎈줈: 援?궡 醫뚰몴留? ?뺥빐吏?移몃쭔 ?섍릿??*/
  if (!env.TMAP_APP_KEY) return reply(500, { error: 'TMAP_APP_KEY is not set' });
  const sx = num(input.startX), sy = num(input.startY), ex = num(input.endX), ey = num(input.endY);
  if (!inKorea(sx, sy) || !inKorea(ex, ey)) return reply(400, { error: 'coordinates out of range' });
  const stamp = /^\d{12}$/.test(String(input.searchDttm || '')) ? String(input.searchDttm) : '';
  const body = kind === 'transit'
    ? { startX: String(sx), startY: String(sy), endX: String(ex), endY: String(ey), lang: 0, format: 'json', count: 10, ...(stamp && { searchDttm: stamp }) }
    : { startX: String(sx), startY: String(sy), endX: String(ex), endY: String(ey), startName: encodeURIComponent('異쒕컻'), endName: encodeURIComponent('?꾩갑') };
  // 媛숈? 援ш컙(??10m ?⑥쐞) ?붿껌? ??ν빐 ??寃곌낵瑜?以?? ?以묎탳?듭? 媛숈? 10遺꾨?留? ?꾨낫???섎（ ?숈븞. ?꾧? ?붿껌?덈뒗吏????ν븯吏 ?딅뒗??  const r4 = v => v.toFixed(4);
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

// Supabase 濡쒓렇???좏겙 ???뚯썝踰덊샇. ?좏겙???녾굅???由щ㈃ null
async function userOf(request) {
  const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + m[1] } }).catch(() => null);
  if (!r || !r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && typeof u.id === 'string' ? u.id : null;
}
