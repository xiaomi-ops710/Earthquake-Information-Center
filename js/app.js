/* 地震・津波速報 – P2P地震情報 API クライアント */
(() => {
'use strict';

const CFG = Object.assign({
  apiBase: 'https://api.p2pquake.net/v2',
  wsUrl: 'wss://api.p2pquake.net/v2/ws',
  historyLimit: 100, firebase: {}, vapidKey: '', relayUrl: ''
}, self.APP_CONFIG || {});

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- localStorage（例外を握りつぶす） ---------------- */
const K = { events: 'eqm.events.v1', tsunami: 'eqm.tsunami.v1', settings: 'eqm.settings.v1', seen: 'eqm.seen.v1' };
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

/* ---------------- 状態 ---------------- */
const settings = Object.assign(
  { notify: true, sound: true, wake: false, minScale: 30, filter: 'all', push: false, pushToken: null },
  load(K.settings, {})
);
const state = {
  events: load(K.events, []),          // 正規化済み地震（新しい順に表示時ソート）
  tsunami: load(K.tsunami, null),
  eew: null,
  selected: null,
  newIds: new Set(),
  unread: 0,
  status: 'connecting'
};
const seenIds = new Set(load(K.seen, []));

/* ---------------- 震度表現 ---------------- */
const SCALE = {
  10: ['1', '#9fb6d6', '#0b1a2e'], 20: ['2', '#62a8f0', '#031a30'], 30: ['3', '#62d68f', '#05210f'],
  40: ['4', '#f4d94e', '#2a2200'], 45: ['5弱', '#ffab4d', '#331a00'], 46: ['5弱<small>以上</small>', '#ffab4d', '#331a00'],
  50: ['5強', '#ff7a3d', '#330d00'], 55: ['6弱', '#ff4d55', '#ffffff'], 60: ['6強', '#d6246e', '#ffffff'],
  70: ['7', '#a24dff', '#ffffff']
};
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
  MajorWarning: { label: '大津波警報', cls: 'alert--major', rank: 4 },
  Warning: { label: '津波警報', cls: '', rank: 3 },
  Watch: { label: '津波注意報', cls: 'alert--watch', rank: 2 },
  Unknown: { label: '津波予報', cls: 'alert--watch', rank: 1 }
};

/* ---------------- 時刻ユーティリティ ---------------- */
function parseJst(s) {
  const m = String(s || '').match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0)) : NaN;
}
const fmtMD = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtHM = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtFull = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function rel(ms) {
  const d = Math.max(0, Date.now() - ms) / 1000;
  if (d < 60) return 'たった今';
  if (d < 3600) return `${Math.floor(d / 60)}分前`;
  if (d < 86400) return `${Math.floor(d / 3600)}時間前`;
  return `${Math.floor(d / 86400)}日前`;
}

/* ---------------- 正規化 ---------------- */
const validCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat > -90 && lat < 90 && lon > -180 && lon < 180 && !(lat === 0 && lon === 0);
function normQuake(m) {
  const e = m.earthquake || {}, h = e.hypocenter || {};
  const lat = Number(h.latitude), lon = Number(h.longitude);
  const t = parseJst(e.time), it = parseJst((m.issue && m.issue.time) || m.time);
  return {
    id: m.id, ids: [m.id], key: String(e.time || '').slice(0, 16),
    t: Number.isFinite(t) ? t : it, it: Number.isFinite(it) ? it : t,
    name: h.name || '', lat: validCoord(lat, lon) ? lat : null, lon: validCoord(lat, lon) ? lon : null,
    depth: Number.isFinite(h.depth) ? h.depth : -1, mag: Number.isFinite(h.magnitude) ? h.magnitude : -1,
    scale: Number.isFinite(e.maxScale) ? e.maxScale : -1,
    tsu: e.domesticTsunami || 'Unknown',
    type: (m.issue && m.issue.type) || 'Other',
    pts: Array.isArray(m.points) && m.points.length ? m.points.map(p => [p.pref || '', p.addr || '', p.scale]) : null
  };
}
function mergeInto(list, n) {
  const i = list.findIndex(a => Math.abs(a.t - n.t) < 60000 && (!a.name || !n.name || a.name === n.name));
  if (i < 0) { list.push(n); return { ev: n, created: true, scaleUp: false }; }
  const a = list[i];
  if (a.ids.includes(n.id)) return { ev: a, created: false, scaleUp: false };
  const [base, other] = n.it >= a.it ? [n, a] : [a, n];
  const merged = {
    ...other, ...base,
    ids: [...new Set([...a.ids, ...n.ids])],
    name: base.name || other.name,
    lat: base.lat ?? other.lat, lon: base.lon ?? other.lon,
    depth: base.depth >= 0 ? base.depth : other.depth,
    mag: base.mag >= 0 ? base.mag : other.mag,
    scale: Math.max(a.scale, n.scale),
    pts: base.pts || other.pts,
    t: a.t
  };
  merged.t = base.name ? base.t : other.name ? other.t : a.t;
  list[i] = merged;
  return { ev: merged, created: false, scaleUp: n.scale > a.scale, filled: !a.name && !!merged.name };
}

