/**
 * P2P地震情報 WebSocket → FCM 中継サーバー (v5)
 *  - wss://api.p2pquake.net/v2/ws を常時購読し、受信した瞬間に FCM トピックへ送信
 *  - POST /subscribe   { token, nation, region:{pref,name,min}, prev }  購読の登録・差し替え
 *  - POST /unsubscribe { token, prev }
 *  - POST /test        { token }   自分の端末へテスト通知
 *  - GET  /healthz
 *
 * トピック設計（端末ごとに最大4つ）
 *   quake-alert            全端末 … 津波・緊急地震速報（地域別だけの端末にも必ず届く）
 *   quake-volcano          噴火速報・噴火警報（設定でオンにした端末）
 *   quake-volcano-obs      噴火に関する火山観測報（噴火の発生）・降灰予報（速報/詳細）（設定でオンにした端末）
 *   見守り地点は quake-pref-{1..47}-{t} を最大4地点ぶん追加で購読（サーバー側の配信ロジックは地域別通知と同じ）
 *   quake-min-{10..55}     全国の最小震度
 *   quake-pref-{1..47}-{t} 都道府県別の最小震度
 *
 * 環境変数:
 *   FIREBASE_SERVICE_ACCOUNT  サービスアカウント JSON 文字列（または GOOGLE_APPLICATION_CREDENTIALS）
 *   ALLOWED_ORIGIN            CORS 許可オリジン（例: https://<user>.github.io）カンマ区切り可
 *   PORT                      既定 8080
 *   KEEPALIVE_URL             自分自身の公開URL（Render は RENDER_EXTERNAL_URL を自動設定）。10分ごとに /healthz を叩いてスリープを防ぐ
  *
 * ※ このファイルは単体版です（server.src.js / volcano.js / build.mjs はリポジトリに無いため、この server.js を直接編集します）。
 *
 * 環境変数（任意・接続制限への対応。既定値のままで可）:
 *   RETRY_MAX_MS 再接続の最大待ち時間 既定 120000 ／ RATE_LIMIT_WAIT_MS 429 のときの最短待ち時間 既定 30000
 *   FALLBACK_AFTER_MS WebSocket が切れてから REST 補完を始めるまで 既定 45000 ／ FALLBACK_EVERY_MS REST 補完の間隔 既定 30000
 */
import http from 'node:http';
import WebSocket from 'ws';
import admin from 'firebase-admin';

/* ===== logic.js ===== */
const THRESHOLDS = [10, 30, 40, 45, 55];            // 端末が選べる最小震度（P2P震度値）
const TOPIC_ALERT = 'quake-alert';                  // 全端末: 津波・緊急地震速報
const TOPIC_VOLCANO = 'quake-volcano';              // 噴火速報・噴火警報（任意）
const TOPIC_VOLCANO_OBS = 'quake-volcano-obs';      // 噴火の観測報・降灰予報（任意）
const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];

const topicNation = (t) => `quake-min-${t}`;
const topicRegion = (idx, t) => `quake-pref-${idx}-${t}`;   // idx: 1..47

/* ---------- 購読内容 ---------- */
const validMin = (v, d) => (THRESHOLDS.includes(v) ? v : d);
/** クライアントの { nation, region:{name,pref,min} } を検証して正規化（旧形式 {minScale} も受け付ける） */
function normalizeSub(b) {
  const out = { nation: null, region: null, volcano: false, volcanoObs: false, watch: [] };
  if (!b || typeof b !== 'object') return out;
  if ('nation' in b) out.nation = THRESHOLDS.includes(b.nation) ? b.nation : null;
  else if ('minScale' in b) out.nation = validMin(b.minScale, 30);
  out.volcano = b.volcano === true; out.volcanoObs = b.volcanoObs === true;
  if (Array.isArray(b.watch)) {                  // 見守り地点: 最大4つの都道府県（同じ県は1つにまとめる）
    const seen = new Set();
    for (const w of b.watch) {
      if (!w || typeof w !== 'object') continue;
      let idx = PREFS.indexOf(w.name) + 1;
      if (!idx && Number.isInteger(w.pref) && w.pref >= 1 && w.pref <= 47) idx = w.pref;
      if (!idx || seen.has(idx)) continue;
      seen.add(idx); out.watch.push({ idx, min: validMin(w.min, 40) });
      if (out.watch.length >= 4) break;
    }
  }
  const r = b.region;
  if (r && typeof r === 'object') {
    let idx = PREFS.indexOf(r.name) + 1;
    if (!idx && Number.isInteger(r.pref) && r.pref >= 1 && r.pref <= 47) idx = r.pref;   // 都道府県コード(JIS順)フォールバック
    if (idx) out.region = { idx, min: validMin(r.min, 30) };
  }
  return out;
}
function topicsOf(sub, { alert = true } = {}) {
  const s = [];
  if (alert) s.push(TOPIC_ALERT);
  if (sub.nation != null) s.push(topicNation(sub.nation));
  if (sub.region) s.push(topicRegion(sub.region.idx, sub.region.min));
  if (sub.volcano) s.push(TOPIC_VOLCANO);
  if (sub.volcanoObs) s.push(TOPIC_VOLCANO_OBS);
  for (const w of sub.watch || []) s.push(topicRegion(w.idx, w.min));
  return [...new Set(s)];
}

