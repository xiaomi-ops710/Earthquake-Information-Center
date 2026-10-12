/* 地震・津波速報 – P2P地震情報 API クライアント (v2) */
(() => {
'use strict';

const CFG = Object.assign({
  apiBase: 'https://api.p2pquake.net/v2', wsUrl: 'wss://api.p2pquake.net/v2/ws',
  historyLimit: 100, firebase: {}, vapidKey: '', relayUrl: ''
}, self.APP_CONFIG || {});
const G = window.Geo;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 86400e3;
const CACHE_MAX = 400;       // localStorage に保存する最大件数
const MEM_MAX = 3000;        // メモリ上の最大件数（無限スクロールの上限）

/* ---------------- localStorage ---------------- */
const K = { events: 'eqm.events.v1', tsunami: 'eqm.tsunami.v1', settings: 'eqm.settings.v1', seen: 'eqm.seen.v1' };
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

/* ---------------- 設定 ---------------- */
const defaults = {
  notify: true, sound: true, speak: false, wake: false, shake: true,
  fullAlert: true, kiosk: false, kioskDim: false,
  nation: true, minScale: 30,
  region: { on: false, pref: 0, min: 30 },
  home: null,                                  // {lat, lon, pref(code), prefName, label, approx, at}
  filter: { scale: 'all', mag: 0, period: 'all', from: '', to: '', home: false },
  theme: { mode: 'auto', hue: 38 },
  push: false, pushToken: null, pushSub: null
};
const saved = load(K.settings, {});
const settings = {
  ...defaults, ...saved,
  region: { ...defaults.region, ...(saved.region || {}) },
  theme: { ...defaults.theme, ...(saved.theme || {}) },
  filter: { ...defaults.filter, ...(typeof saved.filter === 'object' ? saved.filter : (saved.filter ? { scale: saved.filter } : {})) }
};
const saveSettings = () => save(K.settings, settings);

/* ---------------- 状態 ---------------- */
const state = {
  events: load(K.events, []), tsunami: load(K.tsunami, null), eew: null,
  selected: null, newIds: new Set(), unread: 0, status: 'connecting', kiosk: false,
  q: '', renderLimit: 100, offset: 0, initialDone: false, histEnd: false, loading: false, filtered: []
};
const seenIds = new Set(load(K.seen, []));

/* ---------------- テーマ ---------------- */
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = settings.theme;
  const dark = t.mode === 'dark' || (t.mode === 'auto' && darkMQ.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.setProperty('--h', t.hue);
  const meta = $('meta[name="theme-color"]'); if (meta) meta.content = dark ? '#1b1716' : '#fbf8f7';
}
darkMQ.addEventListener && darkMQ.addEventListener('change', applyTheme);

/* ---------------- 震度表現 ---------------- */
const SCALE = {
  10: ['1', '#9fb6d6', '#0b1a2e'], 20: ['2', '#62a8f0', '#031a30'], 30: ['3', '#62d68f', '#05210f'],
  40: ['4', '#f4d94e', '#2a2200'], 45: ['5弱', '#ffab4d', '#331a00'], 46: ['5弱<small>以上</small>', '#ffab4d', '#331a00'],
  50: ['5強', '#ff7a3d', '#330d00'], 55: ['6弱', '#ff4d55', '#ffffff'], 60: ['6強', '#d6246e', '#ffffff'], 70: ['7', '#a24dff', '#ffffff']
};
const SPOKEN = { 1: '1', 2: '2', 3: '3', 4: '4', '5弱': '5じゃく', '5強': '5きょう', '6弱': 'ろくじゃく', '6強': 'ろっきょう', 7: 'なな' };
const scaleInfo = (v, foreign) => {
  const s = SCALE[v];
  if (s) return { t: s[0], bg: s[1], fg: s[2], plain: s[0].replace(/<[^>]+>/g, '') };
  return { t: foreign ? '遠地' : '—', bg: '#6b5e59', fg: '#f1dfd9', plain: foreign ? '遠地' : '不明' };
};
const TSU_LABEL = {
  None: ['津波の心配なし', 'ok'], Unknown: ['津波情報なし', 'ok'], Checking: ['津波の有無を調査中', 'watch'],
  NonEffective: ['若干の海面変動（被害の心配なし）', 'ok'], Watch: ['津波注意報を発表中', 'watch'], Warning: ['津波予報・警報を発表中', 'warn']
};
const GRADE = {
  MajorWarning: { label: '大津波警報', cls: 'alert--major', rank: 4 }, Warning: { label: '津波警報', cls: '', rank: 3 },
  Watch: { label: '津波注意報', cls: 'alert--watch', rank: 2 }, Unknown: { label: '津波予報', cls: 'alert--watch', rank: 1 }
};
const TYPE_LABEL = {
  ScalePrompt: '震度速報', Destination: '震源に関する情報', ScaleAndDestination: '震源・震度に関する情報',
  DetailScale: '各地の震度に関する情報', Foreign: '遠地地震に関する情報', Other: 'その他の情報'
};
const impactKm = (mag) => (mag >= 0 ? Math.pow(10, 0.3 * mag + 0.58) : 0);   // 有感範囲の目安（経験式の概算）

/* ---------------- 時刻 ---------------- */
function parseJst(s) {
  const m = String(s || '').match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0)) : NaN;
}
const fmtMD = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtHM = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtFull = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtFullSec = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function rel(ms) {
  const d = Math.max(0, Date.now() - ms) / 1000;
  if (d < 60) return 'たった今'; if (d < 3600) return `${Math.floor(d / 60)}分前`;
  if (d < 86400) return `${Math.floor(d / 3600)}時間前`; return `${Math.floor(d / 86400)}日前`;
}
const depthText = (d, short) => d === 0 ? 'ごく浅い' : d > 0 ? `深さ${d}km` : (short ? '深さ不明' : '不明');

/* ---------------- 正規化 / マージ ---------------- */
const validCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat > -90 && lat < 90 && lon > -180 && lon < 180 && !(lat === 0 && lon === 0);
function normQuake(m) {
  const e = m.earthquake || {}, h = e.hypocenter || {};
  const lat = Number(h.latitude), lon = Number(h.longitude), ok = validCoord(lat, lon);
  const t = parseJst(e.time), it = parseJst((m.issue && m.issue.time) || m.time);
  return {
    id: m.id, ids: [m.id], key: String(e.time || '').slice(0, 16),
    t: Number.isFinite(t) ? t : it, it: Number.isFinite(it) ? it : t,
    name: h.name || '', lat: ok ? lat : null, lon: ok ? lon : null,
    depth: Number.isFinite(h.depth) ? h.depth : -1, mag: Number.isFinite(h.magnitude) ? h.magnitude : -1,
    scale: Number.isFinite(e.maxScale) ? e.maxScale : -1, tsu: e.domesticTsunami || 'Unknown',
    type: (m.issue && m.issue.type) || 'Other', src: (m.issue && m.issue.source) || '',
    cm: (m.comments && m.comments.freeFormComment) || '',
    pts: Array.isArray(m.points) && m.points.length ? m.points.map(p => [p.pref || '', p.addr || '', p.scale]) : null
  };
}
function mergeInto(list, n) {
  const i = list.findIndex(a => Math.abs(a.t - n.t) < 60000 && (!a.name || !n.name || a.name === n.name));
  if (i < 0) { list.push(n); return { ev: n, before: null, created: true, scaleUp: false }; }
  const a = list[i];
  if (a.ids.includes(n.id)) return { ev: a, before: a, created: false, scaleUp: false };
  const [base, other] = n.it >= a.it ? [n, a] : [a, n];
  const merged = {
    ...other, ...base, ids: [...new Set([...a.ids, ...n.ids])], name: base.name || other.name,
    lat: base.lat ?? other.lat, lon: base.lon ?? other.lon,
    depth: base.depth >= 0 ? base.depth : other.depth, mag: base.mag >= 0 ? base.mag : other.mag,
    scale: Math.max(a.scale, n.scale), pts: base.pts || other.pts, cm: base.cm || other.cm, src: base.src || other.src, t: a.t
  };
  merged.t = base.name ? base.t : other.name ? other.t : a.t;
  list[i] = merged;
  return { ev: merged, before: a, created: false, scaleUp: n.scale > a.scale, filled: !a.name && !!merged.name };
}
function persist() {
  state.events.sort((a, b) => b.t - a.t);
  if (state.events.length > MEM_MAX) state.events.length = MEM_MAX;
  const slim = state.events.slice(0, CACHE_MAX).map((e, i) => (i < 30 ? e : { ...e, pts: null, cm: '' }));
  if (!save(K.events, slim)) save(K.events, slim.slice(0, 100).map(e => ({ ...e, pts: null, cm: '' })));
  save(K.tsunami, state.tsunami);
  save(K.seen, [...seenIds].slice(-600));
}