function persist() {
  state.events.sort((a, b) => b.t - a.t);
  state.events.length = Math.min(state.events.length, CFG.historyLimit);
  // 容量対策: 直近30件以外は観測点を保存しない
  const slim = state.events.map((e, i) => (i < 30 ? e : { ...e, pts: null }));
  if (!save(K.events, slim)) save(K.events, slim.slice(0, 40).map(e => ({ ...e, pts: null })));
  save(K.tsunami, state.tsunami);
  save(K.seen, [...seenIds].slice(-400));
}

/* ---------------- 地図 ---------------- */
let map = null, layer = null; const markers = new Map();
const JP_BOUNDS = [[24, 122], [46, 148]];
function initMap() {
  if (!window.L) { $('#map').innerHTML = '<p class="empty">地図ライブラリを読み込めませんでした。オンラインで一度開くとオフラインでも表示されます。</p>'; return; }
  map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true, minZoom: 3, maxZoom: 12, preferCanvas: false });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19, crossOrigin: true,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.fitBounds(JP_BOUNDS, { padding: [10, 10] });
  new ResizeObserver(() => map.invalidateSize()).observe($('#mapPane'));
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
function renderMarkers(pulseId) {
  if (!map) return;
  layer.clearLayers(); markers.clear();
  [...state.events].reverse().forEach(ev => {
    if (ev.lat == null) return;
    const m = L.marker([ev.lat, ev.lon], { icon: markerIcon(ev, ev.id === pulseId || (ev.id === latestId() && Date.now() - ev.t < 600000)), keyboard: false, zIndexOffset: Math.max(0, ev.scale) * 10 });
    m.on('click', () => select(ev.id, { fly: false, scrollList: true }));
    m.addTo(layer); markers.set(ev.id, m);
  });
}
const latestId = () => (state.events[0] && state.events[0].id);

/* ---------------- 一覧描画 ---------------- */
const filterFn = { all: () => true, s3: e => e.scale >= 30, s5: e => e.scale >= 45 };
function renderList() {
  const ol = $('#list'), top = ol.scrollTop;
  const items = state.events.filter(filterFn[settings.filter] || filterFn.all);
  $('#empty').hidden = items.length > 0;
  ol.innerHTML = items.map(ev => {
    const si = scaleInfo(ev.scale, ev.type === 'Foreign');
    const tl = TSU_LABEL[ev.tsu] || TSU_LABEL.Unknown;
    const tsuTag = tl[1] === 'ok' ? '' : `<span class="tag ${tl[1] === 'watch' ? 'tag--watch' : ''}">${ev.tsu === 'Checking' ? '津波調査中' : ev.tsu === 'Watch' ? '津波注意' : '津波警戒'}</span>`;
    const title = ev.name || (ev.type === 'ScalePrompt' ? '震度速報（震源調査中）' : '震源調査中');
    const meta = [ev.mag >= 0 ? `M${ev.mag.toFixed(1)}` : 'M不明', depthText(ev.depth, true)].map(esc).join(' · ');
    const isNew = state.newIds.has(ev.id);
    return `<li><button class="item${isNew ? ' enter fresh' : ''}" data-id="${esc(ev.id)}" aria-pressed="${state.selected === ev.id}">
      <span class="badge${si.plain.length > 1 ? ' two' : ''}" style="--c:${si.bg};--fg:${si.fg}"><span>${si.t}</span></span>
      <span class="item__main"><span class="item__title">${esc(title)}</span>
        <span class="item__meta">${meta} ${tsuTag}</span></span>
      <span class="item__time"><span>${fmtMD.format(ev.t)}</span><br><span data-rel="${ev.t}">${rel(ev.t)}</span></span>
    </button></li>`;
  }).join('');
  ol.scrollTop = top;
  $$('.chip', $('.list-head')).forEach(c => c.setAttribute('aria-checked', String(c.dataset.filter === settings.filter)));
  if (state.newIds.size) setTimeout(() => { state.newIds.clear(); $$('.item.enter').forEach(i => i.classList.remove('enter')); }, 900);
}
const depthText = (d, short) => d === 0 ? 'ごく浅い' : d > 0 ? `深さ${d}km` : (short ? '深さ不明' : '不明');

