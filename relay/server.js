/**
 * P2P地震情報 WebSocket → FCM 中継サーバー
 *  - wss://api.p2pquake.net/v2/ws を常時購読し、受信した瞬間に FCM トピックへ送信
 *  - POST /subscribe   { token, minScale }  端末トークンを震度しきい値のトピックへ登録
 *  - POST /unsubscribe { token }
 *
 * 環境変数:
 *   FIREBASE_SERVICE_ACCOUNT  サービスアカウント JSON 文字列（または GOOGLE_APPLICATION_CREDENTIALS）
 *   ALLOWED_ORIGIN            CORS 許可オリジン（例: https://<user>.github.io）
 *   PORT                      既定 8080
 */
import http from 'node:http';
import WebSocket from 'ws';
import admin from 'firebase-admin';

const WS_URL = process.env.P2P_WS_URL || 'wss://api.p2pquake.net/v2/ws';
const toOrigin = (v) => { try { return new URL(v.trim()).origin; } catch { return v.trim().replace(/\/+$/, ''); } };
const ALLOWED = (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean).map(s => (s === '*' ? s : toOrigin(s)));
const PORT = Number(process.env.PORT || 8080);
const THRESHOLDS = [10, 30, 40, 45, 55];              // 端末が選べる最小震度（P2P震度値）
const topicOf = (t) => `quake-min-${t}`;

admin.initializeApp(process.env.FIREBASE_SERVICE_ACCOUNT
  ? { credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }
  : { credential: admin.credential.applicationDefault() });
const messaging = admin.messaging();

/* ---------- 表示用整形（クライアントと同じ文言） ---------- */
const SCALE = { 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 46: '5弱以上', 50: '5強', 55: '6弱', 60: '6強', 70: '7' };
const hm = (s) => (String(s || '').match(/(\d{2}:\d{2})/) || [])[1] || '';
const GRADE = { MajorWarning: ['大津波警報', 4], Warning: ['津波警報', 3], Watch: ['津波注意報', 2], Unknown: ['津波予報', 1] };

function build(m) {
  if (m.code === 551) {
    const e = m.earthquake || {}, h = e.hypocenter || {};
    const foreign = m.issue && m.issue.type === 'Foreign';
    const scale = Number.isFinite(e.maxScale) ? e.maxScale : -1;
    if (!foreign && scale < 10) return null;           // 震度不明の情報は送らない
    const depth = h.depth === 0 ? 'ごく浅い' : h.depth > 0 ? `深さ${h.depth}km` : '';
    return {
      scale, urgent: scale >= 55 || e.domesticTsunami === 'Warning',
      tag: 'eq-' + String(e.time || '').slice(0, 16),
      title: foreign ? '海外で大きな地震' : `地震 最大震度${SCALE[scale] || '不明'}`,
      body: [h.name || '震源調査中', h.magnitude >= 0 ? `M${Number(h.magnitude).toFixed(1)}` : '', depth, `${hm(e.time)}頃発生`].filter(Boolean).join(' ')
    };
  }
  if (m.code === 552) {
    if (m.cancelled || !(m.areas && m.areas.length)) {
      return { scale: 999, urgent: false, tag: 'tsunami', title: '津波予報解除', body: '津波に関する予報は解除されました' };
    }
    const top = m.areas.reduce((x, a) => ((GRADE[a.grade]?.[1] || 0) > (GRADE[x]?.[1] || 0) ? a.grade : x), 'Unknown');
    const names = m.areas.slice(0, 6).map(a => a.name).join('、') + (m.areas.length > 6 ? ' ほか' : '');
    return { scale: 999, urgent: true, tag: 'tsunami', title: `${GRADE[top]?.[0] || '津波予報'}を発表`, body: `${names} ただちに海岸から離れてください` };
  }
  if (m.code === 556 && !m.test && !m.cancelled) {
    const h = m.earthquake?.hypocenter || {};
    return { scale: 999, urgent: true, tag: 'eew', title: '緊急地震速報（警報）', body: `${h.name || '震源調査中'} 強い揺れに警戒してください` };
  }
  return null;
}