/* ---------------- 地域・現在地 ---------------- */
function prefMap(ev) {
  const m = new Map();
  (ev.pts || []).forEach(([pref, , sc]) => { if (pref && (m.get(pref) || 0) < sc) m.set(pref, sc); });
  return m;
}
const homeName = () => (settings.home && settings.home.prefName) || '';
const homeScale = (ev) => (homeName() ? (prefMap(ev).get(homeName()) || 0) : 0);
const homeDist = (ev) => (settings.home && ev.lat != null ? G.haversine(settings.home.lat, settings.home.lon, ev.lat, ev.lon) : null);
const regionPrefName = () => { const p = G.byCode.get(settings.region.pref); return p ? p[1] : ''; };

/* ---------------- フィルタ ---------------- */
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();
const PERIOD_MS = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
function matches(ev) {
  const f = settings.filter;
  if (f.scale === 's3' && ev.scale < 30) return false;
  if (f.scale === 's5' && ev.scale < 45) return false;
  if (f.mag > 0 && ev.mag < f.mag) return false;
  if (PERIOD_MS[f.period] && ev.t < Date.now() - PERIOD_MS[f.period]) return false;
  if (f.from) { const a = Date.parse(f.from + 'T00:00:00+09:00'); if (Number.isFinite(a) && ev.t < a) return false; }
  if (f.to) { const b = Date.parse(f.to + 'T00:00:00+09:00') + DAY; if (Number.isFinite(b) && ev.t >= b) return false; }
  if (f.home && !homeScale(ev)) return false;
  if (state.q) {
    const q = norm(state.q);
    if (!(norm(ev.name).includes(q) || (ev.pts || []).some(p => norm(p[0]).includes(q) || norm(p[1]).includes(q)))) return false;
  }
  return true;
}
const activeFilters = () => {
  const f = settings.filter;
  return (f.scale !== 'all') + (f.mag > 0) + (f.period !== 'all') + (!!(f.from || f.to)) + !!f.home;
};
const oldestT = () => (state.events.length ? Math.min(...state.events.map(e => e.t)) : Date.now());

/* ---------------- 地図 ---------------- */
let map = null, layer = null, impactLayer = null, waveLayer = null, homeMarker = null, shakeLayer = null;
const markers = new Map();
const JP_BOUNDS = [[24, 122], [46, 148]];
function initMap() {
  if (!window.L) { $('#map').innerHTML = '<p class="empty">地図ライブラリを読み込めませんでした。オンラインで一度開くとオフラインでも表示されます。</p>'; return; }
  map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true, minZoom: 3, maxZoom: 16 });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    minZoom: 3, maxZoom: 18, maxNativeZoom: 18,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>'
  }).addTo(map);
  impactLayer = L.layerGroup().addTo(map);
  waveLayer = L.layerGroup().addTo(map);
  shakeLayer = L.layerGroup().addTo(map);
  layer = L.layerGroup().addTo(map);
  map.fitBounds(JP_BOUNDS, { padding: [10, 10] });
  new ResizeObserver(() => map.invalidateSize()).observe($('#mapPane'));
  renderHomeMarker();
}
function markerIcon(ev, pulse) {
  const si = scaleInfo(ev.scale, ev.type === 'Foreign');
  const size = Math.round(Math.min(56, 26 + Math.max(0, ev.mag) * 3.4));
  const sel = state.selected === ev.id ? ' sel' : '';
  return L.divIcon({
    className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    html: `<div class="qm${pulse ? ' pulse' : ''}${sel}" style="--s:${size}px;--c:${si.bg};--fg:${si.fg}"><b>${esc(SCALE[ev.scale] ? si.plain.slice(0, 2) : '')}</b></div>`
  });
}
const latestId = () => (state.events[0] && state.events[0].id);
const mapEvents = () => (pb.on ? pb.visible : state.events.filter(matches).slice(0, 300));
function renderMarkers(pulseId) {
  if (!map) return;
  layer.clearLayers(); markers.clear();
  [...mapEvents()].reverse().forEach(ev => {
    if (ev.lat == null) return;
    const pulse = ev.id === pulseId || (!pb.on && ev.id === latestId() && Date.now() - ev.t < 600000);
    const m = L.marker([ev.lat, ev.lon], { icon: markerIcon(ev, pulse), keyboard: false, zIndexOffset: Math.max(0, ev.scale) * 10 });
    m.on('click', () => select(ev.id, { fly: false, scrollList: true }));
    m.addTo(layer); markers.set(ev.id, m);
  });
}
function renderHomeMarker() {
  if (!map) return;
  if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
  const h = settings.home; if (!h) return;
  homeMarker = L.marker([h.lat, h.lon], { icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="home-dot"></div>' }), interactive: false, keyboard: false, zIndexOffset: -100 }).addTo(map);
}
function showImpact(ev) {
  if (!map) return; impactLayer.clearLayers();
  if (ev && ev.lat != null && ev.mag >= 0) {
    L.circle([ev.lat, ev.lon], { radius: impactKm(ev.mag) * 1000, color: '#ff9a6b', weight: 1.5, dashArray: '5 7', fillColor: '#ff9a6b', fillOpacity: 0.07, interactive: false }).addTo(impactLayer);
  }
}

/* 地震波（P波・S波）の伝わりを円で表示 */
const VP = 6.0, VS = 3.5;      // km/s（概算値）
let waves = null;
function stopWaves() { if (waves) { cancelAnimationFrame(waves.raf); waves = null; } if (waveLayer) waveLayer.clearLayers(); }
function startWaves({ lat, lon, depth = 10, origin, live = false, speed = 20, maxKm = 600 }) {
  stopWaves(); if (!map) return;
  const p = L.circle([lat, lon], { radius: 1, color: '#6aa8ff', weight: 2, dashArray: '6 6', fill: false, interactive: false }).addTo(waveLayer);
  const s = L.circle([lat, lon], { radius: 1, color: '#ff6b5a', weight: 3, fillColor: '#ff6b5a', fillOpacity: 0.08, interactive: false }).addTo(waveLayer);
  const t0 = performance.now(); let lastDraw = 0;
  const w = waves = { raf: 0 };
  const frame = (now) => {
    if (waves !== w) return;
    if (now - lastDraw > 50) {
      lastDraw = now;
      const el = Math.max(0, live ? (Date.now() - origin) / 1000 : (now - t0) / 1000 * speed);
      const rad = (v) => Math.sqrt(Math.max(0, (v * el) ** 2 - depth * depth)) * 1000;
      p.setRadius(Math.max(1, rad(VP))); s.setRadius(Math.max(1, rad(VS)));
      if (rad(VS) / 1000 > maxKm || el > 900) { setTimeout(() => { if (waves === w) stopWaves(); }, live ? 4000 : 1500); return; }
    }
    w.raf = requestAnimationFrame(frame);
  };
  w.raf = requestAnimationFrame(frame);
}

/* ---------------- 一覧 ---------------- */
function renderList() {
  const sc = $('#scroll'), top = sc.scrollTop;
  state.filtered = state.events.filter(matches);
  const items = state.filtered.slice(0, state.renderLimit);
  $('#empty').hidden = items.length > 0;
  $('#count').textContent = `${state.filtered.length}件${state.histEnd ? '' : '＋'}`;
  const hn = homeName();
  $('#list').innerHTML = items.map(ev => {
    const si = scaleInfo(ev.scale, ev.type === 'Foreign');
    const tl = TSU_LABEL[ev.tsu] || TSU_LABEL.Unknown;
    const tsuTag = tl[1] === 'ok' ? '' : `<span class="tag ${tl[1] === 'watch' ? 'tag--watch' : ''}">${ev.tsu === 'Checking' ? '津波調査中' : ev.tsu === 'Watch' ? '津波注意' : '津波警戒'}</span>`;
    const hs = hn ? homeScale(ev) : 0;
    const homeTag = hs ? `<span class="tag tag--home">あなた 震度${esc(scaleInfo(hs).plain)}</span>` : '';
    const dist = homeDist(ev);
    const title = ev.name || (ev.type === 'ScalePrompt' ? '震度速報（震源調査中）' : '震源調査中');
    const meta = [ev.mag >= 0 ? `M${ev.mag.toFixed(1)}` : 'M不明', depthText(ev.depth, true)].map(esc).join(' · ');
    const isNew = state.newIds.has(ev.id);
    return `<li><button class="item${isNew ? ' enter fresh' : ''}" data-id="${esc(ev.id)}" aria-pressed="${state.selected === ev.id}">
      <span class="badge${si.plain.length > 1 ? ' two' : ''}" style="--c:${si.bg};--fg:${si.fg}"><span>${si.t}</span></span>
      <span class="item__main"><span class="item__title">${esc(title)}</span>
        <span class="item__meta">${meta}${dist != null && dist < 3000 ? ` · <span class="km">約${Math.round(dist)}km</span>` : ''} ${tsuTag}${homeTag}</span></span>
      <span class="item__time"><span>${fmtMD.format(ev.t)}</span><br><span data-rel="${ev.t}">${rel(ev.t)}</span></span>
    </button></li>`;
  }).join('');
  sc.scrollTop = top;
  kioskRender();
  renderMore();
  if (state.newIds.size) setTimeout(() => { state.newIds.clear(); $$('.item.enter').forEach(i => i.classList.remove('enter')); }, 900);
  requestAnimationFrame(checkMore);
}
function renderMore() {
  const el = $('#more');
  if (state.loading) el.textContent = '読み込み中…';
  else if (state.renderLimit < state.filtered.length) el.innerHTML = '<button type="button" data-act="more">さらに表示</button>';
  else if (state.histEnd) el.textContent = '— これ以上古い履歴はありません —';
  else el.innerHTML = '<button type="button" data-act="more">古い履歴を読み込む</button>';
}
function checkMore() {
  const sc = $('#scroll'); if (!sc || sc.offsetParent === null) return;
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 500) onMore();
}
function onMore() {
  if (state.loading) return;
  if (state.renderLimit < state.filtered.length) { state.renderLimit += 100; renderList(); }
  else if (!state.histEnd) loadMore();
}

/* ---------------- 詳細 ---------------- */
function select(id, { fly = true, scrollList = false } = {}) {
  state.selected = id;
  const ev = state.events.find(e => e.id === id);
  if (!ev) { $('#detail').hidden = true; return; }
  renderDetail(ev);
  $$('.item').forEach(i => i.setAttribute('aria-pressed', String(i.dataset.id === id)));
  if (scrollList) { const it = $(`.item[data-id="${CSS.escape(id)}"]`); it && it.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  if (map && ev.lat != null) {
    renderMarkers(); showImpact(ev);
    if (fly) map.flyTo([ev.lat, ev.lon], Math.max(map.getZoom(), 6), { duration: .9 });
  } else showImpact(null);
  if (fly && matchMedia('(max-width: 719px)').matches) setView('map');
}
function closeDetail() {
  state.selected = null; $('#detail').hidden = true; showImpact(null); stopWaves();
  $$('.item').forEach(i => i.setAttribute('aria-pressed', 'false')); renderMarkers();
}
function shareText(ev) {
  const si = scaleInfo(ev.scale, ev.type === 'Foreign');
  return `${fmtFull.format(ev.t)}頃 ${ev.name || '震源調査中'} 最大震度${si.plain}${ev.mag >= 0 ? ` M${ev.mag.toFixed(1)}` : ''} ${depthText(ev.depth, true)}`;
}
function renderDetail(ev) {
  const si = scaleInfo(ev.scale, ev.type === 'Foreign');
  const tl = TSU_LABEL[ev.tsu] || TSU_LABEL.Unknown;
  // 都道府県ごと → 震度ごと
  const prefs = new Map();
  (ev.pts || []).forEach(([pref, addr, sc]) => {
    const key = pref || '（不明）'; const o = prefs.get(key) || { max: 0, n: 0, g: {} };
    o.max = Math.max(o.max, sc); o.n++; (o.g[sc] ||= []).push(addr || pref); prefs.set(key, o);
  });
  const pHtml = [...prefs.entries()].sort((a, b) => b[1].max - a[1].max || b[1].n - a[1].n).map(([name, o], i) => {
    const mx = scaleInfo(o.max);
    const groups = Object.keys(o.g).map(Number).sort((a, b) => b - a).map(sc => {
      const g = scaleInfo(sc);
      return `<div class="grp"><span class="badge" style="--c:${g.bg};--fg:${g.fg}">${g.t}</span><p>${o.g[sc].map(esc).join('、')}</p></div>`;
    }).join('');
    return `<details class="pref"${i < 1 ? ' open' : ''}><summary><span class="badge" style="--c:${mx.bg};--fg:${mx.fg}">${mx.t}</span>${esc(name)}<small>${o.n}地点</small></summary><div class="body">${groups}</div></details>`;
  }).join('');
  const dist = homeDist(ev), hs = homeScale(ev);
  const you = settings.home && (dist != null || hs)
    ? `<div class="you"><b>あなたの場所</b>（${esc(homeName() || '現在地')}）${dist != null ? `： 震央から約<b>${Math.round(dist)}km</b>` : ''}${hs ? ` ／ 同じ都道府県の最大震度 <b>${esc(scaleInfo(hs).plain)}</b>` : ''}${dist != null && ev.mag >= 0 ? (dist <= impactKm(ev.mag) ? ' ／ 有感範囲の目安内' : ' ／ 有感範囲の目安外') : ''}</div>` : '';
  const d = $('#detail'); d.hidden = false;
  d.innerHTML = `
    <div class="detail__top">
      <span class="badge" style="--c:${si.bg};--fg:${si.fg}">${si.t}</span>
      <div><h3>${esc(ev.name || '震源調査中')}</h3><div class="detail__time">${fmtFull.format(ev.t)}頃発生 ・ ${rel(ev.t)}</div></div>
      <button class="x" aria-label="閉じる" data-act="close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>
    </div>
    <div class="facts">
      <div class="fact"><small>マグニチュード</small><b>${ev.mag >= 0 ? ev.mag.toFixed(1) : '—'}</b></div>
      <div class="fact"><small>深さ</small><b>${ev.depth === 0 ? 'ごく浅い' : ev.depth > 0 ? ev.depth + 'km' : '—'}</b></div>
      <div class="fact"><small>最大震度</small><b>${esc(si.plain)}</b></div>
    </div>
    ${you}
    <div class="tsu-line ${tl[1] === 'warn' ? 'warn' : ''}">${esc(tl[0])}</div>
    ${ev.cm ? `<div class="cm">${esc(ev.cm)}</div>` : ''}
    ${pHtml ? `<h4>各地の震度</h4>${pHtml}` : ''}
    <div class="meta">
      <div><span>情報の種類</span><span>${esc(TYPE_LABEL[ev.type] || ev.type)}</span></div>
      <div><span>発表</span><span>${esc(ev.src || '気象庁')} ${ev.it ? fmtFullSec.format(ev.it) : ''}</span></div>
      ${ev.mag >= 0 ? `<div><span>有感範囲の目安</span><span>半径 約${Math.round(impactKm(ev.mag))}km（推定）</span></div>` : ''}
      ${ev.ids.length > 1 ? `<div><span>統合した発表</span><span>${ev.ids.length}件</span></div>` : ''}
    </div>
    <div class="actions">
      ${ev.lat != null ? '<button class="btn btn--tonal btn--sm" data-act="waves" type="button">波の伝わりを再生</button>' : ''}
      <button class="btn btn--outline btn--sm" data-act="share" type="button"><svg viewBox="0 0 24 24"><use href="#i-share"/></svg>共有</button>
      <a class="btn btn--outline btn--sm" href="https://www.jma.go.jp/bosai/map.html#contents=earthquake_map" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><use href="#i-open"/></svg>気象庁</a>
    </div>`;
}
$('#detail').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const ev = state.events.find(x => x.id === state.selected); if (!ev) return;
  if (b.dataset.act === 'close') closeDetail();
  if (b.dataset.act === 'waves' && ev.lat != null) {
    if (map) map.flyTo([ev.lat, ev.lon], Math.max(5, map.getZoom()), { duration: .8 });
    startWaves({ lat: ev.lat, lon: ev.lon, depth: Math.max(ev.depth, 0) || 10, speed: 25, maxKm: Math.max(300, impactKm(ev.mag) * 1.6) });
    if (matchMedia('(max-width: 719px)').matches) setView('map');
  }
  if (b.dataset.act === 'share') {
    const text = shareText(ev);
    try { if (navigator.share) await navigator.share({ title: '地震情報', text, url: location.href.split('#')[0] }); else { await navigator.clipboard.writeText(text); toast('クリップボードにコピーしました'); } } catch { /* cancelled */ }
  }
});