/* ---------------- 詳細 ---------------- */
function select(id, { fly = true, scrollList = false } = {}) {
  state.selected = id;
  const ev = state.events.find(e => e.id === id);
  if (!ev) { $('#detail').hidden = true; return; }
  renderDetail(ev);
  $$('.item').forEach(i => i.setAttribute('aria-pressed', String(i.dataset.id === id)));
  if (scrollList) { const it = $(`.item[data-id="${CSS.escape(id)}"]`); it && it.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  if (map && ev.lat != null) {
    renderMarkers();
    if (fly) map.flyTo([ev.lat, ev.lon], Math.max(map.getZoom(), 6), { duration: .9 });
  }
  if (fly && matchMedia('(max-width: 719px)').matches) setView('map');
}
function renderDetail(ev) {
  const si = scaleInfo(ev.scale, ev.type === 'Foreign');
  const tl = TSU_LABEL[ev.tsu] || TSU_LABEL.Unknown;
  const groups = {};
  (ev.pts || []).forEach(([pref, addr, sc]) => { (groups[sc] ||= []).push(addr || pref); });
  const gHtml = Object.keys(groups).map(Number).sort((a, b) => b - a).map(sc => {
    const g = scaleInfo(sc), names = groups[sc], shown = names.slice(0, 24);
    return `<div class="grp"><span class="badge" style="--c:${g.bg};--fg:${g.fg}">${g.t}</span><p>${shown.map(esc).join('、')}${names.length > shown.length ? ` ほか${names.length - shown.length}地点` : ''}</p></div>`;
  }).join('');
  const d = $('#detail');
  d.hidden = false;
  d.innerHTML = `
    <div class="detail__top">
      <span class="badge" style="--c:${si.bg};--fg:${si.fg}">${si.t}</span>
      <div><h3>${esc(ev.name || '震源調査中')}</h3><div class="detail__time">${fmtFull.format(ev.t)}頃発生 ・ ${rel(ev.t)}</div></div>
      <button class="x" aria-label="閉じる"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>
    </div>
    <div class="facts">
      <div class="fact"><small>マグニチュード</small><b>${ev.mag >= 0 ? ev.mag.toFixed(1) : '—'}</b></div>
      <div class="fact"><small>深さ</small><b>${ev.depth === 0 ? 'ごく浅い' : ev.depth > 0 ? ev.depth + 'km' : '—'}</b></div>
      <div class="fact"><small>最大震度</small><b>${esc(si.plain)}</b></div>
    </div>
    <div class="tsu-line ${tl[1] === 'warn' ? 'warn' : ''}">${esc(tl[0])}</div>
    ${gHtml ? `<h4>各地の震度</h4>${gHtml}` : ''}`;
  $('.x', d).onclick = () => { state.selected = null; d.hidden = true; $$('.item').forEach(i => i.setAttribute('aria-pressed', 'false')); renderMarkers(); };
}

/* ---------------- 津波・EEW バナー ---------------- */
function renderAlerts() {
  const box = $('#alerts'); let html = '';
  const eew = state.eew;
  if (eew) {
    const h = eew.earthquake?.hypocenter || {};
    const areas = (eew.areas || []).map(a => a.name).filter(Boolean);
    html += `<div class="alert alert--eew" role="alert"><div class="alert__head"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg>
      <div><div class="alert__title">緊急地震速報（警報）</div><div class="alert__sub">${esc(h.name || '震源調査中')}${h.magnitude > 0 ? ` M${h.magnitude}` : ''} ・ 強い揺れに警戒してください</div></div>
      <button class="alert__close" data-close="eew" aria-label="閉じる"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button></div>
      ${areas.length ? `<details open><summary>対象地域 ${areas.length}</summary><ul>${areas.slice(0, 40).map(a => `<li>${esc(a)}</li>`).join('')}</ul></details>` : ''}</div>`;
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
  $$('[data-close="eew"]', box).forEach(b => b.onclick = () => { state.eew = null; renderAlerts(); });
}

/* ---------------- 通知・演出 ---------------- */
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
  } catch { /* 自動再生制限など */ }
}
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
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) return reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch { /* noop */ }
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}
const quakeText = (ev) => {
  const si = scaleInfo(ev.scale, ev.type === 'Foreign');
  return {
    title: ev.type === 'Foreign' ? '海外で大きな地震' : `地震 最大震度${si.plain}`,
    body: `${ev.name || '震源調査中'} ${ev.mag >= 0 ? 'M' + ev.mag.toFixed(1) : ''} ${depthText(ev.depth, true)}  ${fmtHM.format(ev.t)}頃発生`.replace(/\s+/g, ' ').trim()
  };
};