/* ---------- 表示整形 ---------- */
const SCALE_TXT = { 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 46: '5弱以上', 50: '5強', 55: '6弱', 60: '6強', 70: '7' };
const scaleTxt = (v) => SCALE_TXT[v] || '不明';
const hm = (s) => (String(s || '').match(/(\d{2}:\d{2})/) || [])[1] || '';
function parseJst(s) {
  const m = String(s || '').match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0)) : NaN;
}
const GRADE = { MajorWarning: ['大津波警報', 4], Warning: ['津波警報', 3], Watch: ['津波注意報', 2], Unknown: ['津波予報', 1] };

/* ---------- 通知文（震度1〜4: 1回 / 震度5弱以上: ①緊急地震速報 → ②震度速報 → ③全情報 の3段階） ---------- */
const MAJOR = 45;                                                         // 震度5弱
const depthJp = (d) => (d === 0 ? '深さごく浅い' : d > 0 ? `深さ${d}km` : '');
const hhmm = (s) => { const m = String(s || '').match(/(\d{1,2}):(\d{2})/); return m ? [m[1].padStart(2, '0'), m[2]] : null; };

/** 震度1〜4: 「🚨地震　最大震度3　12：34頃発生」/「千葉県南東沖　M3.1　深さ10km」 */
function minorText(ev) {
  const t = hhmm(ev.timeStr);
  return {
    title: `🚨地震　最大震度${scaleTxt(ev.scale)}${t ? `　${t[0]}：${t[1]}頃発生` : ''}`,
    body: [ev.name || '震源調査中', ev.mag >= 0 ? `M${ev.mag.toFixed(1)}` : '', depthJp(ev.depth)].filter(Boolean).join('　')
  };
}
/** 震度5弱以上 ②震度速報 / ③全情報 */
function majorText(ev, stage) {
  const X = scaleTxt(ev.scale), name = ev.name || ev.topArea || '';
  if (stage === 2) return { title: `⚠️緊急地震速報⚠️最大震度${X}`, body: `${name ? name + '　' : ''}引き続き強い揺れに警戒してください` };
  const t = hhmm(ev.timeStr), spec = [ev.mag >= 0 ? `M${ev.mag.toFixed(1)}` : '', depthJp(ev.depth)].filter(Boolean).join(' ');
  return { title: `⚠️${name ? name + 'で' : ''}最大震度${X}`, body: `${t ? `${t[0]}:${t[1]}頃に` : ''}${spec}${spec ? 'の' : ''}地震が発生しました` };
}

/* ---------- 地震情報(551) ---------- */
class QuakeTracker {
  constructor() { this.events = []; }

