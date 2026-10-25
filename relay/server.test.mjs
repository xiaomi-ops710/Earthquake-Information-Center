// server.js の通しテスト: 偽の ws / firebase-admin を使い、429 の待ち時間・REST 補完・/healthz を確認する。
// 実行: node --test server.test.mjs （ネットワーク・本物の依存パッケージは不要）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jst = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').replace(/-/g, '/').slice(0, 19);

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
  const nm = (n, code) => { fs.mkdirSync(path.join(dir, 'node_modules', n), { recursive: true }); fs.writeFileSync(path.join(dir, 'node_modules', n, 'package.json'), JSON.stringify({ name: n, type: 'module', main: 'index.js' })); fs.writeFileSync(path.join(dir, 'node_modules', n, 'index.js'), code); };
  nm('ws', `import { EventEmitter } from 'node:events'; import fs from 'node:fs';
export default class WebSocket extends EventEmitter {
  constructor(url) { super(); const mode = fs.readFileSync(process.env.WS_MODE_FILE, 'utf8').trim(); fs.appendFileSync(process.env.WS_LOG_FILE, Date.now() + ' ' + mode + '\\n');
    setTimeout(() => { if (mode === 'ok') this.emit('open'); else { if (mode === '429') this.emit('error', new Error('Unexpected server response: 429')); this.emit('close'); } }, 5); }
  ping() {} terminate() { this.emit('close'); } close() { this.emit('close'); } }`);
  nm('firebase-admin', `export default { initializeApp() {}, credential: { cert: () => ({}), applicationDefault: () => ({}) },
  messaging: () => ({ send: async (m) => { console.log('FCMSEND ' + m.topic + ' ' + m.data.title); }, subscribeToTopic: async () => ({}), unsubscribeFromTopic: async () => ({}) }) };`);
  fs.copyFileSync(path.join(here, 'server.js'), path.join(dir, 'server.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return dir;
}
const getJson = (port, p) => new Promise((res, rej) => http.get({ port, path: p, host: '127.0.0.1' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

test('429 の最低待ち時間・REST 補完・/healthz', async (t) => {
  const dir = makeSandbox(), modeFile = path.join(dir, 'mode'), logFile = path.join(dir, 'ws.log');
  fs.writeFileSync(modeFile, '429'); fs.writeFileSync(logFile, '');
  let histHits = 0;
  const quake = () => [{ code: 551, id: 'Q1', time: jst(new Date()), issue: { type: 'DetailScale', time: jst(new Date()) },
    earthquake: { time: jst(new Date()), maxScale: 55, domesticTsunami: 'None', hypocenter: { name: 'テスト震源', magnitude: 6.1, depth: 10 } }, points: [] }];
  const api = http.createServer((req, res) => { histHits++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(quake())); });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const apiPort = api.address().port, port = 18000 + Math.floor(Math.random() * 1000);
  let out = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), WS_MODE_FILE: modeFile, WS_LOG_FILE: logFile,
    P2P_API: `http://127.0.0.1:${apiPort}`, P2P_WS_URL: 'ws://fake', FIREBASE_SERVICE_ACCOUNT: '{}', ALLOWED_ORIGIN: '*',
    RATE_LIMIT_WAIT_MS: '600', RETRY_MAX_MS: '800', FALLBACK_AFTER_MS: '900', FALLBACK_EVERY_MS: '300' } });
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  t.after(() => { child.kill(); api.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 40 && !/listening/.test(out); i++) await sleep(100);
  assert.match(out, /listening/);

  await sleep(2600);                                     // 429 が続く間
  const stamps = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => +l.split(' ')[0]);
  assert.ok(stamps.length >= 2, '再接続を試みている');
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= 590, `429 のあとは 600ms 以上待つ (${stamps[i] - stamps[i - 1]}ms)`);
  const down = await getJson(port, '/healthz');
  assert.equal(down.v, 5); assert.equal(down.ws, false); assert.equal(down.wsEver, false);
  assert.ok(down.last429Ago !== null, '429 を記録'); assert.equal(down.restFallback.active, true); assert.ok(down.restFallback.runs >= 1, 'REST 補完が動いた');
  assert.ok(histHits >= 2, '/history を繰り返し取得');
  assert.equal((out.match(/FCMSEND quake-min-55/g) || []).length <= 1, true, '同じ地震は1回しか通知しない');
  assert.ok(/FCMSEND /.test(out), 'REST 補完で未送信の地震が通知された');
  const sentCount = (out.match(/FCMSEND /g) || []).length;

  fs.writeFileSync(modeFile, 'ok');                      // 接続が回復
  await sleep(1500);
  const up = await getJson(port, '/healthz');
  assert.equal(up.ws, true); assert.equal(up.wsEver, true); assert.equal(up.wsDownSec, 0); assert.equal(up.restFallback.active, false);
  assert.equal((out.match(/FCMSEND /g) || []).length, sentCount, '回復後の catch-up でも再送しない');
});