/* ---------------- メッセージ処理 ---------------- */
function applyQuake(m, { live }) {
  const n = normQuake(m);
  if (!Number.isFinite(n.t)) return;
  const wasSeen = seenIds.has(n.id);
  seenIds.add(n.id);
  const r = mergeInto(state.events, n);
  if (!live || wasSeen) return;
  const notable = r.created || r.scaleUp || r.filled;
  if (!notable) return;
  state.newIds.add(r.ev.id);
  state.unread++; updateBadge();
  const urgent = r.ev.scale >= 55 || (r.ev.tsu === 'Warning');
  const pass = r.ev.scale >= settings.minScale;
  persist(); renderList(); renderMarkers(r.ev.id);
  if (!pass) { toast(`${scaleInfo(r.ev.scale).plain === '不明' ? '' : '震度' + scaleInfo(r.ev.scale).plain + ' '}${r.ev.name || '地震情報'}`); return; }
  flash(urgent); beep(urgent);
  const tx = quakeText(r.ev); notify(tx.title, tx.body, 'eq-' + r.ev.key, urgent);
  toast(`${tx.title}：${r.ev.name || '震源調査中'}`);
  if (map && r.ev.lat != null) map.flyTo([r.ev.lat, r.ev.lon], Math.max(map.getZoom(), 6), { duration: 1.2 });
  select(r.ev.id, { fly: false });
}
function applyTsunami(m, { live }) {
  const prev = state.tsunami;
  const fresh = !prev || prev.id !== m.id;
  const old = Date.now() - parseJst(m.time) > 24 * 3600e3;
  if (m.cancelled || !(m.areas && m.areas.length)) {
    state.tsunami = null; save(K.tsunami, null);
    if (live && fresh && prev) { toast('津波予報が解除されました'); notify('津波予報解除', '津波に関する予報は解除されました', 'tsunami', false); }
  } else if (!old) {
    state.tsunami = m; save(K.tsunami, m);
    if (live && fresh) {
      const top = m.areas.reduce((x, a) => ((GRADE[a.grade]?.rank || 0) > (GRADE[x]?.rank || 0) ? a.grade : x), 'Unknown');
      const g = GRADE[top] || GRADE.Unknown;
      flash(true); beep(true);
      notify(`${g.label}を発表`, `${m.areas.slice(0, 6).map(a => a.name).join('、')}${m.areas.length > 6 ? ' ほか' : ''}  ただちに海岸から離れてください`, 'tsunami', true);
    }
  }
  renderAlerts();
}
let eewTimer = null;
function applyEew(m) {
  if (m.test) return;
  if (m.cancelled) { state.eew = null; renderAlerts(); return; }
  state.eew = m; renderAlerts(); flash(true); beep(true);
  const h = m.earthquake?.hypocenter || {};
  notify('緊急地震速報（警報）', `${h.name || '震源調査中'} 強い揺れに警戒してください`, 'eew', true);
  clearTimeout(eewTimer); eewTimer = setTimeout(() => { state.eew = null; renderAlerts(); }, 90000);
  if (map && validCoord(h.latitude, h.longitude)) map.flyTo([h.latitude, h.longitude], 6, { duration: 1 });
}
function handle(m, live) {
  if (!m || typeof m !== 'object') return;
  switch (m.code) {
    case 551: applyQuake(m, { live }); break;
    case 552: applyTsunami(m, { live }); break;
    case 556: if (live) applyEew(m); break;
    default: break; // 554, 555, 561 など
  }
}