/* ---------------- 津波・EEW バナー ---------------- */
function renderAlerts() {
  const box = $('#alerts'); let html = '';
  const eew = state.eew;
  if (eew) {
    const m = eew.msg, h = (m.earthquake && m.earthquake.hypocenter) || {};
    const areas = [...new Set((m.areas || []).map(a => a.name).filter(Boolean))];
    html += `<div class="alert alert--eew" role="alert"><div class="alert__head"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg>
      <div><div class="alert__title">緊急地震速報（警報）</div><div class="alert__sub">${esc(h.name || '震源調査中')}${h.magnitude > 0 ? ` M${h.magnitude}` : ''} ・ 強い揺れに警戒してください</div></div>
      <button class="alert__close" data-close="eew" aria-label="閉じる"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button></div>
      ${settings.home ? '<div class="cd" id="eewCd"></div>' : '<div class="cd"><span class="lbl">「設定」で現在地を登録すると、S波到達までのカウントダウンを表示します</span></div>'}
      ${areas.length ? `<details><summary>対象地域 ${areas.length}</summary><ul>${areas.slice(0, 40).map(a => `<li>${esc(a)}</li>`).join('')}</ul></details>` : ''}</div>`;
  }
  const ts = state.tsunami;
  if (ts && !ts.cancelled && ts.areas && ts.areas.length) {
    const top = ts.areas.reduce((m, a) => ((GRADE[a.grade]?.rank || 0) > (GRADE[m]?.rank || 0) ? a.grade : m), 'Unknown');
    const g = GRADE[top] || GRADE.Unknown;
    html += `<div class="alert ${g.cls}" role="alert"><div class="alert__head"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg>
      <div><div class="alert__title">${g.label}が発表されています</div><div class="alert__sub">${ts.areas.length}地域 ・ ${fmtHM.format(parseJst(ts.time))}発表 ・ 海岸から離れ高い所へ避難</div></div></div>
      <details><summary>対象地域と予想される津波</summary><ul>${ts.areas.map(a => {
        const gg = GRADE[a.grade] || GRADE.Unknown;
        const eta = a.immediate ? 'ただちに来襲' : a.firstHeight?.arrivalTime ? `第1波 ${esc(String(a.firstHeight.arrivalTime).slice(-8, -3) || a.firstHeight.arrivalTime)}` : (a.firstHeight?.condition || '');
        const h = a.maxHeight?.description || '';
        return `<li>${esc(a.name)}<small>${gg.label}${eta ? ' ・ ' + eta : ''}${h ? ' ・ ' + esc(h) : ''}</small></li>`;
      }).join('')}</ul></details></div>`;
  }
  box.innerHTML = html;
  $$('[data-close="eew"]', box).forEach(b => b.onclick = clearEew);
  const ka = $('#kAlerts'); if (ka) ka.innerHTML = html.replace(/ id="eewCd"/g, '');
  updateCd();
}

