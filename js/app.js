/* 地震・津波速報 – P2P地震情報 API クライアント (v2) */
(() => {
'use strict';

const CFG = Object.assign({
  apiBase: 'https://api.p2pquake.net/v2', wsUrl: 'wss://api.p2pquake.net/v2/ws',
  historyLimit: 100, firebase: {}, vapidKey: '', relayUrl: ''
}, self.APP_CONFIG || {});
/* js/geo.js が読み込めなかった場合の簡易版（都道府県の選択・現在地の登録・距離計算だけ動く。地域別の感知は無効） */
const FALLBACK_PREFS = [[1,'北海道',43.064,141.347],[2,'青森県',40.824,140.740],[3,'岩手県',39.704,141.153],[4,'宮城県',38.269,140.872],[5,'秋田県',39.719,140.102],[6,'山形県',38.240,140.364],[7,'福島県',37.750,140.468],[8,'茨城県',36.342,140.447],[9,'栃木県',36.566,139.884],[10,'群馬県',36.391,139.060],[11,'埼玉県',35.857,139.649],[12,'千葉県',35.605,140.123],[13,'東京都',35.690,139.692],[14,'神奈川県',35.448,139.643],[15,'新潟県',37.902,139.023],[16,'富山県',36.695,137.211],[17,'石川県',36.595,136.626],[18,'福井県',36.065,136.222],[19,'山梨県',35.664,138.568],[20,'長野県',36.651,138.181],[21,'岐阜県',35.391,136.722],[22,'静岡県',34.977,138.383],[23,'愛知県',35.180,136.907],[24,'三重県',34.730,136.509],[25,'滋賀県',35.004,135.869],[26,'京都府',35.021,135.756],[27,'大阪府',34.686,135.520],[28,'兵庫県',34.691,135.183],[29,'奈良県',34.685,135.833],[30,'和歌山県',34.226,135.168],[31,'鳥取県',35.504,134.238],[32,'島根県',35.472,133.051],[33,'岡山県',34.662,133.935],[34,'広島県',34.397,132.460],[35,'山口県',34.186,131.471],[36,'徳島県',34.066,134.559],[37,'香川県',34.340,134.043],[38,'愛媛県',33.842,132.766],[39,'高知県',33.560,133.531],[40,'福岡県',33.607,130.418],[41,'佐賀県',33.249,130.299],[42,'長崎県',32.745,129.874],[43,'熊本県',32.790,130.742],[44,'大分県',33.238,131.613],[45,'宮崎県',31.911,131.424],[46,'鹿児島県',31.560,130.558],[47,'沖縄県',26.212,127.681]];
function fallbackHaversine(la1, lo1, la2, lo2) {
  const r = (x) => x * Math.PI / 180, dl = r(la2 - la1), dn = r(lo2 - lo1);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(dn / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const FALLBACK_GEO = {
  PREFS: FALLBACK_PREFS, byCode: new Map(FALLBACK_PREFS.map(p => [p[0], p])), haversine: fallbackHaversine,
  async reversePref(lat, lon) { const p = FALLBACK_PREFS.reduce((b, x) => (fallbackHaversine(lat, lon, x[2], x[3]) < fallbackHaversine(lat, lon, b[2], b[3]) ? x : b)); return { code: p[0], name: p[1], label: p[1] + '付近' }; },
  async loadAreas() { return new Map(); }
};
const GEO_OK = !!(window.Geo && window.Geo.PREFS && window.Geo.byCode);
const G = GEO_OK ? window.Geo : FALLBACK_GEO;
const ST = window.Stats && window.Stats.render ? window.Stats : { bindTips() {}, render(body) { body.innerHTML = '<p class="hint" style="padding:16px">統計モジュール（js/stats.js）を読み込めませんでした。</p>'; } };

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
  volcano: true, prep: {}, places: [], tab: 'home',
  region: { on: false, pref: 0, min: 30 },
  home: null,                                  // {lat, lon, pref(code), prefName, label, approx, at}
  filter: { scale: 'all', mag: 0, period: 'all', from: '', to: '', home: false },
  theme: { mode: 'dark', hue: 48 },
  push: false, pushToken: null, pushSub: null
};
const UI_VER = 2;                                   // NERV テーマ導入: 既存ユーザーも一度だけダーク/オレンジへ切り替える
const saved = load(K.settings, {});
if (saved.uiVer !== UI_VER) { saved.theme = { mode: 'dark', hue: 48 }; saved.uiVer = UI_VER; }
const settings = {
  ...defaults, ...saved,
  region: { ...defaults.region, ...(saved.region || {}) },
  theme: { ...defaults.theme, ...(saved.theme || {}) },
  filter: { ...defaults.filter, ...(typeof saved.filter === 'object' ? saved.filter : (saved.filter ? { scale: saved.filter } : {})) }
};
const saveSettings = () => save(K.settings, settings);
saveSettings();

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
  const meta = $('meta[name="theme-color"]'); if (meta) meta.content = dark ? '#050506' : '#f6f3f1';
}
darkMQ.addEventListener && darkMQ.addEventListener('change', applyTheme);

/* ---------------- 震度表現 ---------------- */
const SCALE = {
  10: ['1', '#6db3f2', '#031526'], 20: ['2', '#4fd1a0', '#032015'], 30: ['3', '#ffe14d', '#2a2300'],
  40: ['4', '#ff9f2e', '#2e1500'], 45: ['5弱', '#ff4538', '#ffffff'], 46: ['5弱<small>以上</small>', '#ff4538', '#ffffff'],
  50: ['5強', '#d4143c', '#ffffff'], 55: ['6弱', '#d92ba6', '#ffffff'], 60: ['6強', '#9b3bef', '#ffffff'], 70: ['7', '#5a2bd9', '#ffffff']
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
  new ResizeObserver(() => map.invalidateSize()).observe($('#mapWrap') || $('#mapPane'));
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
    return `<li><button class="item${isNew ? ' enter fresh' : ''}" data-id="${esc(ev.id)}" aria-pressed="${state.selected === ev.id}" style="--sc:${si.bg}">
      <span class="badge${si.plain.length > 1 ? ' two' : ''}" style="--c:${si.bg};--fg:${si.fg}"><span>${si.t}</span></span>
      <span class="item__main"><span class="item__title">${esc(title)}</span>
        <span class="item__meta">${meta}${dist != null && dist < 3000 ? ` · <span class="km">約${Math.round(dist)}km</span>` : ''} ${tsuTag}${homeTag}</span></span>
      <span class="item__time"><span>${fmtMD.format(ev.t)}</span><br><span data-rel="${ev.t}">${rel(ev.t)}</span></span>
    </button></li>`;
  }).join('');
  sc.scrollTop = top;
  kioskRender();
  renderMore();
  refreshInfoViews();
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
  const dist = homeDist(ev), hs = homeScale(ev), sdist = scaleDist(ev);
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
    ${sdist}
    ${pHtml ? `<h4>各地の震度</h4>${pHtml}` : ''}
    ${relatedHtml(ev)}
    <div class="meta">
      <div><span>情報の種類</span><span>${esc(TYPE_LABEL[ev.type] || ev.type)}</span></div>
      <div><span>発表</span><span>${esc(ev.src || '気象庁')} ${ev.it ? fmtFullSec.format(ev.it) : ''}</span></div>
      ${ev.mag >= 0 ? `<div><span>有感範囲の目安</span><span>半径 約${Math.round(impactKm(ev.mag))}km（推定）</span></div>` : ''}
      ${ev.ids.length > 1 ? `<div><span>統合した発表</span><span>${ev.ids.length}件</span></div>` : ''}
    </div>
    <div class="actions">
      ${ev.lat != null ? '<button class="btn btn--tonal btn--sm" data-act="waves" type="button">波の伝わりを再生</button>' : ''}
      <button class="btn btn--outline btn--sm" data-act="share" type="button"><svg viewBox="0 0 24 24"><use href="#i-share"/></svg>共有</button>
      <button class="btn btn--outline btn--sm" data-act="shareimg" type="button"><svg viewBox="0 0 24 24"><use href="#i-share"/></svg>画像で共有</button>
      <a class="btn btn--outline btn--sm" href="https://www.jma.go.jp/bosai/map.html#contents=earthquake_map" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><use href="#i-open"/></svg>気象庁</a>
    </div>`;
}
$('#detail').addEventListener('click', async (e) => {
  const rv = e.target.closest('[data-rel-ev]');
  if (rv) { const it = $(`.item[data-id="${CSS.escape(rv.dataset.relEv)}"]`); if (it) it.click(); else toast('一覧のフィルタで非表示になっています'); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const ev = state.events.find(x => x.id === state.selected); if (!ev) return;
  if (b.dataset.act === 'close') closeDetail();
  if (b.dataset.act === 'waves' && ev.lat != null) {
    if (map) map.flyTo([ev.lat, ev.lon], Math.max(5, map.getZoom()), { duration: .8 });
    startWaves({ lat: ev.lat, lon: ev.lon, depth: Math.max(ev.depth, 0) || 10, speed: 25, maxKm: Math.max(300, impactKm(ev.mag) * 1.6) });
    if (matchMedia('(max-width: 719px)').matches) setView('map');
  }
  if (b.dataset.act === 'shareimg') { shareImage(ev); return; }
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
    const topScale = Math.max(0, ...(m.areas || []).map(a => (SCALE[a.scaleTo] ? a.scaleTo : SCALE[a.scaleFrom] ? a.scaleFrom : 0)));
    const mx = topScale ? scaleInfo(topScale) : null;
    const mag = h.magnitude > 0 ? Number(h.magnitude).toFixed(1) : '—';
    const dep = h.depth > 0 ? `${h.depth}<u>km</u>` : h.depth === 0 ? 'ごく浅い' : '—';
    const fc = eewPrefForecast(m, homeName());
    const fcTile = `<div class="eewfc${fc ? '' : ' eewfc--na'}"><small>現在地予想震度</small>${fc ? `<b>${esc(fc.txt)}</b><span>${esc(homeName())}</span>` : settings.home ? `<b>対象外</b><span>${esc(homeName())}は予報の対象地域に含まれていません</span>` : '<b>未設定</b><span>設定で現在地を登録</span>'}</div>`;
    html += `<div class="alert alert--eew" role="alert">
      <div class="alert__head"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg>
        <div><div class="alert__title">${m.drill ? '【訓練】' : ''}緊急地震速報<em>EMERGENCY EARTHQUAKE WARNING</em></div><div class="alert__sub">強い揺れに警戒してください</div></div>
        <button class="alert__close" data-close="eew" aria-label="閉じる"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button></div>
      <div class="eewstat">
        <div class="eewstat__loc"><small>震源地</small><b>${esc(h.name || '調査中')}</b></div>
        <div><small>マグニチュード</small><b>${mag}</b></div>
        <div><small>深さ</small><b>${dep}</b></div>
        <div class="eewstat__max"><small>予想最大震度</small><b>${mx ? esc(mx.plain) : '—'}</b></div>
      </div>
      <div class="eewmain">${fcTile}${settings.home ? '<div class="cd" id="eewCd"></div>' : '<div class="cd"><span class="lbl">「設定」で現在地を登録すると、S波到達までのカウントダウンを表示します</span></div>'}</div>
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
  volActive().filter(x => !vol.dismissed.has(x.id)).slice(0, 2).forEach(x => {
    html += `<div class="alert alert--volc" role="alert"><div class="alert__head"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg>
      <div><div class="alert__title">${esc(x.label)}${x.name ? '：' + esc(x.name) : ''}<em>VOLCANIC ${x.kind === 'flash' ? 'ERUPTION FLASH' : 'WARNING'}</em></div><div class="alert__sub">${esc((x.summary || x.title || '').slice(0, 110))}</div></div>
      <button class="alert__close" data-close-vol="${esc(x.id)}" aria-label="閉じる"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button></div></div>`;
  });
  box.innerHTML = html;
  $$('[data-close-vol]', box).forEach(b => b.onclick = () => { vol.dismissed.add(b.dataset.closeVol); renderAlerts(); });
  $$('[data-close="eew"]', box).forEach(b => b.onclick = clearEew);
  refreshInfoViews();
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
  if (urgent) $$('dialog[open]').forEach(d => d.close());      // 設定・統計・モニタを開いていても警報が隠れないように
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
const pushActive = () => !!(settings.push && settings.pushToken && pushConfigured());
async function notify(title, body, tag, urgent) {
  if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden && document.hasFocus()) return;   // 操作中の画面では、アプリ内の警報（音・フラッシュ・全画面）に任せる（見えていても操作していなければ通知する）
  if (pushActive()) return;            // バックグラウンドは FCM が通知する（二重通知の防止）
  const opts = { body, tag, renotify: true, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', requireInteraction: !!urgent, data: { url: './' } };
  try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) return reg.showNotification(title, opts); new Notification(title, opts); } catch { /* noop */ }
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg;
  try { if (t.showPopover && !t.matches(':popover-open')) t.showPopover(); } catch { /* noop */ }   // <dialog> の最前面レイヤーより上に出す
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { try { if (!t.classList.contains('show') && t.hidePopover) t.hidePopover(); } catch { /* noop */ } }, 350); }, 3400);
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
  renderAlerts(); renderTsunamiPanel(); updateTabDots();
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
    const s = c.rem.toFixed(2).padStart(6, '0'); let lead = (s.match(/^0+/) || [''])[0]; if (s[lead.length] === '.') lead = lead.slice(0, -1);
    put('cd', `<span class="lbl">主要動（S波）到達まで<em>S-WAVE ETA</em></span><span class="num"><i>${lead}</i>${s.slice(lead.length)}</span><span class="lbl">秒</span><small>震源から約${Math.round(c.dist)}km ・ 推定値です（気象庁の予測ではありません）。まず身の安全を確保してください。</small>`);
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
    showOverlay({ tone: 'eew', eew: true, kind: m.drill ? '【訓練】緊急地震速報（警報）' : '緊急地震速報（警報）', title: m.drill ? 'これは訓練です。強い揺れに警戒' : '強い揺れに警戒してください', sub: `${h.name || '震源調査中'}${h.magnitude > 0 ? ' M' + Number(h.magnitude).toFixed(1) : ''}${(() => { const f = eewPrefForecast(m, homeName()); return f ? ` ／ ${homeName()} 予想震度 ${f.txt}` : ''; })()}` });
    if (!m.drill) notify('緊急地震速報（警報）', `${h.name || '震源調査中'} 強い揺れに警戒してください`, 'eew', true);
    speak(m.drill ? 'これは訓練です。緊急地震速報。強い揺れに警戒してください。' : '緊急地震速報。強い揺れに警戒してください。', true);
  }
  clearInterval(eewTick); eewTick = setInterval(updateCd, 80);
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