  /** 1通のP2Pメッセージ(551)を取り込み、送るべき通知の配列を返す */
  update(m, now = Date.now()) {
    const e = m.earthquake || {}, h = e.hypocenter || {};
    if (m.issue && m.issue.type === 'Foreign') return [];          // 遠地地震は通知対象外（クライアントと同じ）
    const scale = Number.isFinite(e.maxScale) ? e.maxScale : -1;
    const t0 = parseJst(e.time);
    const t = Number.isFinite(t0) ? t0 : parseJst((m.issue && m.issue.time) || m.time);
    if (!Number.isFinite(t)) return [];

    this.events = this.events.filter(x => now - x.seen < 6 * 3600e3);
    const name = h.name || '';
    let ev = this.events.find(x => Math.abs(x.t - t) < 60000 && (!x.name || !name || x.name === name));
    if (!ev) {
      ev = { t, name: '', mag: -1, depth: -1, scale: -1, tsu: '', timeStr: '', ids: new Set(), prefMax: new Map(), topArea: '', topScale: 0, nationDone: -1, regionDone: new Map(), stage: 0, sentScale: -1, tag: 'eq-' + String(e.time || '').slice(0, 16), seen: now };
      this.events.push(ev);
    }
    if (m.id != null) { if (ev.ids.has(m.id)) return []; ev.ids.add(m.id); }
    ev.seen = now;

    const filled = !ev.name && !!name;                              // 震源名が新たに分かった
    if (name) ev.name = name;
    if (Number.isFinite(h.magnitude) && h.magnitude >= 0) ev.mag = h.magnitude;
    if (Number.isFinite(h.depth) && h.depth >= 0) ev.depth = h.depth;
    if (e.domesticTsunami) ev.tsu = e.domesticTsunami;
    if (e.time) ev.timeStr = e.time;
    ev.scale = Math.max(ev.scale, scale);
    (Array.isArray(m.points) ? m.points : []).forEach(p => {
      if (!p || !p.pref || !Number.isFinite(p.scale)) return;
      if ((ev.prefMax.get(p.pref) || 0) < p.scale) ev.prefMax.set(p.pref, p.scale);
      if (p.scale > ev.topScale || (p.scale === ev.topScale && p.isArea && !ev.topIsArea)) { ev.topScale = p.scale; ev.topArea = p.isArea && p.addr ? p.addr : p.pref; ev.topIsArea = !!p.isArea; }
    });

    const base = { tag: ev.tag, kind: '551', mid: String(m.id ?? ''), ttl: 600 };
    const out = [];
    const topicsFor = (txt, urgent) => {
      // 全国: しきい値 <= 最大震度 のトピック / 地域別: 都道府県ごとの最大震度で判定
      for (const th of THRESHOLDS) if (th <= ev.scale) out.push({ ...base, ...txt, urgent, topic: topicNation(th), renotify: true });
      for (const [pref, max] of ev.prefMax) {
        const idx = PREFS.indexOf(pref) + 1; if (!idx) continue;
        for (const th of THRESHOLDS) if (th <= max) out.push({ ...base, ...txt, urgent, topic: topicRegion(idx, th), renotify: true });
      }
    };

    /* ===== 震度5弱以上: 段階通知 ===== */
    if (ev.scale >= MAJOR) {
      const detail = (m.issue && m.issue.type) === 'DetailScale';
      const full = !!ev.name && ev.mag >= 0 && ev.depth >= 0;
      const target = (full || detail) ? 3 : 2;                        // 一気に全情報が届いたときは②を飛ばして③
      const upgraded = ev.scale > ev.sentScale && ev.stage >= 2;      // 震度が上方修正された
      if (target > ev.stage || upgraded) {
        topicsFor(majorText(ev, target), true);
        ev.stage = Math.max(ev.stage, target); ev.sentScale = ev.scale;
      }
      ev.nationDone = Math.max(ev.nationDone, ev.scale);
      return out;
    }

    /* ===== 震度1〜4: 1回の通知。震源名が分かったら通知済みの端末へ無音で更新 ===== */
    const txt = minorText(ev), urgent = ev.tsu === 'Warning';
    for (const th of THRESHOLDS) {
      if (th > ev.scale) continue;
      if (th > ev.nationDone) out.push({ ...base, ...txt, urgent, topic: topicNation(th), renotify: true });
      else if (filled) out.push({ ...base, ...txt, urgent, topic: topicNation(th), renotify: false });
    }
    ev.nationDone = Math.max(ev.nationDone, ev.scale);
    for (const [pref, max] of ev.prefMax) {
      const idx = PREFS.indexOf(pref) + 1; if (!idx) continue;
      const done = ev.regionDone.get(pref) || 0;
      for (const th of THRESHOLDS) {
        if (th > max) continue;
        if (th > done) out.push({ ...base, ...txt, urgent, topic: topicRegion(idx, th), renotify: true });
        else if (filled) out.push({ ...base, ...txt, urgent, topic: topicRegion(idx, th), renotify: false });
      }
      ev.regionDone.set(pref, Math.max(done, max));
    }
    return out;
  }
}

/* ---------- 津波(552) / 緊急地震速報(556) ---------- */
class AlertTracker {
  constructor() { this.tsuSig = undefined; this.eew = new Map(); }   // tsuSig: undefined=不明(再起動直後) '' =解除済み