/* ---------------- 音・音声・通知 ---------------- */
let audioCtx = null;
function beep(urgent) {
  if (!settings.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const n = urgent ? 6 : 2;
    for (let i = 0; i < n; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = urgent ? (i % 2 ? 1046 : 784) : 880;
      const t0 = audioCtx.currentTime + i * 0.32;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.3);
    }
  } catch { /* noop */ }
}
function speak(text, urgent) {
  if (!settings.speak || !('speechSynthesis' in window)) return;
  try {
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; u.rate = 1.05;
    const v = speechSynthesis.getVoices().find(x => x.lang && x.lang.startsWith('ja')); if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch { /* noop */ }
}
const spokenScale = (v) => SPOKEN[scaleInfo(v).plain] || scaleInfo(v).plain;
let titleTimer = null; const baseTitle = document.title;
function flash(urgent) {
  document.body.classList.remove('flash', 'flash--soft'); void document.body.offsetWidth;
  document.body.classList.add('flash'); if (!urgent) document.body.classList.add('flash--soft');
  setTimeout(() => document.body.classList.remove('flash', 'flash--soft'), urgent ? 4500 : 2400);
  if (document.hidden) {
    clearInterval(titleTimer); let on = false;
    titleTimer = setInterval(() => { document.title = (on = !on) ? '🔴 新着の地震情報' : baseTitle; }, 900);
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearInterval(titleTimer); document.title = baseTitle; state.unread = 0; updateBadge(); } });
function updateBadge() {
  const b = $('#badgeNew'); b.hidden = !state.unread; b.textContent = state.unread;
  try { navigator.setAppBadge && (state.unread ? navigator.setAppBadge(state.unread) : navigator.clearAppBadge()); } catch { /* noop */ }
}
async function notify(title, body, tag, urgent) {
  if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag, renotify: true, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', requireInteraction: !!urgent, data: { url: './' } };
  try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) return reg.showNotification(title, opts); new Notification(title, opts); } catch { /* noop */ }
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3400);
}
const quakeText = (ev) => {
  const si = scaleInfo(ev.scale, ev.type === 'Foreign');
  return {
    title: ev.type === 'Foreign' ? '海外で大きな地震' : `地震 最大震度${si.plain}`,
    body: `${ev.name || '震源調査中'} ${ev.mag >= 0 ? 'M' + ev.mag.toFixed(1) : ''} ${depthText(ev.depth, true)}  ${fmtHM.format(ev.t)}頃発生`.replace(/\s+/g, ' ').trim()
  };
};
/* 通知条件: 全国のしきい値 / 地域別のしきい値 */
function passRules(ev) {
  const r = [];
  if (settings.nation && ev.scale >= settings.minScale) r.push('nation');
  if (settings.region.on) { const n = regionPrefName(); if (n && (prefMap(ev).get(n) || 0) >= settings.region.min) r.push('region'); }
  return r;
}

/* ---------------- メッセージ処理 ---------------- */
function applyQuake(m, { live }) {
  const n = normQuake(m);
  if (!Number.isFinite(n.t)) return;
  const wasSeen = seenIds.has(n.id); seenIds.add(n.id);
  const r = mergeInto(state.events, n);
  if (!live || wasSeen) return;
  if (!(r.created || r.scaleUp || r.filled || (r.ev.pts && !(r.before && r.before.pts)))) return;
  state.newIds.add(r.ev.id); state.unread++; updateBadge();
  const after = passRules(r.ev), before = r.before ? passRules(r.before) : [];
  const fire = after.length > 0 && (r.created || after.some(x => !before.includes(x)) || r.scaleUp);
  const urgent = r.ev.scale >= 55 || r.ev.tsu === 'Warning';
  persist(); renderList(); renderMarkers(r.ev.id);
  if (!fire) { toast(`${r.ev.scale > 0 ? '震度' + scaleInfo(r.ev.scale).plain + ' ' : ''}${r.ev.name || '地震情報'}`); return; }
  flash(urgent); beep(urgent);
  const tx = quakeText(r.ev);
  let title = tx.title, body = tx.body;
  if (after.includes('region') && !after.includes('nation')) { const n2 = regionPrefName(), s2 = prefMap(r.ev).get(n2); title = `${n2}で震度${scaleInfo(s2).plain}`; }
  notify(title, body, 'eq-' + r.ev.key, urgent);
  const hs = homeScale(r.ev);
  if (urgent || homeScale(r.ev) >= 45) {
    const hs0 = homeScale(r.ev), si0 = scaleInfo(r.ev.scale, r.ev.type === 'Foreign');
    showOverlay({ tone: 'eq', kind: '地震情報', title: r.ev.name || '震源調査中', badge: si0,
      sub: `最大震度${si0.plain}${r.ev.mag >= 0 ? ' ・ M' + r.ev.mag.toFixed(1) : ''} ・ ${depthText(r.ev.depth, true)}${hs0 ? ' ・ あなたの地域は震度' + scaleInfo(hs0).plain : ''}${r.ev.tsu === 'Warning' ? ' ・ 津波に警戒' : ''}` });
  }
  speak(`地震情報。${r.ev.name || '震源調査中'}で、最大震度${spokenScale(r.ev.scale)}。${r.ev.mag >= 0 ? 'マグニチュード' + r.ev.mag.toFixed(1) + '。' : ''}${hs ? 'あなたの地域は震度' + spokenScale(hs) + '。' : ''}`, urgent);
  toast(`${title}：${r.ev.name || '震源調査中'}`);
  if (!pb.on) {
    if (map && r.ev.lat != null) map.flyTo([r.ev.lat, r.ev.lon], Math.max(map.getZoom(), 6), { duration: 1.2 });
    select(r.ev.id, { fly: false });
  }
}
function applyTsunami(m, { live }) {
  const prev = state.tsunami, fresh = !prev || prev.id !== m.id;
  const old = Date.now() - parseJst(m.time) > DAY;
  if (m.cancelled || !(m.areas && m.areas.length)) {
    state.tsunami = null; save(K.tsunami, null);
    if (live && fresh && prev) { toast('津波予報が解除されました'); notify('津波予報解除', '津波に関する予報は解除されました', 'tsunami', false); speak('津波予報は解除されました。', false); }
  } else if (!old) {
    state.tsunami = m; save(K.tsunami, m);
    if (live && fresh) {
      const top = m.areas.reduce((x, a) => ((GRADE[a.grade]?.rank || 0) > (GRADE[x]?.rank || 0) ? a.grade : x), 'Unknown');
      const g = GRADE[top] || GRADE.Unknown;
      flash(true); beep(true);
      if (g.rank >= 3) showOverlay({ tone: 'tsu', kind: g.label, title: `${g.label}が発表されました`, sub: `${m.areas.slice(0, 6).map(a => a.name).join('、')}${m.areas.length > 6 ? ' ほか' : ''} ・ ただちに海岸から離れ、高い場所へ避難してください` });
      notify(`${g.label}を発表`, `${m.areas.slice(0, 6).map(a => a.name).join('、')}${m.areas.length > 6 ? ' ほか' : ''}  ただちに海岸から離れてください`, 'tsunami', true);
      speak(`${g.label}が発表されました。${m.areas.slice(0, 4).map(a => a.name).join('、')}。ただちに海岸から離れ、高い場所へ避難してください。`, true);
    }
  }
  renderAlerts();
}