/* ---------------- REST: 履歴 ---------------- */
async function fetchHistory(silent) {
  try {
    const r = await fetch(`${CFG.apiBase}/history?codes=551&codes=552&limit=${CFG.historyLimit}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const arr = await r.json();
    let tsunamiDone = false;
    arr.forEach(m => {
      if (m.code === 552) { if (!tsunamiDone) { tsunamiDone = true; applyTsunami(m, { live: false }); } }
      else handle(m, false);
    });
    persist(); renderList(); renderMarkers();
    if (!state.selected && state.events[0]) { /* 初期は選択せず地図全体 */ }
    if (!silent) toast('履歴を更新しました');
  } catch (e) {
    if (!silent) toast('履歴を取得できません。キャッシュを表示しています');
  }
}

/* ---------------- WebSocket ---------------- */
let ws = null, retry = 0, retryTimer = null, everOpen = false;
function setStatus(s, text) {
  state.status = s; const el = $('#status'); el.dataset.state = s; $('#statusText', el).textContent = text;
}
function connect() {
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  if (!navigator.onLine) { setStatus('offline', 'オフライン'); return; }
  setStatus('connecting', retry ? '再接続中' : '接続中');
  try { ws = new WebSocket(CFG.wsUrl); } catch { return schedule(); }
  ws.onopen = () => {
    setStatus('live', 'ライブ'); retry = 0;
    if (everOpen) fetchHistory(true); // 切断中の取りこぼしを補完
    everOpen = true;
  };
  ws.onmessage = (ev) => {
    try { const d = JSON.parse(ev.data); (Array.isArray(d) ? d : [d]).forEach(m => handle(m, true)); } catch { /* ignore */ }
  };
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  ws.onclose = () => { setStatus(navigator.onLine ? 'connecting' : 'offline', navigator.onLine ? '再接続中' : 'オフライン'); schedule(); };
}
function schedule() {
  clearTimeout(retryTimer);
  const wait = Math.min(30000, 1000 * 2 ** retry++) + Math.random() * 500;
  retryTimer = setTimeout(connect, wait);
}
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
  $$('.navbar__item').forEach(b => b.toggleAttribute('aria-current', b.dataset.view === v));
  $$('.navbar__item').forEach(b => { if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); });
  if (v === 'list') { state.unread = 0; updateBadge(); }
  if (v === 'map' && map) setTimeout(() => map.invalidateSize(), 50);
}

/* ---------------- 設定・Push ---------------- */
let wakeSentinel = null;
async function wakeLock() {
  try {
    if (!settings.wake || !('wakeLock' in navigator) || document.hidden) return;
    wakeSentinel = await navigator.wakeLock.request('screen');
  } catch { /* noop */ }
}
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
const FB_VER = '10.12.2';
const pushConfigured = () => !!(CFG.firebase.apiKey && CFG.vapidKey && CFG.relayUrl);
async function relay(path, body) {
  const r = await fetch(CFG.relayUrl.replace(/\/$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('relay ' + r.status);
}
async function enablePush() {
  if (!pushConfigured()) throw new Error('config.js に Firebase / relay の設定が必要です');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('この環境はプッシュ通知に未対応です（iPadはホーム画面に追加して起動してください）');
  if (Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') throw new Error('通知が許可されていません');
  }
  if (!window.firebase) {
    await loadScript(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-messaging-compat.js`);
  }
  if (!firebase.apps.length) firebase.initializeApp(CFG.firebase);
  const reg = await navigator.serviceWorker.ready;
  const token = await firebase.messaging().getToken({ vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
  if (!token) throw new Error('トークンを取得できません');
  await relay('/subscribe', { token, minScale: settings.minScale });
  settings.pushToken = token; settings.push = true; saveSettings();
}
async function disablePush() {
  try { if (settings.pushToken && CFG.relayUrl) await relay('/unsubscribe', { token: settings.pushToken }); } catch { /* noop */ }
  settings.push = false; saveSettings();
}
const saveSettings = () => save(K.settings, settings);

function initSettingsUI() {
  const dlg = $('#settings');
  const sync = () => {
    $('#optNotify').checked = settings.notify && 'Notification' in window && Notification.permission === 'granted';
    $('#optSound').checked = settings.sound;
    $('#optWake').checked = settings.wake; $('#optWake').disabled = !('wakeLock' in navigator);
    $('#optPush').checked = settings.push; $('#optPush').disabled = !pushConfigured();
    $('#pushNote').textContent = pushConfigured() ? 'アプリを閉じていても即時に受信（FCM）' : 'config.js の Firebase / relay 設定後に有効化できます';
    $('#permNote').textContent = !('Notification' in window) ? 'この環境は通知に未対応です' : Notification.permission === 'denied' ? 'ブラウザ設定で通知がブロックされています' : '新着時にこの端末へ通知します';
    $$('#minScale .chip').forEach(c => c.setAttribute('aria-checked', String(+c.dataset.v === settings.minScale)));
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    $('#installNote').hidden = standalone || !/iPad|iPhone|Macintosh/.test(navigator.userAgent) || !('ontouchend' in document);
  };
  $('#btnSettings').onclick = () => { sync(); dlg.showModal(); };
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  $('#optNotify').onchange = async (e) => {
    if (e.target.checked) {
      if (!('Notification' in window)) { e.target.checked = false; return; }
      const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      settings.notify = p === 'granted';
    } else settings.notify = false;
    saveSettings(); sync();
  };
  $('#optSound').onchange = e => { settings.sound = e.target.checked; saveSettings(); if (settings.sound) beep(false); };
  $('#optWake').onchange = e => { settings.wake = e.target.checked; saveSettings(); if (settings.wake) wakeLock(); else wakeSentinel && wakeSentinel.release().catch(() => {}); };
  $('#optPush').onchange = async (e) => {
    try { e.target.checked ? await enablePush() : await disablePush(); toast(e.target.checked ? 'プッシュ通知を有効にしました' : 'プッシュ通知を無効にしました'); }
    catch (err) { e.target.checked = false; settings.push = false; saveSettings(); toast(err.message || 'プッシュ通知を有効にできません'); }
    sync();
  };
  $('#minScale').onclick = async (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    settings.minScale = +c.dataset.v; saveSettings(); sync();
    if (settings.push && settings.pushToken) { try { await relay('/subscribe', { token: settings.pushToken, minScale: settings.minScale }); } catch { toast('通知設定の同期に失敗しました'); } }
  };
  $('#btnClear').onclick = () => {
    [K.events, K.tsunami, K.seen].forEach(k => { try { localStorage.removeItem(k); } catch { /* noop */ } });
    state.events = []; state.tsunami = null; seenIds.clear(); renderList(); renderMarkers(); renderAlerts();
    fetchHistory(false);
  };
}

/* ---------------- 起動 ---------------- */
function init() {
  initMap();
  initSettingsUI();
  $('.list-head').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    settings.filter = c.dataset.filter; saveSettings(); renderList();
  });
  $('#list').addEventListener('click', e => { const b = e.target.closest('.item'); if (b) select(b.dataset.id); });
  $$('.navbar__item').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#btnFit').addEventListener('click', () => map && map.flyToBounds(JP_BOUNDS, { padding: [10, 10], duration: .8 }));

  // キャッシュを即描画 → 履歴取得 → WebSocket
  state.events.forEach(e => e.ids.forEach(i => seenIds.add(i)));
  if (state.tsunami && Date.now() - parseJst(state.tsunami.time) > 24 * 3600e3) state.tsunami = null;
  renderAlerts(); renderList(); renderMarkers();
  fetchHistory(true).finally(connect);
  wakeLock();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'notification-click') setView('list');
    });
  }
}
init();
})();