  tsunami(m) {
    const base = { topic: TOPIC_ALERT, tag: 'tsunami', kind: '552', mid: String(m.id ?? ''), ttl: 600 };
    if (m.cancelled || !(m.areas && m.areas.length)) {
      if (this.tsuSig === '') return [];                              // 既に解除済み
      this.tsuSig = '';
      return [{ ...base, title: '津波予報解除', body: '津波に関する予報は解除されました', urgent: false, renotify: true }];
    }
    const rank = (g) => (GRADE[g] ? GRADE[g][1] : 0);
    const top = m.areas.reduce((x, a) => (rank(a.grade) > rank(x) ? a.grade : x), 'Unknown');
    const sig = top + '|' + m.areas.map(a => `${a.name}:${a.grade}`).sort().join(',');
    if (sig === this.tsuSig) return [];
    this.tsuSig = sig;
    const names = m.areas.slice(0, 6).map(a => a.name).join('、') + (m.areas.length > 6 ? ' ほか' : '');
    return [{ ...base, title: `${(GRADE[top] || GRADE.Unknown)[0]}を発表`, body: `${names} ただちに海岸から離れてください`, urgent: true, renotify: true }];
  }

  /** 緊急地震速報は第1報だけ通知（続報で何度も鳴らさない）。取り消しは静かに差し替え */
  eewAlert(m, now = Date.now()) {
    if (m.test) return [];
    const id = (m.issue && m.issue.eventId) || m.id;
    const base = { topic: TOPIC_ALERT, tag: 'eew', kind: '556', mid: String(m.id ?? ''), ttl: 90 };
    for (const [k, v] of this.eew) if (now - v.t > 3600e3) this.eew.delete(k);
    if (m.cancelled) {
      if (!this.eew.has(id)) return [];
      base.tag = this.eew.get(id).tag || base.tag;
      return [{ ...base, title: '緊急地震速報 取り消し', body: '先に発表された緊急地震速報（警報）は取り消されました', urgent: false, renotify: false }];
    }
    if (this.eew.has(id)) return [];
    const h = (m.earthquake && m.earthquake.hypocenter) || {};
    const mx = Math.max(0, ...(m.areas || []).map(a => (SCALE_TXT[a.scaleTo] ? a.scaleTo : SCALE_TXT[a.scaleFrom] ? a.scaleFrom : 0)));
    const name = h.name || '', lead = name ? `${name}で` : '';
    const body = mx ? `${lead}最大震度${scaleTxt(mx)}　強い揺れに警戒してください` : `${lead}地震　強い揺れに警戒してください`;
    base.tag = 'eq-' + String((m.earthquake && m.earthquake.originTime) || m.time || '').slice(0, 16);   // 後続の震度速報・全情報と同じ通知に置き換わる
    this.eew.set(id, { t: now, tag: base.tag });
    return [{ ...base, title: '⚠️緊急地震速報⚠️', body, urgent: true, renotify: true }];
  }
}

/* ===== volcano.js ===== */
const VOLCANO_FEED = process.env.VOLCANO_FEED || 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml';

const decode = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const tag = (x, t) => { const m = String(x).match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1].trim()) : ''; };

function parseAtom(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const am = e.match(/<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/);
    out.push({
      id: tag(e, 'id'), title: tag(e, 'title'), updated: tag(e, 'updated'),
      author: am ? tag(am[1], 'name') : '', content: tag(e, 'content'),
      link: decode((e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '')
    });
  }
  return out;
}

const isVolcano = (e) => /噴火|火山|降灰/.test(e.title || '');

/** kind: flash(噴火速報) / warning(噴火警報) / forecast(噴火予報) / ash(降灰予報) / obs(観測報) / info(解説情報) / other */
function classify(e) {
  const t = e.title || '', c = e.content || '', all = t + ' ' + c;
  if (/噴火速報/.test(t)) return { kind: 'flash', label: '噴火速報', level: 5 };
  if (/噴火警報|噴火予報/.test(t)) {
    if (/噴火予報/.test(c) && !/噴火警報/.test(c)) return { kind: 'forecast', label: '噴火予報', level: 1 };
    if (/解除|引き?下げ/.test(all)) return { kind: 'info', label: '噴火警報（解除・引下げ）', level: 1 };
    return { kind: 'warning', label: '噴火警報', level: 4 };
  }
  if (/降灰予報/.test(t)) return { kind: 'ash', label: t.replace(/\s+/g, ''), level: 2 };
  if (/観測報/.test(t)) return { kind: 'obs', label: '噴火に関する火山観測報', level: 3 };
  if (/解説情報|解説資料/.test(t)) return { kind: 'info', label: t, level: 1 };
  return { kind: 'other', label: t, level: 0 };
}
const volcanoName = (e) => {
  const m = String(e.content || '').match(/【(.+?)】/); if (!m) return '';
  return m[1].replace(/[\s　]*(噴火速報|噴火警報|噴火予報|降灰予報|火山の状況に関する解説情報|噴火に関する火山観測報|火山.*解説.*).*$/, '').trim() || m[1];   // 「【浅間山 噴火警報】」→「浅間山」
};
const pushWorthy = (c) => c.kind === 'flash' || c.kind === 'warning';
/* 噴火の発生を知らせる観測報と、降灰予報（速報・詳細）。定時の降灰予報は毎日出るので通知しない。噴火が無かった旨の観測報も除く */
const OBS_NEG = /(噴火|爆発).{0,8}(していません|ありません|なし|なかった|認められません|確認されません|観測されませんでした)/;
const obsWorthy = (x) => (x.kind === 'obs' && !OBS_NEG.test(x.summary || '')) || (x.kind === 'ash' && /速報|詳細/.test(x.label || x.title || ''));

