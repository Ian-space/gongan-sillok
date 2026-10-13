// LOOM octi 결과(octi.json, 경위도 좌표)를 사이트가 바로 그릴 수 있는 작은 파일(linemap.json)로 줄인다.
// 좌표는 가로 약 3000 단위의 평면으로 바꿔 소수 첫째 자리까지. 구간(edge)의 노선 순서는 LOOM이 정한 그대로(나란히 그릴 때 엇갈리지 않게)
// node compact.mjs octi.json > ../../linemap.json
import fs from 'fs';
const g = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pts = g.features.filter(f => f.geometry.type === 'Point' && f.properties.station_label);
const es = g.features.filter(f => f.geometry.type === 'LineString');
const all = [...pts.map(p => p.geometry.coordinates), ...es.flatMap(e => e.geometry.coordinates)];
const minX = Math.min(...all.map(c => c[0])), maxY = Math.max(...all.map(c => c[1]));
const k = Math.cos(37.5 * Math.PI / 180), span = (Math.max(...all.map(c => c[0])) - minX) * k, K = 3000 / span;
const P = ([x, y]) => [+((x - minX) * k * K).toFixed(1), +((maxY - y) * K).toFixed(1)];
const lines = {}, lineIdx = [];
const idx = l => { if (!(l.id in lines)) { lines[l.id] = lineIdx.length; lineIdx.push([l.id, l.label, '#' + l.color]); } return lines[l.id]; };
const out = {
  lines: lineIdx,
  edges: es.map(e => [e.geometry.coordinates.flatMap(P), (e.properties.lines || []).map(idx)]),
  stations: pts.map(p => [p.properties.station_label, ...P(p.geometry.coordinates), +p.properties.deg || 0]),
};
out.lines = lineIdx;
const w = Math.max(...out.stations.map(s => s[1]), ...out.edges.flatMap(e => e[0].filter((_, i) => i % 2 === 0)));
const h = Math.max(...out.stations.map(s => s[2]), ...out.edges.flatMap(e => e[0].filter((_, i) => i % 2 === 1)));
out.size = [Math.ceil(w), Math.ceil(h)];
process.stdout.write(JSON.stringify(out));