/* 緊急地震速報: S波到達カウントダウン（推定） */
let eewTimer = null, eewTick = null;
function eewCalc(m) {
  const h = m.earthquake && m.earthquake.hypocenter;
  if (!settings.home || !h || !validCoord(Number(h.latitude), Number(h.longitude))) return null;
  const dist = G.haversine(settings.home.lat, settings.home.lon, Number(h.latitude), Number(h.longitude));
  const depth = h.depth > 0 ? h.depth : 10;
  const r = Math.hypot(dist, depth);
  let origin = parseJst(m.earthquake.originTime); if (!Number.isFinite(origin)) origin = parseJst(m.issue && m.issue.time);
  if (!Number.isFinite(origin)) return null;
  return { dist, rem: (origin + r / VS * 1000 - Date.now()) / 1000 };
}
function updateCd() {
  if (!state.eew || !settings.home) return;
  const els = [$('#eewCd'), $('#ovCd'), ...$$('#kAlerts .cd')].filter(Boolean);
  if (!els.length) return;
  const put = (cls, html) => els.forEach(el => { el.className = cls; el.innerHTML = html; });
  const c = eewCalc(state.eew.msg);
  if (!c) { put('cd', '<span class="lbl">震源情報を解析中…</span>'); return; }
  if (c.rem > 0) {
    const sec = Math.ceil(c.rem);
    put('cd', `<span class="lbl">S波（主要動）到達まで</span><span class="num">${sec}</span><span class="lbl">秒</span><small>震源から約${Math.round(c.dist)}km ・ 推定値です（気象庁の予測ではありません）。まず身の安全を確保してください。</small>`);
    const sp = state.eew.spoken;
    [30, 20, 10, 5, 4, 3, 2, 1].forEach(t => { if (sec <= t && !sp.has(t) && sec > t - 1.6) { sp.add(t); if (t <= 10 || t % 10 === 0) speak(String(t), true); } });
  } else {
    put('cd arrived', '<span class="num">すでに到達している可能性があります</span><small>揺れが収まるまで身の安全を確保してください</small>');
  }
}
function clearEew() {
  state.eew = null; clearInterval(eewTick); clearTimeout(eewTimer); stopWaves(); renderAlerts();
  if ($('#overlay').dataset.eew) hideOverlay();
}
function applyEew(m) {
  if (m.test) return;
  const id = (m.issue && m.issue.eventId) || m.id;
  if (m.cancelled) { if (!state.eew || state.eew.id === id) clearEew(); return; }
  const isNew = !state.eew || state.eew.id !== id;
  state.eew = { id, msg: m, spoken: isNew ? new Set() : state.eew.spoken };
  renderAlerts();
  const h = (m.earthquake && m.earthquake.hypocenter) || {};
  if (isNew) {
    flash(true); beep(true);
    showOverlay({ tone: 'eew', eew: true, kind: '緊急地震速報（警報）', title: '強い揺れに警戒してください', sub: `${h.name || '震源調査中'}${h.magnitude > 0 ? ' M' + Number(h.magnitude).toFixed(1) : ''}` });
    notify('緊急地震速報（警報）', `${h.name || '震源調査中'} 強い揺れに警戒してください`, 'eew', true);
    speak('緊急地震速報。強い揺れに警戒してください。', true);
  }
  clearInterval(eewTick); eewTick = setInterval(updateCd, 250);
  clearTimeout(eewTimer); eewTimer = setTimeout(clearEew, 120000);
  const lat = Number(h.latitude), lon = Number(h.longitude);
  if (validCoord(lat, lon) && map) {
    if (isNew) map.flyTo([lat, lon], 6, { duration: 1 });
    let origin = parseJst(m.earthquake.originTime); if (!Number.isFinite(origin)) origin = Date.now();
    startWaves({ lat, lon, depth: h.depth > 0 ? h.depth : 10, origin, live: true, maxKm: 900 });
  }
}

/* ---------------- 全画面警報 ---------------- */
let ovTimer = null;
function showOverlay({ tone = 'eq', kind, title, sub = '', badge = null, eew = false }) {
  if (!settings.fullAlert) return;
  const ov = $('#overlay'); ov.dataset.tone = tone; ov.dataset.eew = eew ? '1' : '';
  $('#ovKind').textContent = kind; $('#ovTitle').textContent = title; $('#ovSub').textContent = sub;
  const b = $('#ovBadge');
  if (badge) { b.hidden = false; b.style.setProperty('--c', badge.bg); b.style.setProperty('--fg', badge.fg); b.innerHTML = `<span>${badge.t}</span>`; } else b.hidden = true;
  $('#ovCd').hidden = !(eew && settings.home);
  ov.hidden = false; clearTimeout(ovTimer); ovTimer = setTimeout(hideOverlay, eew ? 120000 : 60000);
  if (eew) updateCd();
  $('#ovClose').focus({ preventScroll: true });
}
function hideOverlay() { const ov = $('#overlay'); ov.hidden = true; ov.dataset.eew = ''; clearTimeout(ovTimer); }

/* ---------------- 据え置き（常時表示）モード ---------------- */
let kioskClockTimer = null;
const fmtKDate = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'long' });
function kioskClock() {
  if (!state.kiosk) return;
  const now = new Date();
  $('#kTime').textContent = fmtHM.format(now);
  $('#kSec').textContent = String(now.getSeconds()).padStart(2, '0');
  const d = fmtKDate.format(now); if ($('#kDate').textContent !== d) $('#kDate').textContent = d;
}
function kioskRender() {
  if (!state.kiosk) return;
  const list = [...state.events].sort((a, b) => b.t - a.t).slice(0, 8);
  const ev = list[0];
  if (!ev) { $('#kMain').innerHTML = '<div class="k-label">地震情報を待っています…</div>'; $('#kList').innerHTML = ''; return; }
  const si = scaleInfo(ev.scale, ev.type === 'Foreign'), tl = TSU_LABEL[ev.tsu] || TSU_LABEL.Unknown;
  const hs = homeScale(ev), dist = homeDist(ev), fresh = Date.now() - ev.t < 600000;
  $('#kMain').className = 'k-main' + (fresh ? ' fresh' : '');
  $('#kMain').innerHTML = `
    <div class="k-label">最新の地震 ・ <span data-rel="${ev.t}">${rel(ev.t)}</span></div>
    <div class="k-row">
      <span class="badge k-badge${si.plain.length > 1 ? ' two' : ''}" style="--c:${si.bg};--fg:${si.fg}"><span>${si.t}</span></span>
      <div class="k-info">
        <div class="k-name">${esc(ev.name || (ev.type === 'ScalePrompt' ? '震度速報（震源調査中）' : '震源調査中'))}</div>
        <div class="k-meta">${[fmtMD.format(ev.t) + '頃', ev.mag >= 0 ? 'M' + ev.mag.toFixed(1) : 'M不明', depthText(ev.depth, true)].map(x => `<span>${esc(x)}</span>`).join('')}</div>
        ${hs || dist != null ? `<div class="k-you">あなたの地域${hs ? `：震度${esc(scaleInfo(hs).plain)}` : ''}${dist != null && dist < 3000 ? `　震源まで約${Math.round(dist)}km` : ''}</div>` : ''}
        ${tl[1] === 'ok' ? '' : `<div class="k-tsu ${tl[1] === 'warn' ? 'warn' : ''}">${esc(tl[0])}</div>`}
      </div>
    </div>`;
  $('#kList').innerHTML = list.slice(1).map(e => {
    const s = scaleInfo(e.scale, e.type === 'Foreign');
    return `<li><span class="badge${s.plain.length > 1 ? ' two' : ''}" style="--c:${s.bg};--fg:${s.fg}"><span>${s.t}</span></span>
      <span class="k-i"><b>${esc(e.name || '震源調査中')}</b><small>${fmtMD.format(e.t)} ・ ${e.mag >= 0 ? 'M' + e.mag.toFixed(1) : 'M不明'} ・ <span data-rel="${e.t}">${rel(e.t)}</span></small></span></li>`;
  }).join('');
}
function setKiosk(on, { quiet = false } = {}) {
  state.kiosk = on; settings.kiosk = on; saveSettings();
  $('#kiosk').hidden = !on; document.body.classList.toggle('is-kiosk', on);
  document.body.classList.toggle('kiosk-dim', on && settings.kioskDim);
  $('#kDim').setAttribute('aria-pressed', String(settings.kioskDim));
  clearInterval(kioskClockTimer);
  if (on) {
    kioskRender(); kioskClock(); kioskClockTimer = setInterval(kioskClock, 1000);
    wakeLock(); renderAlerts(); shakeSweep();
    if (!quiet) toast('据え置きモード: 画面は点灯したままになります（右上の×で戻る）');
  } else {
    if (!settings.wake && wakeSentinel) wakeSentinel.release().catch(() => {});
    if (map) setTimeout(() => map.invalidateSize(), 80);
  }
}