const postJson = (port, p, body) => new Promise((res, rej) => { const d = JSON.stringify(body); const r = http.request({ port, host: '127.0.0.1', path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, x => { let b = ''; x.on('data', c => b += c); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }); r.on('error', rej); r.end(d); });
const entry = (id, title, content, ageMs) => `<entry><id>${id}</id><title>${title}</title><updated>${new Date(Date.now() - ageMs).toISOString()}</updated><author><name>気象庁</name></author><content type="text">${content}</content><link href="https://example.invalid/${id}.xml"/></entry>`;

test('噴火: 速報・警報は quake-volcano、観測報・降灰予報(速報)は quake-volcano-obs、定時・噴火なしは通知しない', async (t) => {
  const dir = makeSandbox(), modeFile = path.join(dir, 'mode'), logFile = path.join(dir, 'ws.log');
  fs.writeFileSync(modeFile, 'hang'); fs.writeFileSync(logFile, '');
  const feed = `<?xml version="1.0"?><feed>${[
    entry('v1', '噴火速報', '【浅間山 噴火速報】浅間山で噴火が発生しました。', 60e3),
    entry('v2', '噴火警報・予報', '【桜島 噴火警報（居住地域）】噴火警戒レベル4（避難準備）に引上げ', 90e3),
    entry('v3', '噴火に関する火山観測報', '【諏訪之瀬島 噴火に関する火山観測報】噴火が発生しました。噴煙は火口縁上1500m', 120e3),
    entry('v4', '降灰予報（定時）', '【霧島山（新燃岳） 降灰予報（定時）】降灰の予想', 150e3),
    entry('v5', '降灰予報（速報）', '【桜島 降灰予報（速報）】少量の降灰が予想されます', 180e3),
    entry('v6', '噴火に関する火山観測報', '【阿蘇山 噴火に関する火山観測報】噴火は発生していません', 200e3),
    entry('v7', '火山の状況に関する解説情報', '【草津白根山 解説情報】火山活動は静穏', 220e3)
  ].join('')}</feed>`;
  const api = http.createServer((req, res) => { res.setHeader('content-type', 'application/atom+xml'); res.end(feed); });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const apiPort = api.address().port, port = 19000 + Math.floor(Math.random() * 900);
  let out = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), WS_MODE_FILE: modeFile, WS_LOG_FILE: logFile,
    P2P_API: `http://127.0.0.1:${apiPort}/none`, P2P_WS_URL: 'ws://fake', VOLCANO_FEED: `http://127.0.0.1:${apiPort}/eqvol.xml`, FIREBASE_SERVICE_ACCOUNT: '{}', ALLOWED_ORIGIN: '*' } });
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  t.after(() => { child.kill(); api.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 40 && !/listening/.test(out); i++) await sleep(100);
  await sleep(1200);
  const sent = (out.match(/FCMSEND [^\n]+/g) || []);
  const bySuffix = (topic) => sent.filter(l => l.startsWith('FCMSEND ' + topic + ' '));
  assert.equal(bySuffix('quake-volcano').length, 2, `速報と警報の2件 (${sent.join(' | ')})`);
  assert.ok(bySuffix('quake-volcano').some(l => l.includes('噴火速報')) && bySuffix('quake-volcano').some(l => l.includes('噴火警報')));
  const obs = bySuffix('quake-volcano-obs');
  assert.equal(obs.length, 2, `観測報1件＋降灰予報(速報)1件 (${sent.join(' | ')})`);
  assert.ok(obs.some(l => l.includes('噴火発生（観測報）：諏訪之瀬島')), '噴火の観測報');
  assert.ok(obs.some(l => l.includes('降灰予報（速報）')), '降灰予報（速報）');
  assert.ok(!sent.some(l => /定時|阿蘇山|解説/.test(l)), '定時の降灰予報・噴火なしの観測報・解説情報は通知しない');

  const token = 'x'.repeat(40);
  const r = await postJson(port, '/subscribe', { token, nation: 45, volcano: true, volcanoObs: true,
    region: { pref: 13, name: '東京都', min: 30 }, watch: [{ pref: 1, name: '北海道', min: 40 }, { pref: 13, name: '東京都', min: 30 }, { pref: 27, name: '大阪府', min: 40 }, { pref: 1, name: '北海道', min: 40 }, { pref: 0, name: '？', min: 40 }] });
  assert.equal(r.ok, true);
  for (const tp of ['quake-alert', 'quake-min-45', 'quake-pref-13-30', 'quake-volcano', 'quake-volcano-obs', 'quake-pref-1-40', 'quake-pref-27-40']) assert.ok(r.topics.includes(tp), `${tp} を購読 (${r.topics})`);
  assert.equal(new Set(r.topics).size, r.topics.length, '重複しない（地域と見守りが同じ県でも1回）');
  const off = await postJson(port, '/subscribe', { token, nation: 45, volcano: true, volcanoObs: false, watch: [], prev: { nation: 45, volcano: true, volcanoObs: true, region: { pref: 13, name: '東京都', min: 30 }, watch: [{ pref: 1, name: '北海道', min: 40 }] } });
  assert.ok(!off.topics.includes('quake-volcano-obs') && !off.topics.includes('quake-pref-1-40'));
});
