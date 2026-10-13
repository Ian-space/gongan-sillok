// 공간실록 영어 화면. 기기 언어가 한국어가 아니면(또는 ?lang=en, 계정 메뉴의 English) 화면에 보이는 글자만 영어로 바꾼다.
// 저장되는 값(DB의 '턱 없음' 등)과 코드는 그대로 한국어다. 가게 이름·주소처럼 class="notranslate"·translate="no"인 곳은 바꾸지 않는다.
// 번역은 사람이 정한 사전(EN)과 숫자가 들어간 문장 규칙(RULES). 접근성 용어는 휠체어 이용자가 쓰는 표준 표현을 따른다.
// 사전에 없는 한국어는 그대로 두고 window.__gsMissing에 모은다(빠진 번역 찾기용).
(() => {
  'use strict';
  const KEY = 'gongan-sillok:lang';
  let want = '';
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q) { want = q.slice(0, 2).toLowerCase(); localStorage.setItem(KEY, want === 'ko' ? 'ko' : 'en'); }
    else want = localStorage.getItem(KEY) || '';
  } catch {}
  const dev = String(navigator.language || 'ko').slice(0, 2).toLowerCase();
  const lang = want === 'ko' ? 'ko' : want ? 'en' : dev === 'ko' ? 'ko' : 'en';
  window.GS_LANG = lang;
  // 지도 그림 글자: 한국어 화면이면 한국어, 영어 화면이면 기기 언어(일본어·중국어)나 영어
  window.GS_MAP_LANG = lang === 'ko' ? '' : ['ja', 'zh'].includes(want || dev) ? (want || dev) : 'en';
  window.GS_SET_LANG = l => { try { localStorage.setItem(KEY, l); } catch {} const u = new URL(location.href); u.searchParams.delete('lang'); location.replace(u.toString()); };
  if (lang !== 'en') return;
  // 영어 사전(i18n-en.js)은 영어 화면일 때만 받는다. 사전 끝에서 GS_I18N_START()를 부른다
  window.GS_I18N_START = start;
  document.write('<script src="i18n-en.js?v=34"></script>');
  function start(){
  document.documentElement.lang = 'en';

  const EN = window.GS_EN || {};
  const RULES = window.GS_EN_RULES || [];
  const HANGUL = /[가-힣]/;
  const missing = window.__gsMissing = new Set();
  const cache = new Map();
  // 한 덩어리 글자 → 영어. 앞뒤 공백은 지키고, 사전 → 규칙 → ' · '·', '로 나눈 조각 순으로 찾는다
  const tr = s => {
    if (!HANGUL.test(s)) return s;
    if (cache.has(s)) return cache.get(s);
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s), core = m[2];
    let out = EN[core];
    if (out == null) for (const [re, f] of RULES) { const r = re.exec(core); if (r) { out = typeof f === 'function' ? f(r, tr) : core.replace(re, f); break; } }
    if (out == null) for (const sep of [' · ', ' / ', ', ', ' — ']) {
      if (!core.includes(sep)) continue;
      const parts = core.split(sep).map(p => tr(p));
      if (parts.every(p => !HANGUL.test(p))) { out = parts.join(sep); break; }
    }
    // '소음 조용함', '화장실 매장 안'처럼 항목+값: 띄어쓰기로 나눈 두 쪽이 모두 사전에 있으면 '항목: 값'
    if (out == null) for (let i = core.indexOf(' '); i > 0; i = core.indexOf(' ', i + 1)) {
      const a = EN[core.slice(0, i)], b = EN[core.slice(i + 1)];
      if (a != null && b != null) { out = `${a}: ${b}`; break; }
    }
    if (out == null) { missing.add(core); out = core; } else out = m[1] + out + m[3];
    if (cache.size < 5000) { cache.set(s, out); cache.set(out, out); } // 바꾼 글자가 다시 들어와도(속성 변경 등) 그대로
    return out;
  };
  window.GS_TR = tr;
  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  const skip = el => el.closest && el.closest('.notranslate,[translate="no"],script,style,textarea');
  const doAttrs = el => { for (const a of ATTRS) { const v = el.getAttribute(a); if (v && HANGUL.test(v)) { const t = tr(v); if (t !== v) el.setAttribute(a, t); } } };
  const doText = n => { const v = n.nodeValue; if (v && HANGUL.test(v)) { const t = tr(v); if (t !== v) n.nodeValue = t; } };
  const walk = root => {
    if (root.nodeType === 3) { if (!skip(root.parentElement || document.body)) doText(root); return; }
    if (root.nodeType !== 1 || skip(root)) return;
    doAttrs(root);
    if (root.tagName === 'INPUT' && /^(button|submit)$/.test(root.type) && HANGUL.test(root.value)) root.value = tr(root.value);
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeType === 1 && skip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let n = it.nextNode(); n; n = it.nextNode()) n.nodeType === 3 ? doText(n) : doAttrs(n);
  };
  new MutationObserver(list => {
    for (const r of list) {
      if (r.type === 'characterData') { if (!skip(r.target.parentElement || document.body)) doText(r.target); }
      else if (r.type === 'attributes') { if (!skip(r.target)) doAttrs(r.target); }
      else for (const n of r.addedNodes) walk(n);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // 브라우저 창 제목, 알림창(alert·confirm)
  const _alert = window.alert.bind(window), _confirm = window.confirm.bind(window), _prompt = window.prompt.bind(window);
  window.alert = m => _alert(tr(String(m)));
  window.confirm = m => _confirm(tr(String(m)));
  window.prompt = (m, d) => _prompt(tr(String(m)), d);
  if (document.body) walk(document.body);
  document.addEventListener('DOMContentLoaded', () => { document.title = tr(document.title); walk(document.body); });
  }
})();