/* みんなの揺れ感知（P2P 561） */
let areaTable = null, shakeInit = false;
const shake = { log: [], byArea: new Map(), lastHot: new Map() };
function initShake() {
  if (shakeInit || !settings.shake) return; shakeInit = true;
  G.loadAreas().then(t => { areaTable = t; });
  setInterval(shakeSweep, 1000);
}
function applyShake(m) {
  if (!settings.shake || !areaTable || typeof m.area !== 'number') return;
  const a = areaTable.get(m.area); if (!a) return;
  const now = Date.now();
  shake.log.push({ t: now, pref: a.pref });
  let o = shake.byArea.get(m.area);
  if (!o) { o = { a, count: 0, marker: null, last: now }; shake.byArea.set(m.area, o); }
  o.count++; o.last = now;
  if (map) {
    const html = `<div class="sk"><i></i><b>${o.count}</b></div>`;
    const icon = L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html });
    if (!o.marker) o.marker = L.marker([a.lat, a.lon], { icon, interactive: false, keyboard: false, zIndexOffset: -50 }).addTo(shakeLayer);
    else if (!o.dirty) { o.dirty = true; setTimeout(() => { o.dirty = false; o.marker && o.marker.setIcon(L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: `<div class="sk"><i></i><b>${o.count}</b></div>` })); }, 400); }
  }
  shakeSweep(true);
}
function shakeSweep() {
  const now = Date.now(), chip = $('#shakeChip');
  shake.log = shake.log.filter(x => now - x.t < 60000);
  shake.byArea.forEach((o, k) => { if (now - o.last > 25000) { o.marker && shakeLayer.removeLayer(o.marker); shake.byArea.delete(k); } });
  const ks = $('#kShake');
  if (!settings.shake || !shake.log.length) { chip.hidden = true; if (ks) ks.hidden = true; return; }
  const by = new Map(); shake.log.forEach(x => by.set(x.pref, (by.get(x.pref) || 0) + 1));
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const hot = top[0][1] >= 10;
  chip.hidden = false; chip.classList.toggle('hot', hot);
  chip.innerHTML = `<span class="pulse-dot"></span><div><b>揺れを感知 ${shake.log.length}件/分</b><small>${top.map(([p, n]) => `${esc(p)} ${n}`).join(' ・ ')}（P2Pユーザー・参考値）</small></div>`;
  if (ks) { ks.hidden = !state.kiosk; ks.className = 'k-shake' + (hot ? ' hot' : ''); ks.innerHTML = chip.innerHTML; }
  if (hot) {
    const p = top[0][0];
    if (now - (shake.lastHot.get(p) || 0) > 300000) { shake.lastHot.set(p, now); toast(`${p}で揺れの感知が多数報告されています（参考）`); }
  }
}

function handle(m, live) {
  if (!m || typeof m !== 'object') return;
  switch (m.code) {
    case 551: applyQuake(m, { live }); break;
    case 552: applyTsunami(m, { live }); break;
    case 556: if (live) applyEew(m); break;
    case 561: if (live) applyShake(m); break;
    default: break;
  }
}

/* ---------------- REST: 履歴 ---------------- */
async function fetchHistory(silent) {
  try {
    const [qr, tr] = await Promise.all([
      fetch(`${CFG.apiBase}/history?codes=551&limit=100`, { cache: 'no-store' }),
      fetch(`${CFG.apiBase}/history?codes=552&limit=3`, { cache: 'no-store' }).catch(() => null)
    ]);
    if (!qr.ok) throw new Error(qr.status);
    const arr = await qr.json();
    if (tr && tr.ok) { const ta = await tr.json(); if (ta[0]) applyTsunami(ta[0], { live: false }); }
    arr.forEach(m => handle(m, false));
    if (!state.initialDone) { state.initialDone = true; state.offset = arr.length; state.histEnd = arr.length < 100; }
    persist(); renderList(); renderMarkers();
    if (!silent) toast('履歴を更新しました');
    return true;
  } catch (e) {
    if (!silent) toast('履歴を取得できません。キャッシュを表示しています');
    return false;
  }
}
async function loadMore() {
  if (state.loading || state.histEnd) return;
  if (!state.initialDone) { state.loading = true; renderMore(); await fetchHistory(true); state.loading = false; renderList(); return; }
  if (state.events.length >= MEM_MAX) { state.histEnd = true; renderList(); return; }
  state.loading = true; renderMore();
  try {
    const r = await fetch(`${CFG.apiBase}/history?codes=551&limit=100&offset=${state.offset}`);
    if (!r.ok) throw new Error(r.status);
    const arr = await r.json();
    arr.forEach(m => handle(m, false));
    state.offset += arr.length; if (arr.length < 100) state.histEnd = true;
    persist();
  } catch { toast('古い履歴を読み込めません。通信を確認してください'); state.histEndTried = true; }
  state.loading = false;
  renderList(); renderMarkers();
}
async function ensureLoadedUntil(ms, maxPages = 15, onProgress) {
  let pages = 0;
  while (!state.histEnd && oldestT() > ms && pages++ < maxPages) {
    const before = state.offset; await loadMore();
    if (state.offset === before && !state.histEnd) break;   // 失敗時は打ち切り
    onProgress && onProgress();
  }
}

/* ---------------- WebSocket ---------------- */
let ws = null, retry = 0, retryTimer = null, everOpen = false;
function setStatus(s, text) {
  state.status = s; const el = $('#status'); el.dataset.state = s; $('#statusText', el).textContent = text;
  const k = $('#kStatus'); if (k) { k.dataset.state = s; $('.t', k).textContent = text; }
}
function connect() {
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  if (!navigator.onLine) { setStatus('offline', 'オフライン'); return; }
  setStatus('connecting', retry ? '再接続中' : '接続中');
  try { ws = new WebSocket(CFG.wsUrl); } catch { return schedule(); }
  ws.onopen = () => { setStatus('live', 'ライブ'); retry = 0; if (everOpen) fetchHistory(true); everOpen = true; };
  ws.onmessage = (ev) => { try { const d = JSON.parse(ev.data); (Array.isArray(d) ? d : [d]).forEach(m => handle(m, true)); } catch { /* ignore */ } };
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  ws.onclose = () => { setStatus(navigator.onLine ? 'connecting' : 'offline', navigator.onLine ? '再接続中' : 'オフライン'); schedule(); };
}
function schedule() { clearTimeout(retryTimer); retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++) + Math.random() * 500); }
addEventListener('online', () => { retry = 0; connect(); fetchHistory(true); });
addEventListener('offline', () => setStatus('offline', 'オフライン'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!ws || ws.readyState > 1) { retry = 0; connect(); }
  fetchHistory(true); wakeLock();
});
setInterval(() => $$('[data-rel]').forEach(el => { el.textContent = rel(+el.dataset.rel); }), 30000);

/* ---------------- 表示切替 ---------------- */
function setView(v) {
  $('#panes').dataset.view = v;
  $$('.navbar__item').forEach(b => { if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (v === 'list') { state.unread = 0; updateBadge(); requestAnimationFrame(checkMore); }
  if (v === 'map' && map) setTimeout(() => map.invalidateSize(), 50);
}

/* ---------------- 時系列再生 ---------------- */
const pb = { on: false, playing: false, list: [], visible: [], start: 0, end: 0, cur: 0, speed: 1, last: 0, raf: 0, shown: -1 };
function pbOpen() {
  const list = state.events.filter(matches).filter(e => e.lat != null).slice(0, 300).sort((a, b) => a.t - b.t);
  if (list.length < 2) { toast('再生には、位置のわかる地震が2件以上必要です（絞り込み条件を見直してください）'); return; }
  closeDetail();
  Object.assign(pb, { on: true, list, start: list[0].t, end: list[list.length - 1].t, cur: list[0].t, shown: -1 });
  $('#playbar').hidden = false; $('#btnPlay').setAttribute('aria-pressed', 'true');
  pbUpdate(true); pbPlay(true);
}
function pbClose() {
  pbPlay(false); pb.on = false; $('#playbar').hidden = true; $('#btnPlay').setAttribute('aria-pressed', 'false'); renderMarkers();
}
function pbPlay(on) {
  pb.playing = on; cancelAnimationFrame(pb.raf);
  $('#pbToggle').setAttribute('aria-pressed', String(on));
  $('#pbToggle use').setAttribute('href', on ? '#i-pause' : '#i-play');
  if (on) { if (pb.cur >= pb.end) pb.cur = pb.start; pb.last = performance.now(); pb.raf = requestAnimationFrame(pbFrame); }
}
function pbFrame(ts) {
  if (!pb.playing) return;
  const dt = ts - pb.last; pb.last = ts;
  pb.cur += dt * (pb.end - pb.start) / 30000 * pb.speed;
  if (pb.cur >= pb.end) { pb.cur = pb.end; pbUpdate(); pbPlay(false); return; }
  pbUpdate(); pb.raf = requestAnimationFrame(pbFrame);
}
function pbUpdate(force) {
  $('#pbRange').value = Math.round(1000 * (pb.cur - pb.start) / Math.max(1, pb.end - pb.start));
  $('#pbTime').textContent = fmtMD.format(pb.cur);
  let n = 0; while (n < pb.list.length && pb.list[n].t <= pb.cur) n++;
  if (n !== pb.shown || force) {
    pb.shown = n; pb.visible = pb.list.slice(0, n).reverse();   // 新しい順
    $('#pbInfo').textContent = `${n} / ${pb.list.length}件`;
    renderMarkers(pb.visible[0] && pb.visible[0].id);
  }
}

/* ---------------- 現在地 ---------------- */
function setHome(h) {
  settings.home = h; saveSettings(); renderHomeMarker(); renderList(); syncSettingsUI();
  if (state.selected) { const ev = state.events.find(e => e.id === state.selected); ev && renderDetail(ev); }
  renderAlerts();
}
async function locateMe({ fly = true } = {}) {
  if (!navigator.geolocation) { toast('この環境では位置情報を使えません'); return; }
  toast('現在地を取得中…');
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 12000, maximumAge: 600000 }));
    const { latitude: lat, longitude: lon } = pos.coords;
    const info = await G.reversePref(lat, lon);
    if (!settings.region.pref) { settings.region.pref = info.code; }
    setHome({ lat, lon, pref: info.code, prefName: info.name, label: info.label, approx: false, at: Date.now() });
    toast(`現在地: ${info.label}`);
    if (fly && map) map.flyTo([lat, lon], Math.max(map.getZoom(), 8), { duration: 1 });
  } catch (e) {
    toast(e && e.code === 1 ? '位置情報が許可されていません（設定 › プライバシーとセキュリティ › 位置情報サービス）' : '現在地を取得できませんでした');
  }
}
function setHomePref(code) {
  const p = G.byCode.get(code); if (!p) return;
  if (!settings.region.pref) settings.region.pref = code;
  setHome({ lat: p[2], lon: p[3], pref: code, prefName: p[1], label: `${p[1]}（県庁所在地を基準）`, approx: true, at: Date.now() });
}