class VolcanoTracker {
  constructor() { this.seen = new Set(); this.primed = false; this.items = []; }
  /** フィードの entry 配列を取り込み、{ items: 表示用の一覧, pushes: 通知すべきもの } を返す */
  ingest(entries, now = Date.now(), topic = 'quake-volcano', obsTopic = 'quake-volcano-obs') {
    const items = entries.filter(isVolcano).map(e => {
      const c = classify(e);
      return { id: e.id, title: e.title, kind: c.kind, label: c.label, level: c.level, name: volcanoName(e), summary: e.content, updated: e.updated, author: e.author, link: e.link };
    }).sort((a, b) => (a.updated < b.updated ? 1 : -1)).slice(0, 40);
    // 起動直後は「直近10分以内」の噴火速報・噴火警報だけ通知（再起動のたびに古い情報を再送しない / スリープ中の取りこぼしは救う）
    const cand = this.primed ? items.filter(x => !this.seen.has(x.id)) : items.filter(x => now - Date.parse(x.updated) < 10 * 60e3);
    items.forEach(x => this.seen.add(x.id)); this.primed = true; this.items = items;
    const pushes = cand.filter(pushWorthy).map(x => ({
      topic, tag: 'volcano-' + (x.name || x.kind), kind: 'volcano', mid: x.id,
      title: `${x.label}${x.name ? '：' + x.name.replace(/(噴火速報|噴火警報.*|噴火予報.*)$/, '').trim() : ''}`.slice(0, 80),
      body: (x.summary || x.title).replace(/\s+/g, ' ').slice(0, 140),
      urgent: true, renotify: true, ttl: 1800
    }));
    const obsPushes = cand.filter(x => !pushWorthy(x) && obsWorthy(x)).map(x => ({
      topic: obsTopic, tag: 'volcano-obs-' + (x.name || x.kind), kind: 'volcano', mid: x.id,
      title: (x.kind === 'obs' ? `噴火発生（観測報）${x.name ? '：' + x.name : ''}` : `${x.label}${x.name ? '：' + x.name : ''}`).slice(0, 80),
      body: (x.summary || x.title).replace(/\s+/g, ' ').slice(0, 140),
      urgent: false, renotify: true, ttl: 1800
    }));
    return { items, pushes: pushes.concat(obsPushes) };
  }
}

/* ===== server ===== */





const SERVER_VERSION = 5;

const WS_URL = process.env.P2P_WS_URL || 'wss://api.p2pquake.net/v2/ws';
const API_BASE = process.env.P2P_API || 'https://api.p2pquake.net/v2';
const toOrigin = (v) => { try { return new URL(v.trim()).origin; } catch { return v.trim().replace(/\/+$/, ''); } };
const ALLOWED = (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean).map(s => (s === '*' ? s : toOrigin(s)));
const PORT = Number(process.env.PORT || 8080);
const numEnv = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const RETRY_MAX_MS = numEnv('RETRY_MAX_MS', 120e3), RATE_LIMIT_WAIT_MS = numEnv('RATE_LIMIT_WAIT_MS', 30e3);
const FALLBACK_AFTER_MS = numEnv('FALLBACK_AFTER_MS', 45e3), FALLBACK_EVERY_MS = numEnv('FALLBACK_EVERY_MS', 30e3);

admin.initializeApp(process.env.FIREBASE_SERVICE_ACCOUNT
  ? { credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }
  : { credential: admin.credential.applicationDefault() });
