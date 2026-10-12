import test from 'node:test';
import assert from 'node:assert/strict';
import { PREFS, normalizeSub, topicsOf, QuakeTracker, AlertTracker } from './logic.js';

const q = (id, o = {}) => ({ code: 551, id, issue: { type: o.type || 'DetailScale' },
  earthquake: { time: o.time || '2026/10/12 12:00:00', maxScale: o.scale ?? 30, domesticTsunami: 'None',
    hypocenter: { name: o.name ?? '能登半島沖', magnitude: o.mag ?? 5.1, depth: o.depth ?? 10 } }, points: o.points || [] });
const topics = (r, f = () => true) => r.filter(f).map(x => `${x.topic}${x.renotify ? '' : '(silent)'}`).sort();

test('47都道府県', () => { assert.equal(PREFS.length, 47); assert.equal(new Set(PREFS).size, 47); });

test('normalizeSub: 新形式 / 旧形式 / 不正値', () => {
  assert.deepEqual(normalizeSub({ nation: 40, region: { name: '石川県', pref: 17, min: 30 } }), { nation: 40, region: { idx: 17, min: 30 } });
  assert.deepEqual(normalizeSub({ nation: null, region: null }), { nation: null, region: null });
  assert.deepEqual(normalizeSub({ minScale: 45 }), { nation: 45, region: null });
  assert.deepEqual(normalizeSub({ nation: 999, region: { name: 'ほげ', pref: 99, min: 7 } }), { nation: null, region: null });
  assert.deepEqual(normalizeSub({ nation: 30, region: { pref: 13, min: 999 } }).region, { idx: 13, min: 30 });
});
test('topicsOf: 常に alert を含む', () => {
  assert.deepEqual(topicsOf({ nation: null, region: null }), ['quake-alert']);
  assert.deepEqual(topicsOf({ nation: 30, region: { idx: 17, min: 10 } }), ['quake-alert', 'quake-min-30', 'quake-pref-17-10']);
});

test('震度速報→震源情報→各地の震度: 通知は段階的で重複しない', () => {
  const t = new QuakeTracker();
  let r = t.update(q('a', { type: 'ScalePrompt', scale: 40, name: '', mag: -1, depth: -1, points: [{ pref: '石川県', addr: '能登町', scale: 40 }] }));
  assert.deepEqual(topics(r, x => x.topic.startsWith('quake-min')), ['quake-min-10', 'quake-min-30', 'quake-min-40']);
  assert.deepEqual(topics(r, x => x.topic.startsWith('quake-pref')), ['quake-pref-17-10', 'quake-pref-17-30', 'quake-pref-17-40']);
  r = t.update(q('b', { type: 'Destination', scale: 40 }));
  assert.ok(r.length > 0 && r.every(x => x.renotify === false), '更新は無音');
  assert.ok(r.every(x => x.body.includes('能登半島沖')));
  assert.deepEqual(t.update(q('c', { scale: 40 })), []);
  assert.deepEqual(t.update(q('c', { scale: 40 })), []);
});

test('最大震度が上がったら新しく超えたしきい値だけ通知', () => {
  const t = new QuakeTracker();
  t.update(q('a', { scale: 30 }));
  const r = t.update(q('b', { scale: 50 }));
  assert.deepEqual(topics(r), ['quake-min-40', 'quake-min-45']);
  assert.ok(r.every(x => x.renotify));
});

test('地域別: 都道府県ごとに判定', () => {
  const t = new QuakeTracker();
  const r = t.update(q('a', { scale: 50, points: [{ pref: '石川県', scale: 50 }, { pref: '富山県', scale: 30 }] }));
  const reg = topics(r, x => x.topic.startsWith('quake-pref'));
  assert.ok(reg.includes('quake-pref-17-45') && !reg.includes('quake-pref-17-55'));
  assert.ok(reg.includes('quake-pref-16-30') && !reg.includes('quake-pref-16-40'));
  assert.equal(r.find(x => x.topic === 'quake-pref-17-10').title, '石川県で震度5強');
});

test('遠地地震・震度不明は送らない / 別の地震は別イベント', () => {
  const t = new QuakeTracker();
  assert.deepEqual(t.update(q('f', { type: 'Foreign', scale: -1 })), []);
  assert.deepEqual(t.update(q('g', { scale: -1 })), []);
  assert.ok(t.update(q('h', { scale: 30, time: '2026/10/12 13:30:00', name: '千葉県東方沖' })).length > 0);
});

test('津波: 重複抑止 / 解除は1回だけ', () => {
  const a = new AlertTracker();
  const m = { code: 552, id: '1', areas: [{ name: '能登半島', grade: 'Warning' }] };
  assert.equal(a.tsunami(m).length, 1);
  assert.equal(a.tsunami({ ...m, id: '2' }).length, 0);
  assert.equal(a.tsunami({ code: 552, id: '3', cancelled: true }).length, 1);
  assert.equal(a.tsunami({ code: 552, id: '4', cancelled: true }).length, 0);
  assert.equal(a.tsunami(m)[0].topic, 'quake-alert');
});

test('緊急地震速報: 第1報のみ / テスト除外 / 取り消しは無音', () => {
  const a = new AlertTracker();
  const e = { code: 556, id: 'x1', issue: { eventId: 'E1' }, earthquake: { hypocenter: { name: '千葉県南部' } }, areas: [{ name: '千葉県北西部', scaleTo: 50 }] };
  const r = a.eewAlert(e);
  assert.equal(r.length, 1); assert.equal(r[0].topic, 'quake-alert'); assert.ok(r[0].body.includes('予想最大震度5強'));
  assert.equal(a.eewAlert({ ...e, id: 'x2' }).length, 0);
  assert.equal(a.eewAlert({ ...e, id: 'y', test: true, issue: { eventId: 'T' } }).length, 0);
  const c = a.eewAlert({ ...e, id: 'x3', cancelled: true });
  assert.equal(c.length, 1); assert.equal(c[0].renotify, false);
});