const sent = [];                                          // 重複送信防止（直近200件）
async function dispatch(m) {
  const b = build(m);
  if (!b) return;
  const key = `${m.code}:${m.id}`;
  if (sent.includes(key)) return;
  sent.push(key); if (sent.length > 200) sent.shift();

  const data = { id: String(m.id), kind: String(m.code), title: b.title, body: b.body, tag: b.tag, urgent: b.urgent ? '1' : '0' };
  // しきい値 <= 最大震度 のトピックすべてへ送る（端末は1つのトピックにのみ登録）
  const targets = THRESHOLDS.filter(t => b.scale >= t);
  await Promise.allSettled(targets.map(t => messaging.send({
    topic: topicOf(t), data,
    webpush: { headers: { Urgency: 'high', TTL: '600' } },
    android: { priority: 'high', ttl: 600000 },
    apns: { headers: { 'apns-priority': '10' } }
  }).then(() => console.log(`[fcm] ${topicOf(t)} ${b.title} ${b.body}`))
    .catch(err => console.error('[fcm] send failed', t, err.message))));
}

/* ---------- P2P WebSocket（自動再接続） ---------- */
let retry = 0;
function connect() {
  const ws = new WebSocket(WS_URL);
  let alive = Date.now();
  const watchdog = setInterval(() => { if (Date.now() - alive > 5 * 60e3) ws.terminate(); }, 30e3);
  ws.on('open', () => { retry = 0; alive = Date.now(); console.log('[ws] connected'); });
  ws.on('message', (raw) => {
    alive = Date.now();
    try { const d = JSON.parse(raw.toString()); (Array.isArray(d) ? d : [d]).forEach(m => dispatch(m)); }
    catch (e) { console.error('[ws] parse', e.message); }
  });
  ws.on('ping', () => { alive = Date.now(); });
  ws.on('error', (e) => console.error('[ws] error', e.message));
  ws.on('close', () => {
    clearInterval(watchdog);
    const wait = Math.min(30000, 1000 * 2 ** retry++);
    console.log(`[ws] closed, retry in ${wait}ms`);
    setTimeout(connect, wait);
  });
}
connect();

/* ---------- HTTP: トークン登録 ---------- */
const corsFor = (req) => {
  const o = req.headers.origin;
  const allow = ALLOWED.includes('*') ? '*' : (ALLOWED.includes(o) ? o : ALLOWED[0]);
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Vary': 'Origin' };
};
const readJson = (req) => new Promise((res, rej) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 4096) { rej(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch (e) { rej(e); } });
});
http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { ...corsFor(req), 'content-type': 'application/json' });
    res.end(code === 204 ? undefined : JSON.stringify(obj));
  };
  if (req.method !== 'OPTIONS') console.log(`[http] ${req.method} ${req.url} origin=${req.headers.origin || '-'}`);
  if (req.method === 'OPTIONS') return send(204, {});
  if (req.url === '/healthz') return send(200, { ok: true });
  if (req.method !== 'POST') return send(404, { error: 'not found' });
  try {
    const { token, minScale } = await readJson(req);
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return send(400, { error: 'bad token' });
    if (req.url === '/subscribe') {
      const min = THRESHOLDS.includes(minScale) ? minScale : 30;
      await Promise.all(THRESHOLDS.filter(t => t !== min).map(t => messaging.unsubscribeFromTopic(token, topicOf(t))));
      await messaging.subscribeToTopic(token, topicOf(min));
      return send(200, { ok: true, topic: topicOf(min) });
    }
    if (req.url === '/test') {
      // 自分のトークン宛にだけ送る（トークンを知っている本人しか使えない）
      await messaging.send({
        token, data: { id: 'test-' + Date.now(), kind: 'test', title: 'テスト通知', body: '中継サーバー経由のプッシュ通知が届いています', tag: 'test', urgent: '0' },
        webpush: { headers: { Urgency: 'high', TTL: '60' } }
      });
      return send(200, { ok: true });
    }
    if (req.url === '/unsubscribe') {
      await Promise.all(THRESHOLDS.map(t => messaging.unsubscribeFromTopic(token, topicOf(t))));
      return send(200, { ok: true });
    }
    return send(404, { error: 'not found' });
  } catch (e) { console.error('[http]', e.message); return send(500, { error: 'failed' }); }
}).listen(PORT, () => console.log(`[http] listening on :${PORT}`));