const messaging = admin.messaging();

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message || e));

/* ---------- 送信 ---------- */
let lastPush = null, lastWsMsg = 0;
async function send(n) {
  const data = {
    mid: n.mid, kind: n.kind, title: n.title, body: n.body, tag: n.tag,
    urgent: n.urgent ? '1' : '0', renotify: n.renotify ? '1' : '0'
  };
  try {
    await messaging.send({
      topic: n.topic, data,
      webpush: { headers: { Urgency: 'high', TTL: String(n.ttl) } },
      android: { priority: 'high', ttl: n.ttl * 1000 },
      apns: { headers: { 'apns-priority': '10' } }
    });
    lastPush = { t: Date.now(), topic: n.topic, title: n.title };
    console.log(`[fcm] ${n.topic}${n.renotify ? '' : ' (silent-update)'} ${n.title} / ${n.body.replace(/\n/g, ' ')}`);
  } catch (err) { console.error('[fcm] send failed', n.topic, err.message); }
}

const quakes = new QuakeTracker(), alerts = new AlertTracker();
const sent = new Set();                                   // 重複処理防止（WS と REST 補完の両方から来るため）
function dispatch(m, late = false) {
  if (!m || typeof m !== 'object') return;
  const key = m.id != null ? `${m.code}:${m.id}` : null;
  if (m.code === 551 || m.code === 552 || m.code === 556) console.log(`[p2p] code=${m.code} id=${m.id}${m.earthquake ? ' maxScale=' + m.earthquake.maxScale : ''}`);   // Render のログで「受信できているか」を確認できる
  if (key) { if (sent.has(key)) return; sent.add(key); if (sent.size > 500) sent.delete(sent.values().next().value); }
  let list = [];
  try {
    if (m.code === 551) list = quakes.update(m);
    else if (m.code === 552) list = alerts.tsunami(m);
    else if (m.code === 556) list = alerts.eewAlert(m);
  } catch (e) { console.error('[dispatch]', e.message); }
  list.forEach(n => send(late && n.kind !== 'test' ? { ...n, body: n.body + '\n（受信が遅れました）' } : n));
}

/* ---------- 切断中の取りこぼしを REST で補完（再接続時のみ。起動直後は再送を避けるため行わない） ---------- */
async function catchUp(maxAge = 5 * 60e3) {
  try {
    const r = await fetch(`${API_BASE}/history?codes=551&codes=552&codes=556&limit=20`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(r.status);
    const arr = (await r.json()).reverse();
    let n = 0;
    for (const m of arr) {
      const age = Date.now() - parseJst(m.time);
      if (!(age >= 0) || age > (m.code === 556 ? 60e3 : maxAge)) continue;
      n++; dispatch(m, age > 120e3);
    }
    console.log(`[catchup] checked ${n} recent messages`);
  } catch (e) { console.error('[catchup] failed', e.message); }
}

/* ---------- P2P WebSocket（自動再接続 + ハートビート） ---------- */
let retry = 0, everConnected = false;
let wsOpen = false, wsDownSince = Date.now(), last429 = 0, lastFallback = 0, fallbackRuns = 0;   // 接続状態（/healthz と REST 補完に使う）
const nextWait = (rateLimited) => {              // 再接続の待ち時間: 指数的に最大 RETRY_MAX_MS まで。429 のときは最低 RATE_LIMIT_WAIT_MS。どちらも揺らぎを加える
  let wait = Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(retry++, 10));
  if (rateLimited) wait = Math.max(wait, RATE_LIMIT_WAIT_MS);
  return Math.round(wait + Math.random() * Math.min(15e3, wait * 0.2 + 500));
};
/* WebSocket が FALLBACK_AFTER_MS 以上切れたら、FALLBACK_EVERY_MS ごとに /history を取得して未送信の分を通知する（dispatch が重複を除く） */
setInterval(() => {
  if (wsOpen || Date.now() - wsDownSince < FALLBACK_AFTER_MS || Date.now() - lastFallback < FALLBACK_EVERY_MS) return;
  lastFallback = Date.now(); fallbackRuns++; console.log('[fallback] websocket down, polling REST history');
  catchUp(5 * 60e3);
}, Math.max(50, Math.min(5e3, FALLBACK_EVERY_MS / 2)));
function connect() {
  const ws = new WebSocket(WS_URL, { handshakeTimeout: 10e3 });   // 接続試行が終わらないまま止まるのを防ぐ
  let alive = Date.now();
  const beat = setInterval(() => {
    if (Date.now() - alive > 90e3) { console.log('[ws] heartbeat timeout'); ws.terminate(); return; }
    try { ws.ping(); } catch { /* noop */ }
  }, 30e3);
  let rateLimited = false;
  ws.on('open', () => {
    retry = 0; alive = Date.now(); wsOpen = true; console.log('[ws] connected');
    // 再接続時は5分、起動直後（スリープ復帰・再デプロイ）は8分前までの取りこぼしを補完。起動直後の再送は端末側で同じ tag に置換される
    catchUp(everConnected ? 5 * 60e3 : 8 * 60e3); everConnected = true;
  });
  ws.on('message', (raw) => {
    alive = Date.now(); lastWsMsg = alive;
    try { const d = JSON.parse(raw.toString()); (Array.isArray(d) ? d : [d]).forEach(m => dispatch(m)); }
    catch (e) { console.error('[ws] parse', e.message); }
  });
  ws.on('pong', () => { alive = Date.now(); });
  ws.on('ping', () => { alive = Date.now(); });
  ws.on('error', (e) => { console.error('[ws] error', e.message); if (/\b429\b/.test(String(e && e.message))) { rateLimited = true; last429 = Date.now(); } });
  ws.on('close', () => {
    clearInterval(beat);
    if (wsOpen || !wsDownSince) wsDownSince = Date.now(); wsOpen = false;
    const wait = nextWait(rateLimited);
    console.log(`[ws] closed, retry in ${wait}ms${rateLimited ? ' (429: rate limited)' : ''}`);
    setTimeout(connect, wait);
  });
}
connect();