const recent = (m, ms) => { const t = parseJst(m.time || (m.issue && m.issue.time)); return Number.isFinite(t) && Date.now() - t < ms; };
function handle(m, live, catchup) {
  if (!m || typeof m !== 'object') return;
  if (live) { mon.lastMsg = Date.now(); mon.count++; if (m.code === 561) monDetect(m); else monFeed(m); }   // 監視モニタ用
  const asLive = (ms) => live || (catchup && recent(m, ms));   // WebSocket が切れている間に出た情報（10分以内）
  switch (m.code) {
    case 551: applyQuake(m, { live: asLive(10 * 60e3) }); break;
    case 552: applyTsunami(m, { live: asLive(30 * 60e3) }); break;
    case 556: if (live) applyEew(m); break;
    case 561: if (live) applyShake(m); break;
    default: break;
  }
}

/* ---------------- REST: 履歴 ---------------- */
const idCount = () => state.events.reduce((n, e) => n + e.ids.length, 0);
async function fetchHistory(silent) {
  try {
    const [qr, tr] = await Promise.all([
      fetch(`${CFG.apiBase}/history?codes=551&limit=100`, { cache: 'no-store' }),
      fetch(`${CFG.apiBase}/history?codes=552&limit=3`, { cache: 'no-store' }).catch(() => null)
    ]);
    if (!qr.ok) throw new Error(qr.status);
    const arr = await qr.json();
    const catchup = state.events.length > 0, before = idCount(), wasInit = state.initialDone;   // 初回(キャッシュなし)は新着扱いにしない
    if (tr && tr.ok) { const ta = await tr.json(); if (ta[0]) applyTsunami(ta[0], { live: catchup && recent(ta[0], 30 * 60e3) }); }
    arr.slice().reverse().forEach(m => handle(m, false, catchup));            // 古い順に処理（最新の警報が最後に出る）
    if (!state.initialDone) { state.initialDone = true; state.offset = arr.length; state.histEnd = arr.length < 100; }
    if (!silent || !wasInit || idCount() !== before) { persist(); renderList(); renderMarkers(); }
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
setInterval(() => { if (!document.hidden && navigator.onLine) fetchHistory(true); }, 60000);   // 保険のポーリング

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
  settings.home = h; saveSettings(); renderHomeMarker(); renderList(); syncSettingsUI(); syncPushSoon();
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
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
async function relay(path, body) {
  const base = CFG.relayUrl.replace(/\/$/, '');
  let lastErr;
  for (let i = 0; i < 6; i++) {                      // Render 無料プランの起動待ち（最大 約1分）に耐える
    try {
      const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) return r.json().catch(() => ({}));
      const e = new Error('中継サーバーがエラーを返しました (' + r.status + ')'); e.status = r.status;
      if ([502, 503, 504].includes(r.status)) { lastErr = e; await sleep(8000); continue; }   // 起動中
      throw e;
    } catch (e) {
      if (e.status) throw e;
      let reachable = false;
      try { await fetch(base + '/healthz', { mode: 'no-cors', cache: 'no-store' }); reachable = true; } catch { /* unreachable */ }
      if (reachable) throw new Error('中継サーバーは動いていますが拒否されました。RenderのALLOWED_ORIGINが ' + location.origin + ' と一致しているか確認してください');
      lastErr = new Error('中継サーバーに届きません。起動中かもしれません。1分ほど待つか、config.jsのrelayUrlを確認してください');
      await sleep(8000);
    }
  }
  throw lastErr;
}
const desiredSub = () => ({
  nation: settings.nation ? settings.minScale : null,
  volcano: !!settings.volcano,
  region: settings.region.on && settings.region.pref ? { pref: settings.region.pref, name: regionPrefName(), min: settings.region.min } : null
});
const sameSub = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function syncPush(force) {
  if (!settings.push || !settings.pushToken) return;
  const d = desiredSub();
  if (!force && sameSub(settings.pushSub, d) && Date.now() - (settings.pushAt || 0) < 3 * DAY) return;
  await relay('/subscribe', { token: settings.pushToken, ...d, prev: settings.pushSub || null });
  settings.pushSub = d; settings.pushAt = Date.now(); saveSettings();
}
let syncTimer = null;
const syncPushSoon = () => {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try { await syncPush(); }
    catch (e) {
      if (e && e.status === 400) { try { await refreshPush({ renew: true }); return; } catch (e2) { e = e2; } }   // トークン失効 → 取り直し
      toast((e && e.message) || '通知設定の同期に失敗しました');
    }
  }, 700);
};
async function ensureFirebase() {
  if (!window.firebase) {
    await loadScript(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-messaging-compat.js`);
  }
  if (!firebase.apps.length) firebase.initializeApp(CFG.firebase);
  bindForeground();
}
let fgBound = false;
/* FCM は「画面が見えているウィンドウ」が1つでもあると、通知を出さずにアプリ側へ渡す。
   iPadOS のウィンドウ表示などで、見えていても操作していない場合は、ここで必ず通知を表示する。 */
async function showFromPush(d) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration(); if (!reg) return;
  const tag = d.tag || 'quake'; let renotify = d.renotify !== '0';
  try { const cur = await reg.getNotifications({ tag }); if (d.mid && cur.some(n => n.data && n.data.mid === d.mid)) renotify = false; } catch { /* noop */ }
  return reg.showNotification(d.title || '地震情報', { body: d.body || '', tag, renotify, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', requireInteraction: d.urgent === '1', timestamp: Date.now(), data: { url: './', mid: d.mid || '', kind: d.kind || '' } });
}
function bindForeground() {
  if (fgBound) return; fgBound = true;
  try {
    firebase.messaging().onMessage((p) => {
      const d = p.data || {}, focused = document.hasFocus();
      if (focused && state.status === 'live') return;                 // 操作中かつ配信が生きている → アプリ内の警報表示が出ている
      if (!focused) showFromPush(d).catch(() => {});                  // 見えているが操作していない → 通知を表示
      else { flash(d.urgent === '1'); beep(d.urgent === '1'); toast(`${d.title || '地震情報'}：${String(d.body || '').split('\n')[0]}`); }
      fetchHistory(true);
    });
  } catch { /* noop */ }
}
async function getFcmToken() {
  const reg = await withTimeout(navigator.serviceWorker.ready, 15000, 'Service Worker の準備に失敗しました。アプリを開き直してください');
  const token = await withTimeout(firebase.messaging().getToken({ vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg }), 20000, 'トークン取得がタイムアウトしました');
  if (!token) throw new Error('トークンを取得できません');
  return token;
}
async function enablePush() {
  if (!pushConfigured()) throw new Error('config.js に Firebase / relay の設定が必要です');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('この環境はプッシュ通知に未対応です（iPadはホーム画面に追加して起動してください）');
  if (Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') throw new Error('通知が許可されていません'); }
  await ensureFirebase();
  const token = await getFcmToken();
  const d = desiredSub();
  await relay('/subscribe', { token, ...d, prev: null });
  settings.pushToken = token; settings.pushSub = d; settings.pushAt = Date.now(); settings.push = true; saveSettings();
}
/* 起動時: トークンの更新検知 / 許可が外れていないか / 購読の再同期（3日ごと） */
async function refreshPush({ renew = false } = {}) {
  if (!settings.push) return;
  if (!pushConfigured() || !('Notification' in window) || Notification.permission !== 'granted') {
    settings.push = false; settings.pushSub = null; saveSettings(); syncSettingsUI();
    toast('通知の許可が無効になっていたため、プッシュ通知をオフにしました');
    return;
  }
  await ensureFirebase();
  if (renew) { try { await firebase.messaging().deleteToken(); } catch { /* noop */ } }
  const token = await getFcmToken();
  if (token !== settings.pushToken) { settings.pushToken = token; settings.pushSub = null; }
  await syncPush(renew || !settings.pushSub);
  syncSettingsUI();
}
async function disablePush() {
  try { if (settings.pushToken && CFG.relayUrl) await relay('/unsubscribe', { token: settings.pushToken, prev: settings.pushSub }); } catch { /* noop */ }
  settings.push = false; settings.pushSub = null; saveSettings();
}

const SWATCHES = [[48, 'NERVオレンジ'], [27, 'ネルフレッド'], [150, 'MAGIグリーン'], [215, 'シアン'], [305, '初号機パープル'], [95, 'イエロー']];
function syncSettingsUI() {
  const chipSet = (sel, v) => $$(sel + ' .chip').forEach(c => c.setAttribute('aria-checked', String(String(c.dataset.v) === String(v))));
  $('#optNotify').checked = settings.notify && 'Notification' in window && Notification.permission === 'granted';
  $('#optSound').checked = settings.sound; $('#optSpeak').checked = settings.speak && 'speechSynthesis' in window; $('#optSpeak').disabled = !('speechSynthesis' in window);
  $('#optWake').checked = settings.wake; $('#optWake').disabled = !('wakeLock' in navigator);
  $('#optShake').checked = settings.shake; $('#optFull').checked = settings.fullAlert;
  $('#optPush').checked = settings.push; $('#optPush').disabled = !pushConfigured();
  { const v = $('#optVolcano'); if (v) v.checked = !!settings.volcano; }
  $('#btnTest').disabled = !settings.push;
  $('#pushNote').textContent = !pushConfigured() ? 'config.js の Firebase / relay 設定後に有効化できます' : ('Notification' in window && Notification.permission === 'denied') ? '通知がブロックされています（iPadの 設定 › 通知 で許可してください）' : 'アプリを閉じていても即時に受信（FCM）。津波・緊急地震速報は常に届きます';
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

function renderLegend() {
  const el = $('#legend'); if (!el) return;
  el.innerHTML = [10, 20, 30, 40, 45, 50, 55, 60, 70].map(v => { const s = scaleInfo(v); return `<span class="lg"><i style="--c:${s.bg}"></i>${s.plain}</span>`; }).join('');
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
  { const v = $('#optVolcano'); if (v) v.onchange = e => { settings.volcano = e.target.checked; saveSettings(); syncPushSoon(); toast(settings.volcano ? '噴火速報・噴火警報をプッシュ通知します' : '噴火のプッシュ通知をオフにしました'); }; }
  $('#optShake').onchange = e => { settings.shake = e.target.checked; saveSettings(); if (settings.shake) initShake(); else shakeSweep(); };
  $('#optPush').onchange = async (e) => {
    e.target.disabled = true; if (e.target.checked) toast('プッシュ通知を登録中…（中継サーバー起動待ちで最大1分）');
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
  ST.bindTips(body, $('#tip'));
  const draw = () => ST.render(body, state.events, statsDays, Date.now(), { end: state.histEnd });
  $$('#statsPeriod .chip').forEach(c => c.setAttribute('aria-checked', String(+c.dataset.v === statsDays)));
  draw();
  await ensureLoadedUntil(Date.now() - statsDays * DAY, 20, draw);
  if (dlg.open) draw();
}

/* =========================================================
   リアルタイム監視モニタ（P2P 地震感知情報 561 + 地震情報 + 緊急地震速報）
   ========================================================= */
const mon = { det: [], feed: [], count: 0, lastMsg: 0, open: false, raf: 0, lastDom: 0, areaLoading: false, latest: null };
const MON_KEEP = 10 * 60e3;
const MON = { LAT0: 24, LAT1: 46, LON0: 122, LON1: 146.5, KX: Math.cos(35 * Math.PI / 180) };
const heatColor = (n) => (n >= 20 ? '#ff4538' : n >= 10 ? '#ff9f2e' : n >= 5 ? '#ffe14d' : n >= 2 ? '#4fd1a0' : '#6db3f2');
const ensureAreas = () => {
  if (areaTable || mon.areaLoading) return; mon.areaLoading = true;
  G.loadAreas().then(t => { areaTable = t; }).catch(() => {}).finally(() => { mon.areaLoading = false; });
};
function monDetect(m) {                         // 設定に関係なく記録（モニタ用）
  if (typeof m.area !== 'number') return;
  const now = Date.now(); mon.det.push({ t: now, area: m.area });
  if (mon.det.length > 6000 || now - mon.det[0].t > MON_KEEP) { const lim = now - MON_KEEP; mon.det = mon.det.filter(x => x.t >= lim).slice(-6000); }
}
function monFeed(m) {
  let text = null, lv = '';
  if (m.code === 551) {
    const e = m.earthquake || {}, h = e.hypocenter || {};
    const sc = Number.isFinite(e.maxScale) && e.maxScale >= 10 ? scaleInfo(e.maxScale).plain : '不明';
    text = `地震情報 最大震度${sc} ${h.name || '震源調査中'}${h.magnitude > 0 ? ' M' + Number(h.magnitude).toFixed(1) : ''}`;
    lv = e.maxScale >= 45 ? 'bad' : e.maxScale >= 30 ? 'warn' : '';
  } else if (m.code === 552) {
    const off = m.cancelled || !(m.areas && m.areas.length);
    text = off ? '津波予報 解除' : `津波予報 ${m.areas.length}区域に発表`; lv = off ? '' : 'bad';
  } else if (m.code === 556) {
    if (m.test) return;
    const h = (m.earthquake && m.earthquake.hypocenter) || {};
    text = m.cancelled ? '緊急地震速報 取り消し' : `緊急地震速報（警報） ${h.name || ''}`.trim(); lv = m.cancelled ? '' : 'bad';
  }
  if (!text) return;
  mon.feed.unshift({ t: Date.now(), text, lv }); if (mon.feed.length > 30) mon.feed.length = 30;
}
function openMonitor() {
  const d = $('#monitor'); if (d.open) return;
  ensureAreas(); d.showModal(); mon.open = true; mon.lastDom = 0; monLoop();
}
function monLoop() {
  if (!mon.open) return;
  const now = Date.now();
  if (now - mon.lastDom > 500) { mon.lastDom = now; monDom(now); }
  monDraw(now);
  mon.raf = requestAnimationFrame(monLoop);
}
function monSize(cv, hFixed) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = cv.clientWidth, h = hFixed || cv.clientHeight;
  if (!w || !h) return null;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  return { c, w, h };
}
function monDraw(now) {
  const sz = monSize($('#monCanvas')); if (!sz) return;
  const { c, w, h } = sz;
  const sx = (MON.LON1 - MON.LON0) * MON.KX, sy = MON.LAT1 - MON.LAT0, s = Math.min(w / sx, h / sy) * 0.97;
  const ox = (w - sx * s) / 2, oy = (h - sy * s) / 2;
  const P = (lat, lon) => [ox + (lon - MON.LON0) * MON.KX * s, oy + (MON.LAT1 - lat) * s];
  // 格子
  c.lineWidth = 1; c.strokeStyle = 'rgba(255,138,31,.10)'; c.beginPath();
  for (let la = MON.LAT0; la <= MON.LAT1; la += 2) { const y = Math.round(oy + (MON.LAT1 - la) * s) + .5; c.moveTo(ox, y); c.lineTo(ox + sx * s, y); }
  for (let lo = MON.LON0; lo <= MON.LON1; lo += 2) { const x = Math.round(ox + (lo - MON.LON0) * MON.KX * s) + .5; c.moveTo(x, oy); c.lineTo(x, oy + sy * s); }
  c.stroke();
  c.font = '600 12px "Roboto Flex","Noto Sans JP",sans-serif'; c.textBaseline = 'middle';
  if (!areaTable) { c.fillStyle = 'rgba(200,200,210,.6)'; c.textAlign = 'center'; c.fillText('地域データを読み込み中…', w / 2, h / 2); c.textAlign = 'left'; }
  else if (!areaTable.size) { c.fillStyle = 'rgba(255,200,120,.85)'; c.textAlign = 'center'; c.fillText('地域データを取得できません（感知の地点表示は無効）', w / 2, h / 2); c.textAlign = 'left'; }
  else { c.fillStyle = 'rgba(170,185,200,.34)'; areaTable.forEach(a => { const [x, y] = P(a.lat, a.lon); c.fillRect(x - 1, y - 1, 2.2, 2.2); }); }

  // 揺れの感知（直近60秒の件数を色と大きさで表現）
  if (areaTable) {
    const cnt = new Map(), lim = now - 60000;
    for (let i = mon.det.length - 1; i >= 0; i--) { const d = mon.det[i]; if (d.t < lim) break; cnt.set(d.area, (cnt.get(d.area) || 0) + 1); }
    cnt.forEach((n, area) => {
      const a = areaTable.get(area); if (!a) return; const [x, y] = P(a.lat, a.lon);
      c.fillStyle = heatColor(n); c.globalAlpha = .88; c.beginPath(); c.arc(x, y, 3 + Math.min(11, Math.sqrt(n) * 2.2), 0, 6.283); c.fill();
    });
    c.globalAlpha = 1; c.lineWidth = 1.5;
    for (let i = mon.det.length - 1; i >= 0; i--) {      // 新着のさざ波
      const d = mon.det[i], age = now - d.t; if (age > 3000) break;
      const a = areaTable.get(d.area); if (!a) continue; const [x, y] = P(a.lat, a.lon), k = age / 3000;
      c.strokeStyle = `rgba(255,205,130,${(1 - k) * .85})`; c.beginPath(); c.arc(x, y, 5 + k * 28, 0, 6.283); c.stroke();
    }
  }
  const cross = (x, y, r, col, lw) => { c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r); c.stroke(); };
  const label = (txt, x, y, col) => { c.fillStyle = 'rgba(0,0,0,.65)'; const tw = c.measureText(txt).width; c.fillRect(x - 3, y - 9, tw + 6, 18); c.fillStyle = col; c.fillText(txt, x, y); };

  // 現在地
  if (settings.home) { const [x, y] = P(settings.home.lat, settings.home.lon); c.fillStyle = '#6cc4ff'; c.beginPath(); c.arc(x, y, 5, 0, 6.283); c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke(); label('現在地', x + 9, y, '#bfe6ff'); }
  // 直近の地震（24時間以内）
  const q = mon.latest;
  if (q && q.lat != null && now - q.t < 864e5) {
    const [x, y] = P(q.lat, q.lon), si = scaleInfo(q.scale), fresh = now - q.t < 600e3;
    if (fresh) { const k = (now % 2000) / 2000; c.strokeStyle = si.bg; c.globalAlpha = 1 - k; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 8 + k * 30, 0, 6.283); c.stroke(); c.globalAlpha = 1; }
    cross(x, y, 8, '#000', 6); cross(x, y, 8, si.bg, 3.2);
    label(`${q.name || '震源'} ${q.mag >= 0 ? 'M' + q.mag.toFixed(1) : ''}`.trim(), x + 13, y - 14, '#fff');
  }
  // 緊急地震速報: P波 / S波の同心円（概算）
  if (state.eew) {
    const m = state.eew.msg, hy = (m.earthquake && m.earthquake.hypocenter) || {}, lat = Number(hy.latitude), lon = Number(hy.longitude);
    if (validCoord(lat, lon)) {
      let o = parseJst(m.earthquake.originTime); if (!Number.isFinite(o)) o = parseJst(m.issue && m.issue.time); if (!Number.isFinite(o)) o = now;
      const t = Math.max(0, (now - o) / 1000), dep = hy.depth > 0 ? hy.depth : 10, [x, y] = P(lat, lon);
      [[VP, 'rgba(80,200,255,.85)', null], [VS, 'rgba(255,69,56,.95)', 'rgba(255,69,56,.14)']].forEach(([v, stroke, fill]) => {
        const rk = Math.sqrt(Math.max(0, (v * t) ** 2 - dep * dep)), rp = rk / 111.2 * s; if (rp < 1) return;
        c.beginPath(); c.arc(x, y, rp, 0, 6.283); if (fill) { c.fillStyle = fill; c.fill(); } c.strokeStyle = stroke; c.lineWidth = 2; c.stroke();
      });
      cross(x, y, 10, '#000', 7); cross(x, y, 10, (now % 600 < 300) ? '#ff4538' : '#ffc400', 4);
      label(`${state.eew.msg.drill ? '【訓練】' : ''}緊急地震速報 ${hy.name || ''}`, x + 15, y - 16, '#ffb3ab');
    }
  }
}
function monDom(now) {
  const set = (id, v) => { const el = $(id); if (el && el.textContent !== v) el.textContent = v; };
  const pill = (id, cls, text) => { const el = $(id); if (!el) return; el.className = 'pill pill--' + cls; if (el.textContent !== text) el.textContent = text; };
  set('#monClock', new Date(now).toLocaleTimeString('ja-JP', { hour12: false, timeZone: 'Asia/Tokyo' }));
  // 感知の集計
  const lim = now - MON_KEEP, bins = new Array(60).fill(0); let n60 = 0, n10 = 0; const byPref = new Map();
  for (const d of mon.det) {
    if (d.t < lim) continue;
    bins[Math.min(59, Math.floor((d.t - lim) / 10000))]++;
    if (now - d.t < 60000) { n60++; const a = areaTable && areaTable.get(d.area); if (a) byPref.set(a.pref, (byPref.get(a.pref) || 0) + 1); }
    if (now - d.t < 10000) n10++;
  }
  const surge = n60 >= 10;
  set('#monN60', String(n60)); set('#monN10', String(n10));
  const top = [...byPref.entries()].sort((a, b) => b[1] - a[1])[0];
  set('#monTop', top ? top[0] : '—'); set('#monTopN', top ? `${top[1]}件/分` : '');
  $('#monN60').closest('.tile').classList.toggle('tile--hot', surge);
  pill('#monSurge', surge ? 'bad' : n60 ? 'warn' : 'ok', surge ? '感知が急増' : n60 ? '感知あり' : '平常');
  // 状態
  const live = state.status === 'live';
  pill('#monLink', live ? 'ok' : state.status === 'offline' ? 'bad' : 'warn', live ? 'ライブ' : state.status === 'offline' ? 'オフライン' : '接続中');
  const rcv = mon.lastMsg ? Math.round((now - mon.lastMsg) / 1000) : null;
  set('#monLast', rcv == null ? '—' : rcv < 90 ? `${rcv}秒前` : `${Math.round(rcv / 60)}分前`);
  set('#monCount', `${mon.count}件`);
  pill('#monEew', state.eew ? 'bad' : 'ok', state.eew ? (state.eew.msg.drill ? '訓練中' : '発表中') : '発表なし');
  const ts = state.tsunami, tsOn = ts && !ts.cancelled && ts.areas && ts.areas.length && Date.now() - (parseJst(ts.time) || 0) < DAY;
  pill('#monTsu', tsOn ? 'bad' : 'ok', tsOn ? `${ts.areas.length}区域に発表` : '発表なし');
  // 直近の地震
  const evs = state.events.slice().sort((a, b) => b.t - a.t); mon.latest = evs.find(e => e.lat != null) || null;
  const lst = $('#monLatest');
  const html = evs.slice(0, 3).map(e => { const si = scaleInfo(e.scale, e.type === 'Foreign'); return `<li><span class="badge" style="--c:${si.bg};--fg:${si.fg}">${si.t}</span><div><b>${esc(e.name || '震源調査中')}</b><small>${e.mag >= 0 ? 'M' + e.mag.toFixed(1) + ' ・ ' : ''}${esc(rel(e.t))}</small></div></li>`; }).join('');
  if (lst.dataset.h !== html) { lst.dataset.h = html; lst.innerHTML = html || '<li class="empty">履歴を読み込み中…</li>'; }
  const fd = $('#monFeed');
  const fh = mon.feed.slice(0, 12).map(f => `<li class="${f.lv}"><time>${new Date(f.t).toLocaleTimeString('ja-JP', { hour12: false, timeZone: 'Asia/Tokyo' })}</time><span>${esc(f.text)}</span></li>`).join('');
  if (fd.dataset.h !== fh) { fd.dataset.h = fh; fd.innerHTML = fh || '<li class="empty">受信待ち（地震情報・津波・緊急地震速報が届くとここに流れます）</li>'; }
  monSpark(bins);
}
function monSpark(bins) {
  const sz = monSize($('#monSpark'), 88); if (!sz) return;
  const { c, w, h } = sz, mx = Math.max(6, ...bins), bw = w / bins.length, base = h - 16;
  c.strokeStyle = 'rgba(255,138,31,.25)'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, base + .5); c.lineTo(w, base + .5); c.stroke();
  bins.forEach((n, i) => { if (!n) return; const bh = Math.max(2, n / mx * (base - 4)); c.fillStyle = heatColor(n); c.fillRect(i * bw + 1, base - bh, Math.max(1, bw - 2), bh); });
  c.fillStyle = 'rgba(200,200,210,.7)'; c.font = '10.5px "Roboto Flex","Noto Sans JP",sans-serif'; c.textBaseline = 'alphabetic';
  c.textAlign = 'left'; c.fillText('10分前', 0, h - 3); c.textAlign = 'right'; c.fillText(`現在（10秒ごと・最大${mx}件）`, w, h - 3);
}

/* =========================================================
   接続診断 / 防災訓練 / CSV
   ========================================================= */
async function runDiag() {
  const out = $('#diagOut'); out.hidden = false; out.innerHTML = '<div class="d d--warn"><b>診断中</b><span>しばらくお待ちください…</span></div>';
  const rows = [], add = (lv, k, v) => rows.push(`<div class="d d--${lv}"><b>${esc(k)}</b><span>${esc(v)}</span></div>`);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  add(standalone ? 'ok' : 'warn', '起動方法', standalone ? 'ホーム画面アプリ（PWA）' : 'ブラウザで開いています。iPad のプッシュ通知はホーム画面に追加したアプリでのみ動作します');
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  add(perm === 'granted' ? 'ok' : 'bad', '通知の許可', { granted: '許可済み', denied: 'ブロック中（iPad の 設定 › 通知 › 本アプリ で許可）', default: '未選択（設定でプッシュ通知をオン）', unsupported: 'この環境は非対応' }[perm]);
  try { const reg = await navigator.serviceWorker.getRegistration(); add(reg && reg.active ? 'ok' : 'bad', 'Service Worker', reg && reg.active ? '稼働中' : '未登録（再読み込みしてください）'); } catch { add('bad', 'Service Worker', '確認できません'); }
  const reg = settings.push && settings.pushToken;
  { const SN = { 10: '震度1以上', 30: '震度3以上', 40: '震度4以上', 45: '震度5弱以上', 55: '震度6弱以上' }, ps = settings.pushSub, ds = desiredSub(), same = ps && JSON.stringify(ps) === JSON.stringify(ds);
    if (reg) add(!ps ? 'bad' : same ? 'ok' : 'warn', '購読内容（サーバー登録済み）', ps ? `全国: ${ps.nation ? (SN[ps.nation] || ps.nation) : 'オフ'} ／ 地域別: ${ps.region ? ps.region.name + ' ' + (SN[ps.region.min] || '') : 'オフ'} ／ 噴火: ${ps.volcano ? 'オン' : 'オフ'} ／ 津波・緊急地震速報: 常に受信${same ? '' : '（現在の設定とずれています。設定を開き直すと再同期します）'}` : 'まだサーバーに登録できていません。設定でプッシュ通知をオフ→オンにしてください'); }
  add(reg ? 'ok' : 'warn', 'プッシュ登録', reg ? `登録済み（トークン …${settings.pushToken.slice(-6)}）／最終同期 ${settings.pushAt ? rel(settings.pushAt) : '—'}` : '未登録');
  if (CFG.relayUrl) {
    const t0 = performance.now();
    try {
      const r = await withTimeout(fetch(CFG.relayUrl.replace(/\/$/, '') + '/healthz', { cache: 'no-store' }), 12000, 'timeout'), j = await r.json();
      const upMin = Math.round((j.up || 0) / 60);
      add(j.v ? (j.ws ? 'ok' : 'warn') : 'bad', '中継サーバー', j.v ? `v${j.v} ／ 応答 ${Math.round(performance.now() - t0)}ms ／ P2P接続 ${j.ws ? '○' : '×'} ／ 稼働 ${upMin}分` : `古い版です（購読の形式が違うため、震度のしきい値・地域別・噴火通知が反映されません）。relay/ を最新版で再デプロイしてください`);
      if (j.v) {
        add(j.lastWsMsgAgo == null ? 'warn' : 'ok', '地震情報の受信（サーバー）', j.lastWsMsgAgo == null ? '起動後まだ受信なし（地震が無いだけの場合もあります）' : `最後に ${j.lastWsMsgAgo < 120 ? j.lastWsMsgAgo + '秒' : Math.round(j.lastWsMsgAgo / 60) + '分'}前`);
        add(j.lastPush ? 'ok' : 'warn', '最後のプッシュ送信', j.lastPush ? `${j.lastPush.agoSec < 120 ? j.lastPush.agoSec + '秒' : Math.round(j.lastPush.agoSec / 60) + '分'}前 ・ ${j.lastPush.title}` : '起動後まだ送信なし');
        if (upMin < 3) add('warn', 'スリープの疑い', 'サーバーが直前に起動し直されています。無料プランは15分アクセスが無いと停止し、その間の地震は通知されません。UptimeRobot 等で /healthz を5分ごとに監視してください');
        add(j.volcano && j.volcano.ok ? 'ok' : 'warn', '噴火情報フィード', j.volcano && j.volcano.ok ? `取得中（${j.volcano.items}件）` : '取得できていません');
      }
    } catch { add('bad', '中継サーバー', '応答なし。無料プランのスリープ中なら 1 分ほど待って再実行してください'); }
  } else add('warn', '中継サーバー', 'config.js の relayUrl が未設定です');
  const t1 = performance.now();
  try { const r = await withTimeout(fetch(`${CFG.apiBase}/history?codes=551&limit=1`, { cache: 'no-store' }), 10000, 'timeout'); add(r.ok ? 'ok' : 'bad', 'P2P地震情報 API', `HTTP ${r.status} ・ ${Math.round(performance.now() - t1)}ms`); } catch { add('bad', 'P2P地震情報 API', '到達できません'); }
  add(state.status === 'live' ? 'ok' : 'warn', 'WebSocket', state.status === 'live' ? `ライブ ／ 最終受信 ${mon.lastMsg ? rel(mon.lastMsg) : '（起動後まだ受信なし）'}` : '未接続（再接続を試行中）');
  try { const t = await withTimeout(G.loadAreas(), 12000, 'timeout'); add(t.size ? 'ok' : 'warn', '地域データ（感知）', t.size ? `${t.size}地域` : '取得できません（感知の地点表示は無効。通知・履歴には影響しません）'); } catch { add('warn', '地域データ（感知）', '取得できません'); }
  const top = state.events.slice().sort((a, b) => b.t - a.t)[0];
  add(top ? 'ok' : 'warn', '履歴データ', top ? `${state.events.length}件 ／ 最新 ${rel(top.t)}` : '未取得');
  out.innerHTML = rows.join('');
}
const pad2 = (n) => String(n).padStart(2, '0');
const fmtJst = (ms) => { const d = new Date(ms + 9 * 3600e3); return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`; };
async function testTopic() {
  if (!settings.push || !settings.pushToken) { toast('先に「プッシュ通知（FCM）」をオンにしてください'); return; }
  toast('配信経路テストを送信中…（実際の地震通知と同じトピック経由）');
  try { const j = await relay('/test-topic', { token: settings.pushToken, ...desiredSub() }); toast(`送信しました（経路: ${j.via || 'トピック'}）。アプリを閉じて通知が届くか確認してください`); }
  catch (e) {
    if (e && e.status === 404) banner('⚠ 中継サーバーが古い版のまま動いています（配信経路テストが未対応: HTTP 404）。GitHub の relay/ に最新の server.js と package.json を上げ、Render の Events で「Deploy succeeded」になっているか確認してください。<br>確認: ブラウザで <b>' + esc(CFG.relayUrl.replace(/\/$/, '')) + '/healthz</b> を開き、<b>"v":3</b> と出れば新版です。');
    else toast((e && e.message) || '配信経路テストに失敗しました');
  }
}
function startDrill() {
  $$('dialog[open]').forEach(d => d.close());
  const b = settings.home || { lat: 35.68, lon: 139.69, prefName: '東京都' };
  const now = Date.now(), id = 'drill-' + now;
  applyEew({
    code: 556, id, drill: true, issue: { eventId: id, time: fmtJst(now) },
    earthquake: { originTime: fmtJst(now - 1500), hypocenter: { name: '訓練用の想定震源', latitude: b.lat + 0.55, longitude: b.lon + 0.45, depth: 30, magnitude: 7.0 } },
    areas: [{ pref: b.prefName || '', name: b.prefName || 'あなたの地域', scaleFrom: 50, scaleTo: 60 }]
  });
  toast('防災訓練を開始しました（実際の警報ではありません）');
}
function exportCsv() {
  const rows = [['発生時刻', '震源', '最大震度', 'M', '深さ(km)', '緯度', '経度', '津波', '種別', '情報源', 'コメント']];
  state.events.slice().sort((a, b) => b.t - a.t).forEach(e => rows.push([fmtJst(e.t), e.name, e.scale >= 10 ? scaleInfo(e.scale).plain : '不明', e.mag >= 0 ? e.mag.toFixed(1) : '', e.depth >= 0 ? e.depth : '', e.lat ?? '', e.lon ?? '', e.tsu, e.type, e.src, e.cm]));
  const csv = '\uFEFF' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const name = `地震履歴_${fmtJst(Date.now()).slice(0, 10).replace(/\//g, '')}.csv`, file = new File([csv], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => {}); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  toast(`${rows.length - 1}件の履歴を書き出しました`);
}

/* =========================================================
   情報タブ（地震 / 津波 / 噴火 / 備え）・引っ張って更新
   ========================================================= */
const fmtDT = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const tsuTop = (areas) => areas.reduce((m, a) => ((GRADE[a.grade]?.rank || 0) > (GRADE[m]?.rank || 0) ? a.grade : m), 'Unknown');
const etaText = (a) => (a.immediate ? 'ただちに来襲' : a.firstHeight && a.firstHeight.arrivalTime ? `第1波 ${String(a.firstHeight.arrivalTime).slice(-8, -3) || a.firstHeight.arrivalTime}` : (a.firstHeight && a.firstHeight.condition) || '');
const tsuHist = { items: [], loading: false, at: 0 };
const vol = { items: [], updated: 0, error: null, loading: false, primed: false, seen: new Set(load('eqm.volseen.v1', [])), dismissed: new Set() };
const VOL_ALERT = (x) => (x.kind === 'flash' || x.kind === 'warning');
let curTab = 'quake';

function areaRows(areas) {
  return [...areas].sort((a, b) => (GRADE[b.grade]?.rank || 0) - (GRADE[a.grade]?.rank || 0)).map(a => {
    const g = GRADE[a.grade] || GRADE.Unknown, eta = etaText(a), h = a.maxHeight && a.maxHeight.description || '';
    return `<li class="trow" data-rank="${g.rank}"><span class="gchip">${g.label.replace('津波', '')}</span><b>${esc(a.name)}</b><small>${[eta, h ? '予想 ' + esc(h) : ''].filter(Boolean).join(' ・ ') || '—'}</small></li>`;
  }).join('');
}
function renderTsunamiPanel() {
  const el = $('#tpTsunami'); if (!el) return;
  const ts = state.tsunami, on = ts && !ts.cancelled && ts.areas && ts.areas.length;
  let html = '';
  if (on) {
    const g = GRADE[tsuTop(ts.areas)] || GRADE.Unknown;
    html += `<section class="tcard" data-rank="${g.rank}"><div class="tcard__head"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg><div><b>${g.label}が発表されています</b><small>${esc(fmtDT.format(parseJst(ts.time)))}発表 ・ ${ts.areas.length}地域</small></div></div>
      <p class="tcard__act">ただちに海岸・河口から離れ、高い場所へ避難してください。津波は繰り返し来襲し、第1波が最大とは限りません。</p><ul class="trows">${areaRows(ts.areas)}</ul></section>`;
  } else {
    html += `<section class="tcard tcard--ok"><div class="tcard__head"><svg viewBox="0 0 24 24"><use href="#i-wave"/></svg><div><b>現在、津波に関する予報は発表されていません</b><small>${tsuHist.at ? esc(fmtHM.format(tsuHist.at)) + ' 確認' : 'リアルタイムで監視中'}</small></div></div></section>`;
  }
  const past = tsuHist.items.filter(m => !(on && ts.id === m.id)).slice(0, 12);
  html += `<h3 class="tsec">過去の発表<span class="en">HISTORY</span></h3>`;
  if (!past.length) html += `<p class="tempty">${tsuHist.loading ? '読み込み中…' : tsuHist.at ? '直近の津波予報の発表はありません' : '履歴を読み込めていません（下に引っ張って更新）'}</p>`;
  else html += past.map(m => {
    const off = m.cancelled || !(m.areas && m.areas.length), g = off ? null : (GRADE[tsuTop(m.areas)] || GRADE.Unknown);
    return `<details class="thist"><summary><span class="gchip" data-rank="${g ? g.rank : 0}">${g ? g.label.replace('津波', '') : '解除'}</span><b>${off ? '津波予報の解除' : g.label}</b><small>${esc(fmtDT.format(parseJst(m.time)))}${off ? '' : ` ・ ${m.areas.length}地域`}</small></summary>${off ? '' : `<ul class="trows">${areaRows(m.areas)}</ul>`}</details>`;
  }).join('');
  html += `<p class="tfoot">出典: P2P地震情報（気象庁の津波予報）。避難は気象庁・自治体の最新情報に従ってください。</p>`;
  el.innerHTML = html;
}
async function fetchTsunamiHistory() {
  if (tsuHist.loading) return; tsuHist.loading = true; renderTsunamiPanel();
  try {
    const r = await fetch(`${CFG.apiBase}/history?codes=552&limit=20`, { cache: 'no-store' });
    if (r.ok) { tsuHist.items = await r.json(); tsuHist.at = Date.now(); }
  } catch { /* 通信エラーは空表示のまま */ }
  tsuHist.loading = false; renderTsunamiPanel(); updateTabDots(); if (curTab === 'home') renderHomePanel();
}

/* ---- 噴火（中継サーバー経由で気象庁フィードを取得） ---- */
const VKIND = { flash: ['噴火速報', 'bad'], warning: ['噴火警報', 'bad'], obs: ['観測報', 'warn'], ash: ['降灰予報', 'warn'], info: ['解説情報', 'info'], forecast: ['噴火予報', 'dim'], other: ['火山情報', 'dim'] };
function renderVolcanoPanel() {
  const el = $('#tpVolcano'); if (!el) return;
  let html = `<div class="vbar"><span>${vol.updated ? '更新 ' + esc(fmtHM.format(vol.updated)) : (vol.loading ? '取得中…' : '')}</span><a class="btn btn--text btn--sm" href="https://www.jma.go.jp/bosai/map.html#contents=volcano" target="_blank" rel="noopener">気象庁の火山情報 ↗</a></div>`;
  if (!CFG.relayUrl) html += `<p class="tempty">噴火情報の表示には、config.js の relayUrl（中継サーバー）の設定が必要です。</p>`;
  else if (!vol.items.length) html += `<p class="tempty">${vol.loading ? '中継サーバーから取得中…（無料プランでは起動に1分ほどかかることがあります）' : vol.error ? `噴火情報を取得できません（${esc(vol.error)}）。中継サーバーが古い版か停止中の可能性があります。設定の「接続診断」で確認できます。` : '直近の火山に関する情報はありません'}</p>`;
  else {
    html += vol.items.slice(0, 30).map(x => {
      const [lab, cls] = VKIND[x.kind] || VKIND.other, t = Date.parse(x.updated);
      return `<article class="vcard vcard--${cls}"><div class="vcard__top"><span class="vkind vkind--${cls}">${esc(lab)}</span><b>${esc(x.name || x.title)}</b><small>${Number.isFinite(t) ? esc(fmtDT.format(t)) + ' ・ ' + esc(rel(t)) : ''}</small></div>
        ${x.summary ? `<p class="vcard__sum">${esc(x.summary)}</p>` : ''}${x.name && x.title ? `<small class="vcard__t">${esc(x.title)}${x.author ? ' ・ ' + esc(x.author) : ''}</small>` : ''}</article>`;
    }).join('');
    html += `<p class="tfoot">出典: 気象庁 防災情報XML。噴火警戒レベルや避難の判断は、気象庁・自治体の最新情報を必ず確認してください。</p>`;
  }
  el.innerHTML = html;
}
async function fetchVolcano() {
  if (!CFG.relayUrl || vol.loading) { renderVolcanoPanel(); return; }
  vol.loading = true; renderVolcanoPanel();
  try {
    const r = await withTimeout(fetch(CFG.relayUrl.replace(/\/$/, '') + '/volcano', { cache: 'no-store' }), 25000, 'タイムアウト');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    vol.items = Array.isArray(j.items) ? j.items : []; vol.updated = j.updated || Date.now(); vol.error = j.ok === false && !vol.items.length ? (j.error || 'フィード取得失敗') : null;
    const fresh = vol.items.filter(x => VOL_ALERT(x) && !vol.seen.has(x.id));
    if (vol.primed) fresh.forEach(alertVolcano);                       // 初回取得（過去分）では鳴らさない
    vol.items.forEach(x => vol.seen.add(x.id)); vol.primed = true;
    save('eqm.volseen.v1', [...vol.seen].slice(-200));
  } catch (e) { vol.error = e && e.message || '通信エラー'; }
  vol.loading = false; renderVolcanoPanel(); updateTabDots(); renderAlerts();
}
function alertVolcano(x) {
  const title = `${x.label}${x.name ? '：' + x.name : ''}`;
  flash(true); beep(true); toast(title);
  notify(title, (x.summary || x.title || '').slice(0, 120), 'volcano', true);
  speak(`${x.label}が発表されました。${x.name || ''}。`, true);
}
const volActive = () => vol.items.filter(x => VOL_ALERT(x) && Date.now() - Date.parse(x.updated) < 3 * 3600e3);

/* ---- 備え（オフラインでも読める行動の目安 + 持ち出し品チェック） ---- */
const PREP = [
  { id: 'eq', title: '地震', sub: '揺れている間・揺れが収まったら', items: ['頭を守り、丈夫な机の下など安全な場所へ。揺れが収まるまで動かない', '無理に火を消しに行かない。揺れが収まってから落ち着いて火の始末をする', '揺れが収まったら、ドアや窓を開けて出口を確保。ガラスの破片に注意して足元を守る', 'エレベーターでは全階のボタンを押し、止まった階で降りる', '屋外ではブロック塀・自動販売機・ガラス窓・看板から離れる', '海岸や川の近くでは、揺れが弱くても津波に備えて高い場所へ'] },
  { id: 'tsu', title: '津波', sub: '「揺れたら高台へ」警報を待たずに避難', items: ['強い揺れ、または弱くても長くゆっくりした揺れを感じたら、警報を待たずに高台・津波避難ビルへ', '海岸・河口付近から離れる。津波は川も遡る', '津波は繰り返し来襲し、第1波が最大とは限らない。警報・注意報が解除されるまで戻らない', '津波注意報でも海岸や海の中にいる人は、ただちに離れる', '車での避難は渋滞の恐れがある。地域の指示に従う'] },
  { id: 'vol', title: '噴火', sub: '噴火警戒レベルと自治体の避難情報を確認', items: ['火口周辺に近づかない。登山中は、ただちに山小屋や避難施設へ退避し、頭を守る', '噴石・火砕流・融雪型火山泥流は命に関わる。避難の指示には早めに従う', '降灰時は屋内に入り、マスクやゴーグルで目・鼻・口を守る', '降灰時の運転は視界不良やスリップの恐れがあるため控える'] }
];
const KIT = ['飲料水（1人1日3Lを目安に、最低3日分）', '非常食（3日分以上）', 'スマホの充電器・モバイルバッテリー', '懐中電灯・予備の電池', '携帯ラジオ', '常備薬・お薬手帳', '現金（小銭を含む）', 'マスク・衛生用品', '簡易トイレ', '笛（ホイッスル）', '軍手・底の厚い靴', '連絡先メモ・貴重品のコピー'];
function renderPrepPanel() {
  const el = $('#tpPrep'); if (!el) return;
  const done = settings.prep || {};
  el.innerHTML = `<button type="button" class="btn hq-shaken" data-prep-shaken>揺れた！ 行動ガイドを開く</button>
    <p class="tfoot" style="margin-top:0">一般的な目安です。お住まいの自治体の指示・ハザードマップを優先してください。</p>
    ${PREP.map(s => `<details class="pcard" ${s.id === 'eq' ? 'open' : ''}><summary><b>${s.title}</b><small>${s.sub}</small></summary><ul class="plist">${s.items.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>`).join('')}
    <details class="pcard" open><summary><b>持ち出し品チェック</b><small>${KIT.filter((_, i) => done['k' + i]).length}/${KIT.length} 準備済み</small></summary><ul class="plist plist--chk">${KIT.map((t, i) => `<li><label><input type="checkbox" data-k="k${i}" ${done['k' + i] ? 'checked' : ''}><span>${esc(t)}</span></label></li>`).join('')}</ul></details>
    ${shindoGuideHtml()}
    <details class="pcard"><summary><b>連絡・確認</b><small>安否確認と避難場所</small></summary><ul class="plist"><li>災害用伝言ダイヤル <b>171</b>（体験利用日あり）。家族で連絡方法を決めておく</li><li>ハザードマップで自宅・職場・通学路の危険と避難場所を確認 <a href="https://disaportal.gsi.go.jp/" target="_blank" rel="noopener">ハザードマップポータル ↗</a></li><li>近くの避難所を地図で探す <a href="${esc(shelterUrl())}" target="_blank" rel="noopener">地図で開く ↗</a></li></ul></details>`;
  { const sb = $('[data-prep-shaken]', el); if (sb) sb.onclick = openShaken; }
  $$('input[data-k]', el).forEach(c => c.onchange = () => { settings.prep = { ...(settings.prep || {}), [c.dataset.k]: c.checked }; saveSettings(); const sm = c.closest('details').querySelector('summary small'); if (sm) sm.textContent = `${KIT.filter((_, i) => settings.prep['k' + i]).length}/${KIT.length} 準備済み`; });
}

function updateTabDots() {
  const tsuOn = state.tsunami && !state.tsunami.cancelled && state.tsunami.areas && state.tsunami.areas.length;
  const set = (tab, on) => { const d = $(`.ltab[data-tab="${tab}"] .ltab__dot`); if (d) d.hidden = !on; };
  set('home', systemStatus().lv >= 3); set('tsunami', !!tsuOn); set('volcano', volActive().length > 0);
}
function setTab(name) {
  curTab = name;
  $$('.ltab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  const q = name === 'quake';
  $('.list-head').hidden = !q; $('#scroll').hidden = !q;
  $('#tpHome').hidden = name !== 'home'; $('#tpTsunami').hidden = name !== 'tsunami'; $('#tpVolcano').hidden = name !== 'volcano'; $('#tpPrep').hidden = name !== 'prep';
  if (name === 'home') { renderHomePanel(); fetchEewLog(); fetchTsunamiHistory(); }
  if (name === 'tsunami') { renderTsunamiPanel(); fetchTsunamiHistory(); }
  if (name === 'volcano') { renderVolcanoPanel(); fetchVolcano(); }
  if (name === 'prep') renderPrepPanel();
  $('#listPane').dataset.tab = name;
  if (settings.tab !== name) { settings.tab = name; saveSettings(); }
}

/* 引っ張って更新（iPad / iPhone の PWA には標準のものが無いため自前で実装）。ヘッダー・各タブのどこから引っ張っても動く */
function initPtr() {
  const pane = $('#listPane'), ind = $('#ptr'); let y0 = null, dy = 0, busy = false;
  const scroller = () => ({ home: $('#tpHome'), quake: $('#scroll'), tsunami: $('#tpTsunami'), volcano: $('#tpVolcano'), prep: $('#tpPrep') }[curTab]);
  const refresh = () => (curTab === 'home' ? Promise.all([fetchHistory(true), fetchEewLog()]) : curTab === 'tsunami' ? Promise.all([fetchTsunamiHistory(), fetchHistory(true)]) : curTab === 'volcano' ? fetchVolcano() : fetchHistory(false));
  const reset = () => { ind.hidden = true; ind.style.transform = 'translate(-50%, 0)'; ind.classList.remove('ready', 'spin'); y0 = null; dy = 0; };
  pane.addEventListener('touchstart', (e) => { const sc = scroller(); if (sc && sc.scrollTop <= 0 && !busy && e.touches.length === 1 && !e.target.closest('input, select, textarea')) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  pane.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const sc = scroller(); dy = e.touches[0].clientY - y0;
    if (dy <= 0 || (sc && sc.scrollTop > 0)) { if (dy <= 0) reset(); return; }
    ind.hidden = false; ind.style.transform = `translate(-50%, ${Math.min(70, dy * .45)}px)`;
    ind.classList.toggle('ready', dy > 90); ind.textContent = dy > 90 ? '離すと更新' : '↓ 引っ張って更新';
  }, { passive: true });
  const end = async () => {
    if (y0 == null) return;
    if (dy > 90 && !busy && curTab !== 'prep') {
      busy = true; ind.classList.add('spin'); ind.textContent = '更新中…';
      try { await refresh(); } catch { /* noop */ }
      setTimeout(() => { busy = false; reset(); }, 350);
    } else reset();
  };
  pane.addEventListener('touchend', end, { passive: true }); pane.addEventListener('touchcancel', reset, { passive: true });
}
function initTabs() {
  if (!$('.ltabs')) return;                                           // HTML が古いときは何もしない
  $$('.ltab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  initPtr();
  setTab(['home', 'quake', 'tsunami', 'volcano', 'prep'].includes(settings.tab) ? settings.tab : 'home');
  updateTabDots(); setTimeout(fetchVolcano, 3500);
  setInterval(() => { if (!document.hidden && CFG.relayUrl) fetchVolcano(); }, 120e3);
}
function wakeRelay() { if (CFG.relayUrl) fetch(CFG.relayUrl.replace(/\/$/, '') + '/healthz', { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); }   // スリープ中の中継サーバーを起こす

/* =========================================================
   ホーム / 現在地予想震度 / 見守り地点 / ティッカー
   ========================================================= */
const SCALE_NAME = { 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 50: '5強', 55: '6弱', 60: '6強', 70: '7' };
const prefMatch = (a, pref) => a.pref === pref || (!a.pref && String(a.name || '').startsWith(pref.replace(/[都道府県]$/, '')));

/** 緊急地震速報の都道府県単位の予想震度 → { to, from, txt } | null（その都道府県が対象地域に含まれないとき null） */
function eewPrefForecast(msg, prefName) {
  if (!msg || !prefName) return null;
  const areas = (msg.areas || []).filter(a => prefMatch(a, prefName));
  if (!areas.length) return null;
  let from = 0, to = 0, over = false;
  areas.forEach(a => {
    const f = SCALE_NAME[a.scaleFrom] ? a.scaleFrom : 0, t = SCALE_NAME[a.scaleTo] ? a.scaleTo : 0;
    if (a.scaleTo === 99) over = true;
    from = Math.max(from, f || t); to = Math.max(to, t || f);
  });
  if (!to && !from) return { to: 0, from: 0, txt: '不明' };
  const top = to || from;
  const txt = over ? `${SCALE_NAME[from] || SCALE_NAME[top]}以上` : (!from || from === top) ? `${SCALE_NAME[top]}程度` : `${SCALE_NAME[from]}〜${SCALE_NAME[top]}`;
  return { to: top, from, txt };
}

/** 全体の状態（ホームの大表示・タブの点・ティッカーで使う） */
function systemStatus() {
  const tsu = state.tsunami && !state.tsunami.cancelled && state.tsunami.areas && state.tsunami.areas.length ? (GRADE[tsuTop(state.tsunami.areas)] || GRADE.Unknown) : null;
  const vola = volActive();
  if (state.eew) return { lv: 3, label: '警戒', cls: 'bad', sub: `${state.eew.msg.drill ? '【訓練】' : ''}緊急地震速報が発表されています` };
  if (tsu && tsu.rank >= 3) return { lv: 3, label: '警戒', cls: 'bad', sub: `${tsu.label}が発表されています` };
  if (vola.length) return { lv: 3, label: '警戒', cls: 'bad', sub: `${vola[0].label}${vola[0].name ? '：' + vola[0].name : ''}` };
  if (tsu) return { lv: 2, label: '注意', cls: 'warn', sub: `${tsu.label}が発表されています` };
  const strong = state.events.filter(e => e.type !== 'Foreign' && Date.now() - e.t < 3600e3 && e.scale >= 45).sort((a, b) => b.scale - a.scale)[0];
  if (strong) return { lv: 2, label: '注意', cls: 'warn', sub: `1時間以内に最大震度${scaleInfo(strong.scale).plain}の地震（${strong.name || '震源調査中'}）` };
  if (state.status === 'offline') return { lv: 1, label: '接続なし', cls: 'dim', sub: 'オフラインです。キャッシュを表示しています' };
  if (state.status !== 'live') return { lv: 1, label: '接続中', cls: 'dim', sub: 'リアルタイム配信に接続しています' };
  return { lv: 0, label: '平常', cls: 'ok', sub: '現在、警戒すべき情報はありません' };
}

/* ---- 緊急地震速報の履歴（P2P 履歴 556 を発表イベントごとにまとめる） ---- */
const eewLog = { items: [], at: 0, loading: false };
async function fetchEewLog() {
  if (eewLog.loading) return; eewLog.loading = true;
  try {
    const r = await fetch(`${CFG.apiBase}/history?codes=556&limit=30`, { cache: 'no-store' });
    if (r.ok) {
      const ev = new Map();
      (await r.json()).forEach(m => {
        if (m.test) return;
        const id = (m.issue && m.issue.eventId) || m.id, o = ev.get(id) || { id, msg: m, cancelled: false };
        if (m.cancelled) o.cancelled = true; else if (!ev.has(id) || o.cancelled) o.msg = ev.has(id) ? o.msg : m;
        ev.set(id, o);
      });
      eewLog.items = [...ev.values()].filter(o => !o.msg.cancelled).slice(0, 6); eewLog.at = Date.now();
    }
  } catch { /* 通信エラーは前回の表示のまま */ }
  eewLog.loading = false; if (curTab === 'home') renderHomePanel();
}

/* ---- 見守り地点 ---- */
const placeStat = (p, d24) => {
  let best = null, n = 0;
  for (const e of d24) { const s = prefMap(e).get(p.prefName) || 0; if (s >= 10) { n++; if (!best || s > best.s) best = { s, e }; } }
  return { best, n, f: state.eew ? eewPrefForecast(state.eew.msg, p.prefName) : null };
};
function renderPlacesSettings() {
  const el = $('#placesList'); if (!el) return;
  const ps = settings.places || [];
  el.innerHTML = ps.length ? ps.map(p => `<div class="place"><b>${esc(p.name)}</b><small>${esc(p.prefName)}</small><button type="button" class="icon-btn icon-btn--sm" data-del="${esc(p.id)}" aria-label="${esc(p.name)}を削除"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button></div>`).join('') : '<p class="hint">まだ登録されていません。</p>';
  $$('[data-del]', el).forEach(b => b.onclick = () => { settings.places = (settings.places || []).filter(p => p.id !== b.dataset.del); saveSettings(); renderPlacesSettings(); renderHomePanel(); });
}
function initPlaces() {
  const sel = $('#placePref'); if (!sel) return;
  sel.innerHTML = G.PREFS.map(p => `<option value="${p[0]}">${esc(p[1])}</option>`).join('');
  $('#btnPlaceAdd').onclick = () => {
    const code = +sel.value, p = G.byCode.get(code); if (!p) return;
    if ((settings.places || []).length >= 4) { toast('見守り地点は最大4件です'); return; }
    const name = ($('#placeName').value || '').trim().slice(0, 12) || p[1];
    settings.places = [...(settings.places || []), { id: 'p' + Date.now().toString(36), name, pref: code, prefName: p[1] }];
    $('#placeName').value = ''; saveSettings(); renderPlacesSettings(); renderHomePanel(); toast(`${name}（${p[1]}）を追加しました`);
  };
  renderPlacesSettings();
}

/* ---- ホーム画面 ---- */
function renderHomePanel() {
  const el = $('#tpHome'); if (!el) return;
  const now = Date.now(), st = systemStatus();
  const evs = state.events.filter(e => e.type !== 'Foreign').sort((a, b) => b.t - a.t), latest = evs[0];
  const d24 = evs.filter(e => now - e.t < DAY), mx24 = d24.reduce((m, e) => Math.max(m, e.scale), 0);
  const tsuOn = state.tsunami && !state.tsunami.cancelled && state.tsunami.areas && state.tsunami.areas.length;
  let html = `<section class="hero hero--${st.cls}"><div class="hero__sig" aria-hidden="true"><i></i><i></i><i></i></div><div class="hero__txt"><small>SYSTEM STATUS</small><b>${esc(st.label)}</b><span>${esc(st.sub)}</span></div></section>`;

  /* 現在地 */
  if (settings.home) {
    const hn = homeName(), mine = d24.filter(e => homeScale(e) >= 10), mineMax = mine.reduce((m, e) => Math.max(m, homeScale(e)), 0);
    const fc = state.eew ? eewPrefForecast(state.eew.msg, hn) : null;
    html += `<section class="hcard"><h3>現在地<span class="en">LOCATION</span></h3><div class="hloc"><b>${esc(hn || '登録済み')}</b>
      ${fc ? `<span class="hloc__eew">緊急地震速報 予想震度 <b>${esc(fc.txt)}</b></span>` : mine.length ? `<span>24時間以内に ${mine.length}回揺れました（最大震度 <b>${esc(scaleInfo(mineMax).plain)}</b>）</span>` : '<span>24時間以内に揺れた地震はありません</span>'}</div></section>`;
  } else html += `<section class="hcard"><h3>現在地<span class="en">LOCATION</span></h3><p class="hsub">現在地を登録すると、緊急地震速報の予想震度とS波到達カウントダウン、震源までの距離を表示します。</p><button type="button" class="btn btn--tonal btn--sm" data-act="settings">設定を開く</button></section>`;

  /* 最新の地震 */
  if (latest) {
    const si = scaleInfo(latest.scale), dist = homeDist(latest), hs = homeScale(latest);
    html += `<section class="hcard"><h3>最新の地震<span class="en">LATEST</span></h3><button type="button" class="hlatest" data-ev="${esc(latest.id)}" style="--sc:${si.bg}">
      <span class="badge${si.plain.length > 1 ? ' two' : ''}" style="--c:${si.bg};--fg:${si.fg}"><span>${si.t}</span></span>
      <span class="hlatest__main"><b>${esc(latest.name || '震源調査中')}</b><small class="segs">${[latest.mag >= 0 ? 'M' + latest.mag.toFixed(1) : '', depthText(latest.depth, true), dist != null && dist < 3000 ? '約' + Math.round(dist) + 'km' : ''].filter(Boolean).map(s => `<span>${esc(s)}</span>`).join('')}</small><small class="segs"><span>${esc(fmtDT.format(latest.t))}</span><span data-rel="${latest.t}">${esc(rel(latest.t))}</span>${hs ? `<span>あなたの地域 震度${esc(scaleInfo(hs).plain)}</span>` : ''}</small></span><span class="hlatest__go" aria-hidden="true">›</span></button></section>`;
  }

  html += timelineHtml();

  /* 見守り地点 */
  const ps = settings.places || [];
  if (ps.length) {
    html += `<section class="hcard"><h3>見守り地点<span class="en">WATCH</span></h3><ul class="hplaces">${ps.map(p => {
      const s = placeStat(p, d24);
      const body = s.f ? `<span class="hp__eew">予想 <b>${esc(s.f.txt)}</b></span>` : s.best ? `<span class="badge hp__b" style="--c:${scaleInfo(s.best.s).bg};--fg:${scaleInfo(s.best.s).fg}"><span>${scaleInfo(s.best.s).t}</span></span><span class="hp__t">${s.n}回 ・ ${esc(rel(s.best.e.t))}</span>` : '<span class="hp__t hp__t--ok">24時間 揺れなし</span>';
      return `<li><span class="hp__n"><b>${esc(p.name)}</b><small>${esc(p.prefName)}</small></span><span class="hp__v">${body}</span></li>`;
    }).join('')}</ul></section>`;
  }

  /* 直近の集計 */
  const days = new Array(7).fill(0);
  evs.forEach(e => { const k = Math.floor((now - e.t) / DAY); if (k >= 0 && k < 7) days[6 - k]++; });
  const dmx = Math.max(1, ...days);
  html += `<section class="hcard"><h3>直近の傾向<span class="en">TREND</span></h3><div class="htiles"><div><small>24時間</small><b>${d24.length}</b><span>回</span></div><div><small>震度3以上</small><b>${d24.filter(e => e.scale >= 30).length}</b><span>回</span></div><div><small>最大震度</small><b>${mx24 >= 10 ? esc(scaleInfo(mx24).plain) : '—'}</b><span>24時間</span></div></div>
    <div class="hmini" aria-label="7日間の地震回数">${days.map((n, i) => `<span class="hmini__d" title="${n}回"><i style="height:${Math.max(n ? 8 : 2, n / dmx * 100)}%"></i><small>${i === 6 ? '今日' : (6 - i) + '日前'}</small></span>`).join('')}</div></section>`;

  /* 緊急地震速報の履歴 */
  html += `<section class="hcard"><h3>最近の緊急地震速報<span class="en">EEW LOG</span></h3>${eewLog.items.length ? `<ul class="heew">${eewLog.items.map(o => {
    const m = o.msg, h = (m.earthquake && m.earthquake.hypocenter) || {}, mx = Math.max(0, ...(m.areas || []).map(a => (SCALE_NAME[a.scaleTo] ? a.scaleTo : SCALE_NAME[a.scaleFrom] ? a.scaleFrom : 0)));
    const fc = settings.home ? eewPrefForecast(m, homeName()) : null;
    return `<li><span class="heew__t">${esc(fmtDT.format(parseJst(m.time)))}</span><b>${esc(h.name || '震源調査中')}</b><small>${h.magnitude > 0 ? 'M' + Number(h.magnitude).toFixed(1) + ' ・ ' : ''}予想最大震度 ${mx ? esc(SCALE_NAME[mx]) : '—'}${fc ? ` ・ ${esc(homeName())} ${esc(fc.txt)}` : ''}${o.cancelled ? ' ・ 取り消し' : ''}</small></li>`;
  }).join('')}</ul>` : `<p class="hsub">${eewLog.loading ? '読み込み中…' : eewLog.at ? '直近の緊急地震速報（警報）はありません' : '読み込めていません（下に引っ張って更新）'}</p>`}</section>`;

  html += `<div class="hquick"><button type="button" class="btn btn--sm hq-shaken" data-act="shaken">揺れた！ 行動ガイド</button><button type="button" class="btn btn--tonal btn--sm" data-act="monitor">リアルタイム監視</button><button type="button" class="btn btn--tonal btn--sm" data-act="drill">防災訓練</button><button type="button" class="btn btn--text btn--sm" data-act="settings">設定</button></div>`;
  el.innerHTML = html;
}

/* ---- ティッカー（NERV 端末風の流れるステータス） ---- */
function updateTicker() {
  const el = $('#ticker'); if (!el) return;
  const st = systemStatus(), evs = state.events.filter(e => e.type !== 'Foreign' && e.scale >= 10).sort((a, b) => b.t - a.t), l = evs[0];
  const tsuOn = state.tsunami && !state.tsunami.cancelled && state.tsunami.areas && state.tsunami.areas.length, va = volActive();
  const d24 = evs.filter(e => Date.now() - e.t < DAY), mx = d24.reduce((m, e) => Math.max(m, e.scale), 0);
  const items = [
    [`STATUS ${st.label}`, st.cls],
    l ? [`最新 ${fmtDT.format(l.t)} ${l.name || '震源調査中'}${l.mag >= 0 ? ' M' + l.mag.toFixed(1) : ''} 最大震度${scaleInfo(l.scale).plain}`, l.scale >= 45 ? 'warn' : ''] : ['最新 履歴を取得中', ''],
    [tsuOn ? `津波 ${(GRADE[tsuTop(state.tsunami.areas)] || GRADE.Unknown).label}発表中` : '津波 発表なし', tsuOn ? 'bad' : ''],
    [va.length ? `噴火 ${va[0].label}${va[0].name ? '：' + va[0].name : ''}` : '噴火 速報・警報なし', va.length ? 'bad' : ''],
    [`24時間 ${d24.length}回${mx >= 10 ? ' 最大震度' + scaleInfo(mx).plain : ''}`, '']
  ];
  const html = items.map(([t, c]) => `<span class="tk ${c}">${esc(t)}</span>`).join('<i class="tk__sep">◆</i>');
  if (el.dataset.h === html) return; el.dataset.h = html;
  el.innerHTML = `<div class="ticker__track" style="--dur:${Math.max(26, Math.round(html.length * .11))}s"><div>${html}<i class="tk__sep">◆</i></div><div aria-hidden="true">${html}<i class="tk__sep">◆</i></div></div>`;
}
function refreshInfoViews() { if (curTab === 'home') renderHomePanel(); updateTabDots(); updateTicker(); }

/* 震度別の観測点数（詳細パネル用） */
function scaleDist(ev) {
  const c = new Map(); (ev.pts || []).forEach(([, , s]) => { const k = s === 46 ? 45 : s; c.set(k, (c.get(k) || 0) + 1); });
  const keys = [70, 60, 55, 50, 45, 40, 30, 20, 10].filter(k => c.get(k)); if (!keys.length) return '';
  const mx = Math.max(...keys.map(k => c.get(k)));
  return `<div class="sdist" aria-label="震度別の観測点数">${keys.map(k => { const si = scaleInfo(k); return `<div class="sdist__row"><span class="badge" style="--c:${si.bg};--fg:${si.fg}"><span>${si.t}</span></span><span class="track"><i style="width:${(c.get(k) / mx * 100).toFixed(1)}%;background:${si.bg}"></i></span><b>${c.get(k)}</b></div>`; }).join('')}<small>震度別の観測地点数</small></div>`;
}
function initHome() {
  const clock = $('#hdrClock'), tick = () => { if (clock) clock.textContent = new Date().toLocaleTimeString('ja-JP', { hour12: false, timeZone: 'Asia/Tokyo' }) + ' JST'; };
  tick(); setInterval(tick, 1000);
  setInterval(updateTicker, 5000);
  const home = $('#tpHome');
  if (home) home.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act],[data-ev],[data-tab]'); if (!b) return;
    if (b.dataset.tab) { setTab(b.dataset.tab); return; }
    if (b.dataset.ev) { setTab('quake'); const it = $(`.item[data-id="${CSS.escape(b.dataset.ev)}"]`); if (it) { it.click(); it.scrollIntoView({ block: 'center' }); } return; }
    if (b.dataset.act === 'monitor') openMonitor();
    else if (b.dataset.act === 'shaken') openShaken();
    else if (b.dataset.act === 'drill') startDrill();
    else if (b.dataset.act === 'settings') $('#btnSettings').click();
  });
  initPlaces(); updateTicker();
}

/* =========================================================
   タイムライン / 余震・関連地震 / 揺れた！行動ガイド / 震度の目安 / 画像で共有
   ========================================================= */
const fmtOffset = (ms) => {
  const m = Math.round(Math.abs(ms) / 60e3);
  if (m < 60) return `${Math.max(1, m)}分`;
  if (m < 1440) return `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}`;
  return `${Math.floor(m / 1440)}日${Math.floor((m % 1440) / 60)}時間`;
};
const shelterUrl = () => {
  const h = settings.home, q = encodeURIComponent('避難所');
  return h ? `https://www.google.com/maps/search/${q}/@${h.lat.toFixed(4)},${h.lon.toFixed(4)},14z` : `https://www.google.com/maps/search/${q}`;
};

/* ---- 余震・関連地震（読み込み済みの履歴から、同じ震源域の前後の地震を拾う） ---- */
function relatedQuakes(ev) {
  if (ev.lat == null || ev.type === 'Foreign') return null;
  const R = ev.mag >= 6 ? 150 : ev.mag >= 5 ? 90 : 50;                 // 震源域とみなす半径(km)の目安
  const rel = state.events.filter(e => e.id !== ev.id && e.lat != null && e.type !== 'Foreign' && e.t > ev.t - DAY && e.t < ev.t + 7 * DAY && G.haversine(ev.lat, ev.lon, e.lat, e.lon) <= R);
  if (!rel.length) return null;
  return { R, before: rel.filter(e => e.t < ev.t), after: rel.filter(e => e.t > ev.t), all: rel };
}
function relatedHtml(ev) {
  const r = relatedQuakes(ev); if (!r) return '';
  const mx = r.all.reduce((m, e) => Math.max(m, e.scale), 0), mm = r.all.reduce((m, e) => Math.max(m, e.mag), -1);
  const rows = r.all.slice().sort((a, b) => Math.abs(a.t - ev.t) - Math.abs(b.t - ev.t)).slice(0, 6).sort((a, b) => a.t - b.t);
  return `<div class="rel"><h4>同じ震源域の地震<span class="en">RELATED</span></h4>
    <p class="rel__sum">半径約${r.R}km ・ この地震の前24時間 <b>${r.before.length}件</b> ／ 以降7日間 <b>${r.after.length}件</b>${mx >= 10 ? ` ・ 最大 震度${esc(scaleInfo(mx).plain)}${mm >= 0 ? ' / M' + mm.toFixed(1) : ''}` : ''}</p>
    <div class="rel__rows">${rows.map(e => { const si = scaleInfo(e.scale); return `<button type="button" class="relrow" data-rel-ev="${esc(e.id)}"><span class="badge" style="--c:${si.bg};--fg:${si.fg}"><span>${si.t}</span></span><span class="relrow__t"><b>${esc(e.name || '震源調査中')}${e.mag >= 0 ? ' M' + e.mag.toFixed(1) : ''}</b><small>この地震の${fmtOffset(e.t - ev.t)}${e.t < ev.t ? '前' : '後'}</small></span></button>`; }).join('')}</div>
    <small class="rel__note">読み込み済みの履歴 ${state.events.length}件からの集計です。直後の余震は震度が小さくても発表されないことがあります。</small></div>`;
}

/* ---- タイムライン（地震・津波・噴火・緊急地震速報を時系列で） ---- */
function timelineItems() {
  const items = [];
  state.events.filter(e => e.type !== 'Foreign').forEach(e => {
    const si = scaleInfo(e.scale);
    items.push({ t: e.t, kind: 'quake', ev: e.id, c: si.bg, fg: si.fg, tag: e.scale >= 10 ? `震度${si.plain}` : '震度不明', title: e.name || '震源調査中', sub: [e.mag >= 0 ? 'M' + e.mag.toFixed(1) : '', depthText(e.depth, true)].filter(Boolean).join(' ・ ') });
  });
  const ts = new Map(); [state.tsunami, ...tsuHist.items].filter(Boolean).forEach(m => ts.set(m.id, m));
  ts.forEach(m => {
    const t = parseJst(m.time); if (!Number.isFinite(t)) return;
    const off = m.cancelled || !(m.areas && m.areas.length), g = off ? null : (GRADE[tsuTop(m.areas)] || GRADE.Unknown);
    items.push({ t, kind: 'tsunami', tab: 'tsunami', c: g ? (g.rank >= 4 ? 'var(--major-bg)' : g.rank === 3 ? 'var(--eew-bg)' : 'var(--md-tertiary)') : 'var(--md-outline)', tag: g ? g.label.replace('津波', '') : '解除', title: off ? '津波予報の解除' : `${g.label}を発表`, sub: off ? '' : `${m.areas.length}地域` });
  });
  vol.items.filter(x => ['flash', 'warning', 'obs'].includes(x.kind)).forEach(x => {
    const t = Date.parse(x.updated); if (!Number.isFinite(t)) return;
    items.push({ t, kind: 'volcano', tab: 'volcano', c: VOL_ALERT(x) ? 'var(--md-error)' : 'var(--md-tertiary)', tag: x.kind === 'obs' ? '観測報' : x.label, title: x.name || x.title, sub: x.kind === 'obs' ? '噴火に関する火山観測報' : '' });
  });
  eewLog.items.forEach(o => {
    const t = parseJst(o.msg.time); if (!Number.isFinite(t)) return;
    const h = (o.msg.earthquake && o.msg.earthquake.hypocenter) || {};
    items.push({ t, kind: 'eew', tab: 'home', c: 'var(--eew-bg)', tag: '緊急地震速報', title: h.name || '震源調査中', sub: h.magnitude > 0 ? 'M' + Number(h.magnitude).toFixed(1) : '' });
  });
  return items.sort((a, b) => b.t - a.t).slice(0, 14);
}
function timelineHtml() {
  const items = timelineItems(); if (!items.length) return '';
  return `<section class="hcard"><h3>タイムライン<span class="en">TIMELINE</span></h3><ol class="tline">${items.map(i => `<li class="tl tl--${i.kind}"><button type="button" ${i.ev ? `data-ev="${esc(i.ev)}"` : i.tab !== 'home' ? `data-tab="${i.tab}"` : 'disabled'} style="--tc:${i.c};--tf:${i.fg || '#fff'}"><time>${esc(fmtDT.format(i.t))}</time><span class="tl__main"><b>${esc(i.title)}</b>${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</span><span class="tl__tag">${esc(i.tag)}</span></button></li>`).join('')}</ol></section>`;
}

/* ---- 揺れた！ 行動ガイド ---- */
const SHAKEN_STEPS = [
  ['揺れている間', '頭を守り、丈夫な机の下など安全な場所へ。無理に動かず、揺れが収まるのを待つ'],
  ['火の始末', '揺れが収まってから、落ち着いて火を消す。ガスの元栓を閉める'],
  ['出口を確保', 'ドアや窓を開けて避難口を確保。ガラスの破片に注意して、靴を履く'],
  ['海岸・川の近くなら', '警報を待たず、ただちに高台や津波避難ビルへ'],
  ['情報を確認', '津波・余震の情報を確認。ラジオや自治体の情報も参考にする'],
  ['家族の安否', '通話は控えてメッセージを使うか、災害用伝言ダイヤル171を利用'],
  ['避難が必要なとき', '建物の損傷、ガスのにおい、火災があれば、ブレーカーを切って安全な場所へ避難']
];
const shaken = { t0: 0, iv: 0 };
function shakenStatusHtml() {
  const now = Date.now(), chips = [];
  const l = state.events.filter(e => e.type !== 'Foreign' && e.scale >= 10).sort((a, b) => b.t - a.t)[0];
  if (state.eew) chips.push(['bad', '緊急地震速報 発表中']);
  const tsu = state.tsunami && !state.tsunami.cancelled && state.tsunami.areas && state.tsunami.areas.length ? (GRADE[tsuTop(state.tsunami.areas)] || GRADE.Unknown) : null;
  chips.push(tsu ? ['bad', `${tsu.label} 発表中`] : ['ok', '津波予報: 発表なし']);
  if (l && now - l.t < 30 * 60e3) chips.push(['warn', `直近の地震: 震度${scaleInfo(l.scale).plain} ${l.name || '震源調査中'}（${fmtOffset(now - l.t)}前）`]);
  else chips.push(['dim', '直近30分の地震情報はありません（発表まで数分かかります）']);
  if (l && l.scale >= 45 && now - l.t < 3 * DAY) chips.push(['warn', '余震に注意してください']);
  return chips.map(([c, t]) => `<span class="pill pill--${c === 'dim' ? 'warn' : c}">${esc(t)}</span>`).join('');
}
function openShaken() {
  const d = $('#shaken'); if (!d) return;
  $$('dialog[open]').forEach(x => x.close());
  shaken.t0 = Date.now();
  $('#shakenBody').innerHTML = `<div class="sk__top"><div class="sk__timer"><small>経過時間</small><b id="skT">00:00</b></div><div id="skStatus" class="sk__status"></div></div>
    <p class="sk__hint">落ち着いて、上から順に確認してください。チェックは目安です。</p>
    <ol class="sk__steps">${SHAKEN_STEPS.map(([t, s], i) => `<li><label><input type="checkbox"><span class="sk__n">${i + 1}</span><span class="sk__txt"><b>${esc(t)}</b><small>${esc(s)}</small></span></label></li>`).join('')}</ol>
    <div class="sk__acts"><button type="button" class="btn btn--tonal" data-sk="tsunami">津波情報を見る</button><button type="button" class="btn btn--tonal" data-sk="latest">最新の地震を見る</button><a class="btn btn--tonal" href="${esc(shelterUrl())}" target="_blank" rel="noopener">避難所を地図で探す ↗</a></div>
    <p class="tfoot">命に関わるときは 119（消防・救急）/ 110（警察）。</p>`;
  const tick = () => {
    const s = Math.floor((Date.now() - shaken.t0) / 1000), el = $('#skT'); if (!el) return;
    el.textContent = `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
    const st = $('#skStatus'), h = shakenStatusHtml(); if (st.dataset.h !== h) { st.dataset.h = h; st.innerHTML = h; }
  };
  tick(); clearInterval(shaken.iv); shaken.iv = setInterval(tick, 1000);
  d.showModal();
}
function closeShaken() { clearInterval(shaken.iv); const d = $('#shaken'); if (d && d.open) d.close(); }

/* ---- 震度の目安（気象庁の震度階級関連解説表を要約） ---- */
const SHINDO_GUIDE = [
  [0, '揺れを感じない。地震計には記録される'], [10, '屋内で静かにしていると、わずかに揺れを感じる人がいる'],
  [20, '屋内で静かにしている人の大半が揺れを感じる。吊り下げ物がわずかに揺れる'], [30, '屋内のほとんどの人が揺れを感じる。棚の食器が音を立てることがある'],
  [40, 'ほとんどの人が驚く。吊り下げ物が大きく揺れ、座りの悪い物が倒れることがある'], [45, '大半の人が恐怖を覚え、物につかまりたくなる。食器や本が落ち、固定していない家具が動くことがある'],
  [50, '物につかまらないと歩くのが難しい。落ちる物が多くなり、固定していない家具が倒れることがある。補強のないブロック塀が崩れることがある'],
  [55, '立っているのが困難。固定していない家具の大半が動き、倒れるものもある。ドアが開かなくなることがある。壁のタイルや窓ガラスが壊れ、落ちることがある'],
  [60, 'はわないと動けない。飛ばされることもある。固定していない家具のほとんどが動き、倒れる。耐震性の低い木造建物は傾いたり倒れたりするものが多くなる'],
  [70, '耐震性の高い建物でも傾くことがある。大きな地割れや地すべり、山の崩壊が起きることがある']
];
function shindoGuideHtml() {
  return `<details class="pcard"><summary><b>震度の目安</b><small>揺れの強さと、起きること</small></summary><ul class="shindo">${SHINDO_GUIDE.map(([v, t]) => { const si = v ? scaleInfo(v) : { bg: '#8a8f98', fg: '#fff', t: '0' }; return `<li><span class="badge" style="--c:${si.bg};--fg:${si.fg}"><span>${si.t}</span></span><span>${esc(t)}</span></li>`; }).join('')}</ul><p class="tfoot" style="padding:0 16px 14px">気象庁「震度階級関連解説表」を要約。実際の被害は、建物の耐震性や地盤などで変わります。</p></details>`;
}

/* ---- 画像で共有（NERV 風のカード） ---- */
async function shareImage(ev) {
  try { await document.fonts.ready; } catch { /* noop */ }
  const W = 1200, H = 630, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d'), si = scaleInfo(ev.scale, ev.type === 'Foreign');
  const SANS = '"Roboto Flex","Noto Sans JP","Hiragino Sans","Noto Sans CJK JP",sans-serif', SERIF = '"Shippori Mincho B1","Hiragino Mincho ProN","Noto Serif CJK JP",serif';
  c.fillStyle = '#050506'; c.fillRect(0, 0, W, H);
  c.strokeStyle = 'rgba(255,138,31,.09)'; c.lineWidth = 1; c.beginPath();
  for (let x = 0; x <= W; x += 48) { c.moveTo(x + .5, 0); c.lineTo(x + .5, H); } for (let y = 0; y <= H; y += 48) { c.moveTo(0, y + .5); c.lineTo(W, y + .5); } c.stroke();
  const stripe = (y) => { c.save(); c.beginPath(); c.rect(0, y, W, 16); c.clip(); for (let x = -40; x < W + 40; x += 32) { c.fillStyle = (x / 32) % 2 ? '#0b0b0b' : '#ffc400'; c.beginPath(); c.moveTo(x, y + 16); c.lineTo(x + 16, y); c.lineTo(x + 32, y); c.lineTo(x + 16, y + 16); c.fill(); } c.restore(); };
  stripe(0); stripe(H - 16);
  c.textBaseline = 'alphabetic'; c.fillStyle = '#ff9a3c'; c.font = `700 24px ${SANS}`; c.fillText('SEISMIC REPORT', 70, 84);
  c.fillStyle = '#f2eeee'; c.font = `800 40px ${SERIF}`; c.fillText('地震情報', 70, 132);
  c.textAlign = 'right'; c.fillStyle = '#b9b2b2'; c.font = `600 26px ${SANS}`; c.fillText(fmtFull.format(ev.t) + ' 頃発生', W - 70, 112); c.textAlign = 'left';
  const bx = 70, by = 170, bs = 300;
  c.fillStyle = si.bg; c.beginPath(); c.roundRect(bx, by, bs, bs, 56); c.fill();
  c.fillStyle = si.fg; c.textAlign = 'center'; c.font = `600 28px ${SANS}`; c.fillText('最大震度', bx + bs / 2, by + 62);
  c.font = `900 ${si.plain.length > 2 ? 104 : 150}px ${SANS}`; c.fillText(si.plain, bx + bs / 2, by + 220); c.textAlign = 'left';
  const x0 = 420; let y = 230;
  c.fillStyle = '#ffffff'; c.font = `800 62px ${SERIF}`;
  let name = ev.name || '震源調査中'; while (c.measureText(name).width > W - x0 - 70 && name.length > 3) name = name.slice(0, -1); c.fillText(name, x0, y);
  y += 70; c.font = `700 40px ${SANS}`; c.fillStyle = '#ffd9b0';
  c.fillText([ev.mag >= 0 ? 'M ' + ev.mag.toFixed(1) : '', depthText(ev.depth, true)].filter(Boolean).join('   ／   ') || '規模・深さは調査中', x0, y);
  const dist = homeDist(ev), hs = homeScale(ev); y += 62; c.font = `600 30px ${SANS}`; c.fillStyle = '#b9b2b2';
  if (hs && settings.home) c.fillText(`${homeName()}では 震度${scaleInfo(hs).plain}`, x0, y);
  else if (dist != null && settings.home && dist < 3000) c.fillText(`現在地から約${Math.round(dist)}km`, x0, y);
  y += 56; c.fillStyle = ev.tsu && ev.tsu !== 'None' && ev.tsu !== 'Unknown' ? '#ff6b5e' : '#7ee0a8'; c.font = `700 30px ${SANS}`;
  c.fillText((TSU_LABEL[ev.tsu] || TSU_LABEL.Unknown)[0], x0, y);
  c.fillStyle = '#7d7777'; c.font = `500 22px ${SANS}`; c.fillText('地震速報 ・ 出典: P2P地震情報 / 気象庁', 70, H - 40);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png')); if (!blob) { toast('画像を作成できませんでした'); return; }
  const file = new File([blob], `地震情報_${fmtJst(ev.t).replace(/[\/: ]/g, '').slice(0, 12)}.png`, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: '地震情報', text: shareText(ev) }); } catch { /* 取り消し */ } return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); toast('画像を保存しました');
}

/* ---------------- 起動 ---------------- */
function init() {
  applyTheme();
  initMap();
  initSettingsUI();
  renderLegend();
  // 新機能のボタン: HTML が古くて要素が無くても、他のボタンの初期化を止めない
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
  on('#btnMon', 'click', openMonitor);
  on('#monClose', 'click', () => $('#monitor').close());
  on('#monitor', 'close', () => { mon.open = false; cancelAnimationFrame(mon.raf); });
  on('#btnDiag', 'click', runDiag);
  on('#btnDrill', 'click', startDrill);
  on('#btnCsv', 'click', exportCsv);
  on('#btnTestTopic', 'click', testTopic);
  on('#shakenClose', 'click', closeShaken);
  on('#shaken', 'close', () => clearInterval(shaken.iv));
  on('#shakenBody', 'click', (e) => { const b = e.target.closest('[data-sk]'); if (!b) return; closeShaken(); if (b.dataset.sk === 'tsunami') setTab('tsunami'); else { setTab('quake'); const f = $('.item'); if (f) f.click(); } });
  initTabs(); initHome(); wakeRelay();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeRelay(); });
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
  $('#statsPeriod').addEventListener('click', e => { const c = e.target.closest('.chip'); if (!c) return; statsDays = +c.dataset.v; openStats.redraw && 0; $$('#statsPeriod .chip').forEach(x => x.setAttribute('aria-checked', String(x === c))); const draw = () => ST.render($('#statsBody'), state.events, statsDays, Date.now(), { end: state.histEnd }); draw(); ensureLoadedUntil(Date.now() - statsDays * DAY, 20, draw).then(() => $('#stats').open && draw()); });
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
  if (settings.push) setTimeout(() => refreshPush().catch(e => console.warn('[push]', e && e.message)), 2500);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'notification-click') setView('list'); });
  }
}
/* ---------------- 起動ガード: ファイルの版ずれ / 初期化エラーを画面に出す ---------------- */
const APP_VER = '2.5.0';
async function fileProblems() {                      // 読み込めなかった js ファイルの原因（404 など）を調べる
  const out = [];
  for (const [f, ok] of [['js/geo.js', GEO_OK], ['js/stats.js', !!(window.Stats && window.Stats.render)]]) {
    if (ok) continue;
    let st = '通信エラー';
    try { const r = await fetch(f + '?chk=' + Date.now(), { cache: 'no-store' }); st = r.ok ? '取得はできるが中身が正しくありません（別のファイルが入っている可能性）' : `HTTP ${r.status}（リポジトリに ${f} がありません）`; } catch { /* keep */ }
    out.push(`${f}: ${st}`);
  }
  return out;
}
function banner(html) {
  let b = $('#eqmBanner');
  if (!b) { b = document.createElement('div'); b.id = 'eqmBanner'; b.setAttribute('role', 'alert'); document.body.appendChild(b); }
  b.innerHTML = `<div class="eqmb__msg">${html}</div><div class="eqmb__act"><button type="button" id="eqmBannerBtn">キャッシュを消して再読み込み</button><button type="button" id="eqmBannerX" class="eqmb__x" aria-label="閉じる">×</button></div>`;
  $('#eqmBannerBtn').onclick = hardReload;
  $('#eqmBannerX').onclick = () => b.remove();
}
async function hardReload() {
  try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); } catch { /* noop */ }
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* noop */ }
  location.replace(location.pathname + '?r=' + Date.now());
}
function versionMismatch() {
  const bad = [], mv = ($('meta[name="app-version"]') || {}).content || '';
  const cv = getComputedStyle(document.documentElement).getPropertyValue('--app-ver').replace(/["'\s]/g, '');
  if (mv !== APP_VER) bad.push('index.html');
  if (cv !== APP_VER) bad.push('css/app.css');
  return bad;
}
try {
  const bad = versionMismatch();
  if (bad.length) {
    // まず自動でキャッシュを消して1回だけ再読み込み。それでも直らなければアップロード漏れなので画面に表示
    if (!sessionStorage.getItem('eqm.healed')) { sessionStorage.setItem('eqm.healed', '1'); hardReload(); }
    else banner(`⚠ ${bad.join(' / ')} が古いままです。GitHub に最新版（js/app.js と同じ v${APP_VER}）をアップロードしてください。`);
  } else sessionStorage.removeItem('eqm.healed');
  init();
  if (!GEO_OK || !(window.Stats && window.Stats.render)) fileProblems().then(p => { if (p.length) banner('⚠ 一部のファイルを読み込めないため簡易モードで動作中です。<br>' + p.map(esc).join('<br>')); });
} catch (e) {
  console.error(e); banner(`⚠ 初期化エラー: ${esc(e && e.message || e)}`);
}
})();
