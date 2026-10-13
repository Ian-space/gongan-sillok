// 엘리베이터 노선도: 수도권 노선별 역 목록(중계 서버 /lines)으로 LOOM 입력 그래프(GeoJSON)를 만든다.
// 역은 점(station_id·station_label), 역과 역 사이는 선(from·to·lines). 여러 노선이 같이 지나는 구간은 한 선에 노선을 모은다.
// 역 사이 연결은 외부코드(FR_CODE) 순서로 잇고, 갈라지는 노선·순환선은 아래 JOIN·CUT으로 바로잡는다.
// GitHub Actions(.github/workflows/linemap.yml)에서 node로 돌린다: node build-graph.mjs > graph.json

export const LINE_INFO = {
  '01호선': ['1호선', '0052A4'], '02호선': ['2호선', '00A84D'], '03호선': ['3호선', 'EF7C1C'], '04호선': ['4호선', '00A5DE'], '05호선': ['5호선', '996CAC'],
  '06호선': ['6호선', 'CD7C2F'], '07호선': ['7호선', '747F00'], '08호선': ['8호선', 'E6186C'], '09호선': ['9호선', 'BDB092'], '경의선': ['경의중앙선', '77C4A3'],
  '경춘선': ['경춘선', '0C8E72'], '수인분당선': ['수인분당선', 'F5A200'], '신분당선': ['신분당선', 'D4003B'], '공항철도': ['공항철도', '0090D2'], '경강선': ['경강선', '0054A6'],
  '서해선': ['서해선', '8FC31F'], 'GTX-A': ['GTX-A', '9A6292'], '신림선': ['신림선', '6789CA'], '우이신설경전철': ['우이신설선', 'B7C452'], '김포도시철도': ['김포골드라인', 'A17800'],
  '용인경전철': ['용인에버라인', '509F22'], '의정부경전철': ['의정부경전철', 'FDA600'], '인천선': ['인천1호선', '7CA8D5'], '인천2호선': ['인천2호선', 'ED8B00'],
};
// 코드 순서만으로는 안 이어지는 곳: [노선, 역, 역]
const JOIN = [
  ['01호선', '구로', '가산디지털단지'],          // 경부선 갈래
  ['02호선', '충정로', '시청'],                  // 순환
  ['05호선', '강동', '둔촌동'],                  // 마천 갈래
  ['06호선', '구산', '응암'], ['06호선', '응암', '새절'], // 응암 순환
  ['경의선', '용산', '효창공원앞'], ['경의선', '효창공원앞', '공덕'],
  ['경의선', '서울', '신촌'], ['경의선', '신촌', '가좌'],
  ['경춘선', '광운대', '상봉'],
];
// 코드 순서로 이어졌지만 실제로는 붙어 있지 않은 곳
const CUT = [
  ['06호선', '구산', '새절'],
  ['경춘선', '광운대', '청량리'],
];

const R = Math.PI / 180;
const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos(37.5 * R)); // km
// 외부코드 → 정렬 열쇠: 글자 머리(묶음), 번호, 갈래 번호('211-1'의 1). 공항철도 'A042'는 A04와 A05 사이(4.2)
function codeKey(fr){
  const m = /^([A-Z]*)(\d+)(?:-(\d+))?$/.exec(fr); if (!m) return null;
  let n = +m[2];
  if (m[1] === 'A' && m[2].length === 3) n = +m[2].slice(0, 2) + +m[2][2] / 10;
  return { head: m[1], n, sub: m[3] ? +m[3] : 0 };
}

export function buildGraph(lines){
  // 역 점: 이름이 같아도 1.5km 넘게 떨어지면 다른 역(서울 양평동 '양평'과 양평군 '양평')
  const nodes = []; const nodeOf = (name, lat, lng) => {
    let v = nodes.find(x => x.name === name && dist(x, { lat, lng }) < 1.5);
    if (!v) { v = { id: `n${nodes.length}`, name, lat, lng }; nodes.push(v); }
    return v;
  };
  const edges = new Map(); // 'a|b' → { from, to, lines: Set }
  const link = (line, a, b) => {
    if (!a || !b || a === b) return;
    const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const e = edges.get(k) || edges.set(k, { from: a.id < b.id ? a : b, to: a.id < b.id ? b : a, lines: new Set() }).get(k);
    e.lines.add(line);
  };
  for (const [line, list] of Object.entries(lines)) {
    if (!LINE_INFO[line]) continue;
    const st = list.map(([name, fr, , lat, lng]) => ({ name, fr, lat, lng, key: codeKey(fr) })).filter(s => s.lat && s.lng && s.key);
    for (const s of st) s.node = nodeOf(s.name, s.lat, s.lng);
    const byName = new Map(st.map(s => [s.name, s]));
    const cut = new Set(CUT.filter(c => c[0] === line).map(c => [c[1], c[2]].sort().join('|')));
    const tryLink = (a, b) => { if (!cut.has([a.name, b.name].sort().join('|')) && dist(a, b) < 16) link(line, a.node, b.node); }; // 16km: 번호가 잘못 붙은 자료만 막는다(외곽은 역 사이가 10km 넘기도 한다)
    // 묶음(글자 머리)마다 본선은 번호 순서로, 갈래('X-n')는 X에서 이어 나간다
    const heads = new Map();
    for (const s of st) (heads.get(s.key.head) || heads.set(s.key.head, []).get(s.key.head)).push(s);
    for (const group of heads.values()) {
      const main = group.filter(s => !s.key.sub).sort((a, b) => a.key.n - b.key.n);
      for (let i = 1; i < main.length; i++) if (main[i].key.n - main[i - 1].key.n <= 2.01) tryLink(main[i - 1], main[i]);
      const subs = group.filter(s => s.key.sub).sort((a, b) => a.key.n - b.key.n || a.key.sub - b.key.sub);
      for (const s of subs) {
        const prev = s.key.sub === 1 ? main.find(m => m.key.n === s.key.n) : subs.find(x => x.key.n === s.key.n && x.key.sub === s.key.sub - 1);
        if (prev) tryLink(prev, s);
      }
    }
    for (const [l, a, b] of JOIN) if (l === line && byName.get(a) && byName.get(b)) link(line, byName.get(a).node, byName.get(b).node);
  }
  const used = new Set([...edges.values()].flatMap(e => [e.from.id, e.to.id]));
  const features = nodes.filter(v => used.has(v.id)).map(v => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
    properties: { id: v.id, station_id: v.id, station_label: v.name } }));
  for (const e of edges.values()) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.from.lng, e.from.lat], [e.to.lng, e.to.lat]] },
    properties: { from: e.from.id, to: e.to.id, lines: [...e.lines].map(l => ({ id: l, label: LINE_INFO[l][0], color: LINE_INFO[l][1] })) } });
  return { type: 'FeatureCollection', features };
}

// node로 직접 돌릴 때: 중계 서버에서 역 목록을 받아 그래프를 표준 출력으로
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('build-graph.mjs')) {
  const r = await fetch('https://gongan-sillok-route.spddlqj20.workers.dev/lines', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ian-space.github.io' }, body: '{}' });
  const j = await r.json();
  if (!j.lines) { console.error('lines 실패', r.status); process.exit(1); }
  process.stdout.write(JSON.stringify(buildGraph(j.lines)));
}