/* ---------- 噴火情報（気象庁フィード）の定期取得 ---------- */
const volcano = new VolcanoTracker();
let volcanoState = { updated: 0, error: null, items: [] }, feedValidators = {};
async function pollVolcano() {
  try {
    const headers = { 'user-agent': 'quake-pwa-relay/3 (+https://github.com)' };
    if (feedValidators.etag) headers['if-none-match'] = feedValidators.etag;
    if (feedValidators.lm) headers['if-modified-since'] = feedValidators.lm;
    const r = await fetch(VOLCANO_FEED, { headers, signal: AbortSignal.timeout(15000) });
    if (r.status === 304) { volcanoState = { ...volcanoState, updated: Date.now(), error: null }; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    feedValidators = { etag: r.headers.get('etag') || '', lm: r.headers.get('last-modified') || '' };
    const { items, pushes } = volcano.ingest(parseAtom(await r.text()));
    volcanoState = { updated: Date.now(), error: null, items };
    pushes.forEach(send);
  } catch (e) { volcanoState = { ...volcanoState, error: e.message }; console.error('[volcano]', e.message); }
}
pollVolcano(); setInterval(pollVolcano, 60e3);

/* ---------- スリープ防止（Render 無料プラン等） ---------- */
const KEEPALIVE = (process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (KEEPALIVE) {
  setInterval(() => { fetch(KEEPALIVE + '/healthz', { signal: AbortSignal.timeout(10000) }).catch(() => {}); }, 10 * 60e3);
  console.log('[keepalive] ' + KEEPALIVE);
}

/* ---------- HTTP ---------- */
const corsFor = (req) => {
  const o = req.headers.origin;
  const allow = ALLOWED.includes('*') ? '*' : (ALLOWED.includes(o) ? o : ALLOWED[0]);
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Vary': 'Origin' };
};
const readJson = (req) => new Promise((res, rej) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 8192) { rej(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch (e) { rej(e); } });
  req.on('error', rej);
});
const hits = new Map();                                    // 簡易レート制限（IP × 種別 × 1分）
function limited(req, kind, max) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = ip + '|' + kind, now = Date.now(), h = hits.get(k);
  if (!h || now > h.reset) { hits.set(k, { n: 1, reset: now + 60e3 }); if (hits.size > 5000) hits.clear(); return false; }
  return ++h.n > max;
}

async function subscribeAll(token, topics) {
  for (const t of topics) {
    const r = await messaging.subscribeToTopic(token, t);          // 無効なトークンは例外ではなく failureCount で返る
    if (r.failureCount > 0) {
      const code = r.errors && r.errors[0] && r.errors[0].error && r.errors[0].error.code || 'unknown';
      const e = new Error('subscribe failed: ' + code); e.status = 400; e.detail = code; throw e;
    }
  }
}
const unsubscribeAll = (token, topics) => Promise.allSettled(topics.map(t => messaging.unsubscribeFromTopic(token, t)));

