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
  assert.equal(down.v, 4); assert.equal(down.ws, false); assert.equal(down.wsEver, false);
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