/* ---------------- 設定 / Push ---------------- */
let wakeSentinel = null;
async function wakeLock() {
  try { if (!(settings.wake || state.kiosk) || !('wakeLock' in navigator) || document.hidden) return; wakeSentinel = await navigator.wakeLock.request('screen'); } catch { /* noop */ }
}
const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
const FB_VER = '10.12.2';
const pushConfigured = () => !!(CFG.firebase.apiKey && CFG.vapidKey && CFG.relayUrl);
async function relay(path, body) {
  const url = CFG.relayUrl.replace(/\/$/, '') + path;
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('中継サーバーがエラーを返しました (' + r.status + ')');
      return r.json().catch(() => ({}));
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      let reachable = false;
      try { await fetch(CFG.relayUrl.replace(/\/$/, '') + '/healthz', { mode: 'no-cors', cache: 'no-store' }); reachable = true; } catch { /* unreachable */ }
      lastErr = new Error(reachable
        ? '中継サーバーは動いていますが拒否されました。RenderのALLOWED_ORIGINが ' + location.origin + ' と一致しているか確認してください'
        : '中継サーバーに届きません。起動中かもしれません。1分ほど待つか、config.jsのrelayUrlを確認してください');
      if (reachable) break;
      if (i < 1) await new Promise(res => setTimeout(res, 6000));
    }
  }
  throw lastErr;
}
const desiredSub = () => ({
  nation: settings.nation ? settings.minScale : null,
  region: settings.region.on && settings.region.pref ? { pref: settings.region.pref, min: settings.region.min } : null
});
async function syncPush() {
  if (!settings.push || !settings.pushToken) return;
  const d = desiredSub();
  await relay('/subscribe', { token: settings.pushToken, ...d, prev: settings.pushSub || null });
  settings.pushSub = d; saveSettings();
}
let syncTimer = null;
const syncPushSoon = () => { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncPush().catch(e => toast(e.message || '通知設定の同期に失敗しました')), 700); };
async function enablePush() {
  if (!pushConfigured()) throw new Error('config.js に Firebase / relay の設定が必要です');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('この環境はプッシュ通知に未対応です（iPadはホーム画面に追加して起動してください）');
  if (Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') throw new Error('通知が許可されていません'); }
  if (!window.firebase) {
    await loadScript(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-messaging-compat.js`);
  }
  if (!firebase.apps.length) firebase.initializeApp(CFG.firebase);
  const reg = await navigator.serviceWorker.ready;
  const token = await firebase.messaging().getToken({ vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
  if (!token) throw new Error('トークンを取得できません');
  settings.pushToken = token; settings.pushSub = null;
  const d = desiredSub();
  await relay('/subscribe', { token, ...d, prev: null });
  settings.pushSub = d; settings.push = true; saveSettings();
}
async function disablePush() {
  try { if (settings.pushToken && CFG.relayUrl) await relay('/unsubscribe', { token: settings.pushToken, prev: settings.pushSub }); } catch { /* noop */ }
  settings.push = false; settings.pushSub = null; saveSettings();
}

const SWATCHES = [[38, 'エンバー'], [250, 'オーシャン'], [160, 'フォレスト'], [305, 'バイオレット'], [8, 'ローズ'], [95, 'アンバー']];
function syncSettingsUI() {
  const chipSet = (sel, v) => $$(sel + ' .chip').forEach(c => c.setAttribute('aria-checked', String(String(c.dataset.v) === String(v))));
  $('#optNotify').checked = settings.notify && 'Notification' in window && Notification.permission === 'granted';
  $('#optSound').checked = settings.sound; $('#optSpeak').checked = settings.speak && 'speechSynthesis' in window; $('#optSpeak').disabled = !('speechSynthesis' in window);
  $('#optWake').checked = settings.wake; $('#optWake').disabled = !('wakeLock' in navigator);
  $('#optShake').checked = settings.shake; $('#optFull').checked = settings.fullAlert;
  $('#optPush').checked = settings.push; $('#optPush').disabled = !pushConfigured();
  $('#btnTest').disabled = !settings.push;
  $('#pushNote').textContent = pushConfigured() ? 'アプリを閉じていても即時に受信（FCM）' : 'config.js の Firebase / relay 設定後に有効化できます';
  $('#permNote').textContent = !('Notification' in window) ? 'この環境は通知に未対応です' : Notification.permission === 'denied' ? 'ブラウザ設定で通知がブロックされています' : '新着時にこの端末へ通知します';
  $('#optNation').checked = settings.nation; $('#nationBox').style.display = settings.nation ? '' : 'none'; chipSet('#minScale', settings.minScale);
  $('#optRegion').checked = settings.region.on; $('#regionBox').style.display = settings.region.on ? '' : 'none';
  $('#regionPref').value = String(settings.region.pref || 0); chipSet('#regionMin', settings.region.min);
  const h = settings.home;
  $('#homeText').textContent = h ? `現在地: ${h.label}（${h.approx ? '手動設定' : '取得 ' + fmtMD.format(h.at)}）` : '未設定です。現在地を取得するか、都道府県を選んでください。';
  $('#homePref').value = String((h && h.pref) || 0);
  chipSet('#themeMode', settings.theme.mode);
  $$('#swatches .swatch').forEach(b => b.setAttribute('aria-checked', String(+b.dataset.h === +settings.theme.hue)));
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#installNote').hidden = standalone || !/iPad|iPhone|Macintosh/.test(navigator.userAgent) || !('ontouchend' in document);
}
function syncFilterUI() {
  const f = settings.filter;
  $$('#filterPanel .chips').forEach(g => { const k = g.dataset.key; $$('.chip', g).forEach(c => c.setAttribute('aria-checked', String(String(c.dataset.v) === String(f[k])))); });
  $('#dFrom').value = f.from; $('#dTo').value = f.to; $('#fHome').checked = !!f.home;
  const n = activeFilters(); const b = $('#filterBadge'); b.hidden = !n; b.textContent = n;
}
function onFilterChanged(needOlder) {
  saveSettings(); syncFilterUI(); state.renderLimit = 100; renderList(); renderMarkers();
  const f = settings.filter;
  let cutoff = 0;
  if (PERIOD_MS[f.period]) cutoff = Date.now() - PERIOD_MS[f.period];
  if (f.from) { const a = Date.parse(f.from + 'T00:00:00+09:00'); if (Number.isFinite(a)) cutoff = Math.max(cutoff, a); }
  if (needOlder && cutoff) ensureLoadedUntil(cutoff, 15).then(() => { renderList(); renderMarkers(); });
}

function initSettingsUI() {
  const dlg = $('#settings');
  $('#regionPref').innerHTML = '<option value="0">都道府県を選択</option>' + G.PREFS.map(p => `<option value="${p[0]}">${p[1]}</option>`).join('');
  $('#homePref').innerHTML = '<option value="0">都道府県から手動設定</option>' + G.PREFS.map(p => `<option value="${p[0]}">${p[1]}</option>`).join('');
  $('#swatches').innerHTML = SWATCHES.map(([h, n]) => `<button type="button" class="swatch" role="radio" data-h="${h}" style="--sw:${h}" aria-label="${n}" title="${n}"></button>`).join('');
  $('#btnSettings').onclick = () => { syncSettingsUI(); dlg.showModal(); };
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  $('#optNotify').onchange = async (e) => {
    if (e.target.checked) { if (!('Notification' in window)) { e.target.checked = false; return; } const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission(); settings.notify = p === 'granted'; }
    else settings.notify = false;
    saveSettings(); syncSettingsUI();
  };
  $('#optNation').onchange = e => { settings.nation = e.target.checked; saveSettings(); syncSettingsUI(); syncPushSoon(); };
  $('#minScale').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; settings.minScale = +c.dataset.v; saveSettings(); syncSettingsUI(); syncPushSoon(); };
  $('#optRegion').onchange = e => {
    settings.region.on = e.target.checked;
    if (settings.region.on && !settings.region.pref && settings.home) settings.region.pref = settings.home.pref;
    saveSettings(); syncSettingsUI(); syncPushSoon();
    if (settings.region.on && !settings.region.pref) toast('通知する都道府県を選んでください');
  };
  $('#regionPref').onchange = e => { settings.region.pref = +e.target.value; saveSettings(); syncPushSoon(); };
  $('#regionMin').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; settings.region.min = +c.dataset.v; saveSettings(); syncSettingsUI(); syncPushSoon(); };
  $('#optSound').onchange = e => { settings.sound = e.target.checked; saveSettings(); if (settings.sound) beep(false); };
  $('#optSpeak').onchange = e => { settings.speak = e.target.checked; saveSettings(); if (settings.speak) speak('音声読み上げをオンにしました。', true); };
  $('#optWake').onchange = e => { settings.wake = e.target.checked; saveSettings(); if (settings.wake) wakeLock(); else wakeSentinel && wakeSentinel.release().catch(() => {}); };
  $('#optFull').onchange = e => { settings.fullAlert = e.target.checked; saveSettings(); if (settings.fullAlert) showOverlay({ tone: 'eq', kind: 'テスト表示', title: '全画面警報の表示テストです', sub: '実際の警報時は、このように画面いっぱいに表示されます', badge: scaleInfo(55) }); };
  $('#optShake').onchange = e => { settings.shake = e.target.checked; saveSettings(); if (settings.shake) initShake(); else shakeSweep(); };
  $('#optPush').onchange = async (e) => {
    e.target.disabled = true; if (e.target.checked) toast('プッシュ通知を登録中…（最大20秒）');
    try { e.target.checked ? await enablePush() : await disablePush(); toast(e.target.checked ? 'プッシュ通知を有効にしました' : 'プッシュ通知を無効にしました'); }
    catch (err) { e.target.checked = false; settings.push = false; saveSettings(); toast(err.message || 'プッシュ通知を有効にできません'); }
    syncSettingsUI();
  };
  $('#btnTest').onclick = async () => {
    try { if (!settings.push || !settings.pushToken) throw new Error('先にプッシュ通知(FCM)をオンにしてください'); toast('テスト通知を送信中…'); await relay('/test', { token: settings.pushToken }); toast('送信しました。数秒以内に通知が届きます'); }
    catch (err) { toast(err.message || '送信に失敗しました'); }
  };
  $('#btnLocateSet').onclick = () => locateMe({ fly: false });
  $('#homePref').onchange = e => { const c = +e.target.value; if (c) setHomePref(c); };
  $('#btnHomeClear').onclick = () => { setHome(null); toast('現在地を解除しました'); };
  $('#themeMode').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; settings.theme.mode = c.dataset.v; saveSettings(); applyTheme(); syncSettingsUI(); };
  $('#swatches').onclick = e => { const b = e.target.closest('.swatch'); if (!b) return; settings.theme.hue = +b.dataset.h; saveSettings(); applyTheme(); syncSettingsUI(); };
  $('#btnClear').onclick = () => {
    [K.events, K.tsunami, K.seen].forEach(k => { try { localStorage.removeItem(k); } catch { /* noop */ } });
    state.events = []; state.tsunami = null; seenIds.clear(); state.initialDone = false; state.histEnd = false; state.offset = 0;
    renderList(); renderMarkers(); renderAlerts(); fetchHistory(false);
  };
}

/* ---------------- 統計 ---------------- */
let statsDays = 30;
async function openStats() {
  const dlg = $('#stats'); dlg.showModal();
  const body = $('#statsBody');
  Stats.bindTips(body, $('#tip'));
  const draw = () => Stats.render(body, state.events, statsDays, Date.now(), { end: state.histEnd });
  $$('#statsPeriod .chip').forEach(c => c.setAttribute('aria-checked', String(+c.dataset.v === statsDays)));
  draw();
  await ensureLoadedUntil(Date.now() - statsDays * DAY, 20, draw);
  if (dlg.open) draw();
}

/* ---------------- 起動 ---------------- */
function init() {
  applyTheme();
  initMap();
  initSettingsUI();
  syncFilterUI();

  // 一覧・絞り込み
  $('#list').addEventListener('click', e => { const b = e.target.closest('.item'); if (b) select(b.dataset.id); });
  $('#scroll').addEventListener('scroll', () => { clearTimeout(init._st); init._st = setTimeout(checkMore, 80); }, { passive: true });
  $('#more').addEventListener('click', e => { if (e.target.closest('[data-act="more"]')) onMore(); });
  let qt = null;
  $('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim(); state.renderLimit = 100; renderList(); renderMarkers(); }, 200); });
  $('#btnFilter').onclick = () => { const p = $('#filterPanel'); p.hidden = !p.hidden; $('#btnFilter').setAttribute('aria-expanded', String(!p.hidden)); };
  $('#filterPanel').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    const k = c.parentElement.dataset.key, v = c.dataset.v;
    settings.filter[k] = k === 'mag' ? +v : v;
    if (k === 'period' && v !== 'all') { settings.filter.from = ''; settings.filter.to = ''; }
    onFilterChanged(k === 'period');
  });
  const dateChanged = () => { settings.filter.from = $('#dFrom').value; settings.filter.to = $('#dTo').value; if (settings.filter.from || settings.filter.to) settings.filter.period = 'all'; onFilterChanged(true); };
  $('#dFrom').addEventListener('change', dateChanged); $('#dTo').addEventListener('change', dateChanged);
  $('#fHome').addEventListener('change', e => {
    if (e.target.checked && !settings.home) { e.target.checked = false; toast('先に「設定」で現在地を登録してください'); return; }
    settings.filter.home = e.target.checked; onFilterChanged(false);
  });
  $('#btnResetFilter').onclick = () => { settings.filter = { ...defaults.filter }; $('#q').value = ''; state.q = ''; onFilterChanged(false); };

  // ナビ・地図ボタン
  $$('.navbar__item').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#btnFit').addEventListener('click', () => map && map.flyToBounds(JP_BOUNDS, { padding: [10, 10], duration: .8 }));
  $('#btnLocate').addEventListener('click', () => { if (settings.home) { map && map.flyTo([settings.home.lat, settings.home.lon], Math.max(map.getZoom(), 8), { duration: .9 }); if (settings.home.approx) toast('手動設定の位置です。設定から現在地を取得できます'); } else locateMe(); });
  $('#btnStats').addEventListener('click', openStats);
  $('#btnKiosk').addEventListener('click', () => setKiosk(true));
  $('#kExit').addEventListener('click', () => setKiosk(false, { quiet: true }));
  $('#kDim').addEventListener('click', () => { settings.kioskDim = !settings.kioskDim; saveSettings(); document.body.classList.toggle('kiosk-dim', settings.kioskDim); $('#kDim').setAttribute('aria-pressed', String(settings.kioskDim)); });
  $('#kAlerts').addEventListener('click', e => { if (e.target.closest('[data-close="eew"]')) clearEew(); });
  $('#ovClose').addEventListener('click', hideOverlay);
  $('#overlay').addEventListener('click', e => { if (e.target === $('#overlay')) hideOverlay(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#overlay').hidden) hideOverlay(); else if (state.kiosk) setKiosk(false, { quiet: true }); } });
  $('#statsClose').addEventListener('click', () => $('#stats').close());
  $('#stats').addEventListener('click', e => { if (e.target === $('#stats')) $('#stats').close(); });
  $('#statsPeriod').addEventListener('click', e => { const c = e.target.closest('.chip'); if (!c) return; statsDays = +c.dataset.v; openStats.redraw && 0; $$('#statsPeriod .chip').forEach(x => x.setAttribute('aria-checked', String(x === c))); const draw = () => Stats.render($('#statsBody'), state.events, statsDays, Date.now(), { end: state.histEnd }); draw(); ensureLoadedUntil(Date.now() - statsDays * DAY, 20, draw).then(() => $('#stats').open && draw()); });
  $('#alerts').addEventListener('click', e => { if (e.target.closest('[data-act="open-settings"]')) $('#btnSettings').click(); });

  // 再生
  $('#btnPlay').addEventListener('click', () => (pb.on ? pbClose() : pbOpen()));
  $('#pbToggle').addEventListener('click', () => pbPlay(!pb.playing));
  $('#pbRange').addEventListener('input', e => { pb.cur = pb.start + (pb.end - pb.start) * (+e.target.value / 1000); pbUpdate(true); });
  $('#pbSpeed').addEventListener('click', e => { const c = e.target.closest('.chip'); if (!c) return; pb.speed = +c.dataset.v; $$('#pbSpeed .chip').forEach(x => x.setAttribute('aria-checked', String(x === c))); });
  $$('#pbSpeed .chip').forEach(x => x.setAttribute('aria-checked', String(+x.dataset.v === 1)));

  // キャッシュを即描画 → 履歴取得 → WebSocket
  state.events.forEach(e => e.ids.forEach(i => seenIds.add(i)));
  state.events.forEach(e => { if (!e.cm) e.cm = ''; });
  if (state.tsunami && Date.now() - parseJst(state.tsunami.time) > DAY) state.tsunami = null;
  renderAlerts(); renderList(); renderMarkers();
  fetchHistory(true).finally(connect);
  if (settings.kiosk) setKiosk(true, { quiet: true });
  wakeLock(); initShake();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'notification-click') setView('list'); });
  }
}
init();
})();
