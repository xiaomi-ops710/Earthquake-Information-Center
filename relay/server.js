/**
 * P2P地震情報 WebSocket → FCM 中継サーバー (v2)
 *  - wss://api.p2pquake.net/v2/ws を常時購読し、受信した瞬間に FCM トピックへ送信
 *  - POST /subscribe   { token, nation, region:{pref,name,min}, prev }  購読の登録・差し替え
 *  - POST /unsubscribe { token, prev }
 *  - POST /test        { token }   自分の端末へテスト通知
 *  - GET  /healthz
 *
 * トピック設計（端末ごとに最大3つ）
 *   quake-alert            全端末 … 津波・緊急地震速報（地域別だけの端末にも必ず届く）
 *   quake-min-{10..55}     全国の最小震度
 *   quake-pref-{1..47}-{t} 都道府県別の最小震度
 *
 * 環境変数:
 *   FIREBASE_SERVICE_ACCOUNT  サービスアカウント JSON 文字列（または GOOGLE_APPLICATION_CREDENTIALS）
 *   ALLOWED_ORIGIN            CORS 許可オリジン（例: https://<user>.github.io）カンマ区切り可
 *   PORT                      既定 8080
 *   KEEPALIVE_URL             自分自身の公開URL（Render は RENDER_EXTERNAL_URL を自動設定）。10分ごとに /healthz を叩いてスリープを防ぐ
 */
import http from 'node:http';
import WebSocket from 'ws';
import admin from 'firebase-admin';
import { THRESHOLDS, TOPIC_ALERT, topicNation, normalizeSub, topicsOf, QuakeTracker, AlertTracker, parseJst } from './logic.js';

const WS_URL = process.env.P2P_WS_URL || 'wss://api.p2pquake.net/v2/ws';
const API_BASE = process.env.P2P_API || 'https://api.p2pquake.net/v2';
const toOrigin = (v) => { try { return new URL(v.trim()).origin; } catch { return v.trim().replace(/\/+$/, ''); } };
const ALLOWED = (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean).map(s => (s === '*' ? s : toOrigin(s)));
const PORT = Number(process.env.PORT || 8080);

admin.initializeApp(process.env.FIREBASE_SERVICE_ACCOUNT
  ? { credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }
  : { credential: admin.credential.applicationDefault() });
const messaging = admin.messaging();

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message || e));

/* ---------- 送信 ---------- */
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
    console.log(`[fcm] ${n.topic}${n.renotify ? '' : ' (silent-update)'} ${n.title} / ${n.body.replace(/\n/g, ' ')}`);
  } catch (err) { console.error('[fcm] send failed', n.topic, err.message); }
}

const quakes = new QuakeTracker(), alerts = new AlertTracker();
const sent = new Set();                                   // 重複処理防止（WS と REST 補完の両方から来るため）
function dispatch(m) {
  if (!m || typeof m !== 'object') return;
  const key = m.id != null ? `${m.code}:${m.id}` : null;
  if (key) { if (sent.has(key)) return; sent.add(key); if (sent.size > 500) sent.delete(sent.values().next().value); }
  let list = [];
  try {
    if (m.code === 551) list = quakes.update(m);
    else if (m.code === 552) list = alerts.tsunami(m);
    else if (m.code === 556) list = alerts.eewAlert(m);
  } catch (e) { console.error('[dispatch]', e.message); }
  list.forEach(n => send(n));
}

/* ---------- 切断中の取りこぼしを REST で補完（再接続時のみ。起動直後は再送を避けるため行わない） ---------- */
async function catchUp() {
  try {
    const r = await fetch(`${API_BASE}/history?codes=551&codes=552&codes=556&limit=20`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(r.status);
    const arr = (await r.json()).reverse();
    let n = 0;
    for (const m of arr) {
      const age = Date.now() - parseJst(m.time);
      if (!(age >= 0) || age > (m.code === 556 ? 60e3 : 5 * 60e3)) continue;
      n++; dispatch(m);
    }
    console.log(`[catchup] checked ${n} recent messages`);
  } catch (e) { console.error('[catchup] failed', e.message); }
}

/* ---------- P2P WebSocket（自動再接続 + ハートビート） ---------- */
let retry = 0, everConnected = false;
function connect() {
  const ws = new WebSocket(WS_URL);
  let alive = Date.now();
  const beat = setInterval(() => {
    if (Date.now() - alive > 90e3) { console.log('[ws] heartbeat timeout'); ws.terminate(); return; }
    try { ws.ping(); } catch { /* noop */ }
  }, 30e3);
  ws.on('open', () => {
    retry = 0; alive = Date.now(); console.log('[ws] connected');
    if (everConnected) catchUp(); everConnected = true;
  });
  ws.on('message', (raw) => {
    alive = Date.now();
    try { const d = JSON.parse(raw.toString()); (Array.isArray(d) ? d : [d]).forEach(dispatch); }
    catch (e) { console.error('[ws] parse', e.message); }
  });
  ws.on('pong', () => { alive = Date.now(); });
  ws.on('ping', () => { alive = Date.now(); });
  ws.on('error', (e) => console.error('[ws] error', e.message));
  ws.on('close', () => {
    clearInterval(beat);
    const wait = Math.min(30000, 1000 * 2 ** retry++);
    console.log(`[ws] closed, retry in ${wait}ms`);
    setTimeout(connect, wait);
  });
}
connect();

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
  if (path === '/healthz' || path === '/') return reply(200, { ok: true, ws: everConnected, up: Math.round(process.uptime()) });
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
      return reply(200, { ok: true, topics: want });
    }
    if (path === '/unsubscribe') {
      const all = new Set([TOPIC_ALERT, ...THRESHOLDS.map(topicNation), ...(body.prev ? topicsOf(normalizeSub(body.prev)) : [])]);
      await unsubscribeAll(token, [...all]);
      return reply(200, { ok: true });
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