http.createServer(async (req, res) => {
  const reply = (code, obj) => {
    res.writeHead(code, { ...corsFor(req), 'content-type': 'application/json' });
    res.end(code === 204 ? undefined : JSON.stringify(obj));
  };
  const path = (req.url || '').split('?')[0];
  if (req.method === 'OPTIONS') return reply(204, {});
  if (path === '/healthz' || path === '/') return reply(200, {
    ok: true, v: SERVER_VERSION, ws: wsOpen, wsEver: everConnected, up: Math.round(process.uptime()),
    wsDownSec: wsOpen ? 0 : Math.round((Date.now() - wsDownSince) / 1000), wsRetry: retry,
    last429Ago: last429 ? Math.round((Date.now() - last429) / 1000) : null,
    restFallback: { active: !wsOpen && Date.now() - wsDownSince >= FALLBACK_AFTER_MS, runs: fallbackRuns, lastAgo: lastFallback ? Math.round((Date.now() - lastFallback) / 1000) : null },
    lastWsMsgAgo: lastWsMsg ? Math.round((Date.now() - lastWsMsg) / 1000) : null,
    lastPush: lastPush ? { agoSec: Math.round((Date.now() - lastPush.t) / 1000), topic: lastPush.topic, title: lastPush.title } : null,
    volcano: { ok: !volcanoState.error, items: volcanoState.items.length }
  });
  if (path === '/volcano') return reply(200, { ok: !volcanoState.error || volcanoState.items.length > 0, error: volcanoState.error, updated: volcanoState.updated, items: volcanoState.items });
  console.log(`[http] ${req.method} ${path} origin=${req.headers.origin || '-'}`);
  if (req.method !== 'POST') return reply(404, { error: 'not found' });
  if (limited(req, path === '/test' ? 'test' : 'sub', path === '/test' ? 6 : 40)) return reply(429, { error: 'too many requests' });
  try {
    const body = await readJson(req);
    const { token } = body;
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return reply(400, { error: 'bad token' });

    if (path === '/subscribe') {
      const next = normalizeSub(body);
      const want = topicsOf(next);
      // 前回の購読が不明なときは、全国トピックだけ全部外してから付け直す（地域トピックの取り残しはクライアントが prev を渡す）
      const had = body.prev ? topicsOf(normalizeSub(body.prev)) : THRESHOLDS.map(topicNation);
      await unsubscribeAll(token, had.filter(t => !want.includes(t) && t !== TOPIC_ALERT));
      await subscribeAll(token, want);
      console.log('[sub]', want.join(','));
      return reply(200, { ok: true, topics: want });
    }
    if (path === '/unsubscribe') {
      const all = new Set([TOPIC_ALERT, ...THRESHOLDS.map(topicNation), ...(body.prev ? topicsOf(normalizeSub(body.prev)) : [])]);
      await unsubscribeAll(token, [...all]);
      return reply(200, { ok: true });
    }
    if (path === '/test-topic') {
      // 実際の配信経路（トピック）の確認: 購読を確実にしてから、自分の全国トピック（無ければ地域→alert）へ送る
      const next = normalizeSub(body), want = topicsOf(next);
      await subscribeAll(token, want);
      const via = next.nation != null ? topicNation(next.nation) : want.find(t => t.startsWith('quake-pref-')) || TOPIC_ALERT;
      await messaging.send({
        topic: via,
        data: { mid: 'topic-test-' + Date.now(), kind: 'test', title: 'トピック配信テスト', body: `実際の配信経路（${via}）で届いています`, tag: 'test-topic', urgent: '0', renotify: '1' },
        webpush: { headers: { Urgency: 'high', TTL: '60' } }
      });
      return reply(200, { ok: true, via, topics: want });
    }
    if (path === '/test') {
      await messaging.send({
        token,
        data: { mid: 'test-' + Date.now(), kind: 'test', title: 'テスト通知', body: '中継サーバー経由のプッシュ通知が届いています', tag: 'test', urgent: '0', renotify: '1' },
        webpush: { headers: { Urgency: 'high', TTL: '60' } }
      });
      return reply(200, { ok: true });
    }
    return reply(404, { error: 'not found' });
  } catch (e) {
    console.error('[http]', path, e.message);
    return reply(e.status || 500, { error: e.status === 400 ? 'bad token' : 'failed', detail: e.detail || undefined });
  }
}).listen(PORT, () => console.log(`[http] listening on :${PORT}`));
