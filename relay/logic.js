/**
 * 中継サーバーの純粋ロジック（外部依存なし・単体テスト可能）
 *  - 購読内容の検証 / トピック算出
 *  - 地震情報(551)の統合と「新たにしきい値を超えた端末だけ」への通知判定
 *  - 津波(552) / 緊急地震速報(556)の重複抑止
 */
export const THRESHOLDS = [10, 30, 40, 45, 55];            // 端末が選べる最小震度（P2P震度値）
export const TOPIC_ALERT = 'quake-alert';                  // 全端末: 津波・緊急地震速報
export const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];

export const topicNation = (t) => `quake-min-${t}`;
export const topicRegion = (idx, t) => `quake-pref-${idx}-${t}`;   // idx: 1..47

/* ---------- 購読内容 ---------- */
const validMin = (v, d) => (THRESHOLDS.includes(v) ? v : d);
/** クライアントの { nation, region:{name,pref,min} } を検証して正規化（旧形式 {minScale} も受け付ける） */
export function normalizeSub(b) {
  const out = { nation: null, region: null };
  if (!b || typeof b !== 'object') return out;
  if ('nation' in b) out.nation = THRESHOLDS.includes(b.nation) ? b.nation : null;
  else if ('minScale' in b) out.nation = validMin(b.minScale, 30);
  const r = b.region;
  if (r && typeof r === 'object') {
    let idx = PREFS.indexOf(r.name) + 1;
    if (!idx && Number.isInteger(r.pref) && r.pref >= 1 && r.pref <= 47) idx = r.pref;   // 都道府県コード(JIS順)フォールバック
    if (idx) out.region = { idx, min: validMin(r.min, 30) };
  }
  return out;
}
export function topicsOf(sub, { alert = true } = {}) {
  const s = [];
  if (alert) s.push(TOPIC_ALERT);
  if (sub.nation != null) s.push(topicNation(sub.nation));
  if (sub.region) s.push(topicRegion(sub.region.idx, sub.region.min));
  return s;
}

/* ---------- 表示整形 ---------- */
const SCALE_TXT = { 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 46: '5弱以上', 50: '5強', 55: '6弱', 60: '6強', 70: '7' };
export const scaleTxt = (v) => SCALE_TXT[v] || '不明';
const hm = (s) => (String(s || '').match(/(\d{2}:\d{2})/) || [])[1] || '';
export function parseJst(s) {
  const m = String(s || '').match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0)) : NaN;
}
const GRADE = { MajorWarning: ['大津波警報', 4], Warning: ['津波警報', 3], Watch: ['津波注意報', 2], Unknown: ['津波予報', 1] };

/* ---------- 地震情報(551) ---------- */
export class QuakeTracker {
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
      ev = { t, name: '', mag: -1, depth: -1, scale: -1, tsu: '', timeStr: '', ids: new Set(), prefMax: new Map(), nationDone: -1, regionDone: new Map(), tag: 'eq-' + String(e.time || '').slice(0, 16), seen: now };
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
      if (p && p.pref && Number.isFinite(p.scale) && (ev.prefMax.get(p.pref) || 0) < p.scale) ev.prefMax.set(p.pref, p.scale);
    });

    const depthTxt = ev.depth === 0 ? 'ごく浅い' : ev.depth > 0 ? `深さ${ev.depth}km` : '';
    const body = [ev.name || '震源調査中', ev.mag >= 0 ? `M${ev.mag.toFixed(1)}` : '', depthTxt, hm(ev.timeStr) ? `${hm(ev.timeStr)}頃発生` : ''].filter(Boolean).join(' ');
    const urgent = ev.scale >= 55 || ev.tsu === 'Warning';
    const base = { tag: ev.tag, kind: '551', mid: String(m.id ?? ''), urgent, ttl: 600 };
    const out = [];

    // 全国: 新たにしきい値を超えたトピックへ通知音あり / 既に通知済みで震源名が判明したトピックへは静かに更新
    for (const th of THRESHOLDS) {
      if (th > ev.scale) continue;
      if (th > ev.nationDone) out.push({ ...base, topic: topicNation(th), title: `地震 最大震度${scaleTxt(ev.scale)}`, body, renotify: true });
      else if (filled) out.push({ ...base, topic: topicNation(th), title: `地震 最大震度${scaleTxt(ev.scale)}`, body, renotify: false });
    }
    ev.nationDone = Math.max(ev.nationDone, ev.scale);

    // 地域別: 都道府県ごとの最大震度で判定
    for (const [pref, max] of ev.prefMax) {
      const idx = PREFS.indexOf(pref) + 1; if (!idx) continue;
      const done = ev.regionDone.get(pref) || 0;
      for (const th of THRESHOLDS) {
        if (th > max) continue;
        const title = `${pref}で震度${scaleTxt(max)}`;
        if (th > done) out.push({ ...base, topic: topicRegion(idx, th), title, body, renotify: true });
        else if (filled) out.push({ ...base, topic: topicRegion(idx, th), title, body, renotify: false });
      }
      ev.regionDone.set(pref, Math.max(done, max));
    }
    return out;
  }
}

/* ---------- 津波(552) / 緊急地震速報(556) ---------- */
export class AlertTracker {
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
    for (const [k, v] of this.eew) if (now - v > 3600e3) this.eew.delete(k);
    if (m.cancelled) {
      if (!this.eew.has(id)) return [];
      return [{ ...base, title: '緊急地震速報 取り消し', body: '先に発表された緊急地震速報（警報）は取り消されました', urgent: false, renotify: false }];
    }
    if (this.eew.has(id)) return [];
    this.eew.set(id, now);
    const h = (m.earthquake && m.earthquake.hypocenter) || {};
    const areas = [...new Set((m.areas || []).map(a => a.name).filter(Boolean))];
    const mx = Math.max(0, ...(m.areas || []).map(a => (SCALE_TXT[a.scaleTo] ? a.scaleTo : SCALE_TXT[a.scaleFrom] ? a.scaleFrom : 0)));
    const body = `${h.name || '震源調査中'}${mx ? ` 予想最大震度${scaleTxt(mx)}` : ''} 強い揺れに警戒してください${areas.length ? '\n' + areas.slice(0, 6).join('、') + (areas.length > 6 ? ' ほか' : '') : ''}`;
    return [{ ...base, title: '緊急地震速報（警報）', body, urgent: true, renotify: true }];
  }
}
