/* 地理ユーティリティ: 都道府県 / 距離 / 現在地→都道府県 / P2P 地域コード表 */
(() => {
  /* [JISコード, 名称, 県庁所在地の緯度, 経度] */
  const PREFS = [[1,'北海道',43.064,141.347],[2,'青森県',40.824,140.740],[3,'岩手県',39.704,141.153],[4,'宮城県',38.269,140.872],[5,'秋田県',39.719,140.102],[6,'山形県',38.240,140.364],[7,'福島県',37.750,140.468],[8,'茨城県',36.342,140.447],[9,'栃木県',36.566,139.884],[10,'群馬県',36.391,139.060],[11,'埼玉県',35.857,139.649],[12,'千葉県',35.605,140.123],[13,'東京都',35.690,139.692],[14,'神奈川県',35.448,139.643],[15,'新潟県',37.902,139.023],[16,'富山県',36.695,137.211],[17,'石川県',36.595,136.626],[18,'福井県',36.065,136.222],[19,'山梨県',35.664,138.568],[20,'長野県',36.651,138.181],[21,'岐阜県',35.391,136.722],[22,'静岡県',34.977,138.383],[23,'愛知県',35.180,136.907],[24,'三重県',34.730,136.509],[25,'滋賀県',35.004,135.869],[26,'京都府',35.021,135.756],[27,'大阪府',34.686,135.520],[28,'兵庫県',34.691,135.183],[29,'奈良県',34.685,135.833],[30,'和歌山県',34.226,135.168],[31,'鳥取県',35.504,134.238],[32,'島根県',35.472,133.051],[33,'岡山県',34.662,133.935],[34,'広島県',34.397,132.460],[35,'山口県',34.186,131.471],[36,'徳島県',34.066,134.559],[37,'香川県',34.340,134.043],[38,'愛媛県',33.842,132.766],[39,'高知県',33.560,133.531],[40,'福岡県',33.607,130.418],[41,'佐賀県',33.249,130.299],[42,'長崎県',32.745,129.874],[43,'熊本県',32.790,130.742],[44,'大分県',33.238,131.613],[45,'宮崎県',31.911,131.424],[46,'鹿児島県',31.560,130.558],[47,'沖縄県',26.212,127.681]];
  const byCode = new Map(PREFS.map(p => [p[0], p]));

  const rad = (x) => x * Math.PI / 180;
  function haversine(la1, lo1, la2, lo2) {                         // km
    const dl = rad(la2 - la1), dn = rad(lo2 - lo1);
    const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dn / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  /* 現在地 → 最も近い県庁所在地の都道府県（境界ポリゴンを持たない近似。県境付近は誤ることがある） */
  async function reversePref(lat, lon) {
    let best = PREFS[0], bd = Infinity;
    for (const p of PREFS) { const d = haversine(lat, lon, p[2], p[3]); if (d < bd) { bd = d; best = p; } }
    return { code: best[0], name: best[1], label: best[1] + '付近' };
  }

  /* ---- P2P 地域コード表（地震感知情報 561 の area → 都道府県 / 座標） ---- */
  const AREA_URLS = [
    'https://raw.githubusercontent.com/p2pquake/epsp-specifications/master/epsp-area.csv',
    'https://cdn.jsdelivr.net/gh/p2pquake/epsp-specifications@master/epsp-area.csv'
  ];
  const CACHE_KEY = 'eqm.areas.v2';
  const findPref = (s) => PREFS.find(p => p[1] === s) || PREFS.find(p => p[0] !== 1 && p[1].slice(0, -1) === s);

  function parseAreaCsv(text) {
    const out = [];
    for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const f = raw.split(/[,\t]/).map(x => x.trim().replace(/^"|"$/g, ''));
      if (f.length < 2 || !/^\d+$/.test(f[0])) continue;                // ヘッダー行などは読み飛ばす
      const code = +f[0];
      let pref = null, name = '', lat = NaN, lon = NaN;
      for (const x of f.slice(1)) {
        if (!pref && findPref(x)) { pref = findPref(x); continue; }
        if (/^-?\d+\.\d+$/.test(x)) { const v = +x; if (v > 20 && v < 50 && Number.isNaN(lat)) lat = v; else if (v > 120 && v < 155 && Number.isNaN(lon)) lon = v; continue; }
        if (!name && x && !/^\d+$/.test(x)) name = x;
      }
      if (!pref) continue;
      if (Number.isNaN(lat) || Number.isNaN(lon)) {                        // 座標が無い表: 県庁所在地の周囲に決まった位置で散らす
        const r1 = Math.abs(Math.sin(code * 12.9898) * 43758.5453) % 1, r2 = Math.abs(Math.sin(code * 78.233) * 12345.6789) % 1;
        const ang = 2 * Math.PI * r1, rad_ = 0.08 + 0.30 * r2;
        lat = pref[2] + Math.sin(ang) * rad_; lon = pref[3] + Math.cos(ang) * rad_ * 1.2;
      }
      out.push([code, pref[1], name, +lat.toFixed(4), +lon.toFixed(4)]);
    }
    return out;
  }
  const toMap = (rows) => new Map(rows.map(r => [r[0], { code: r[0], pref: r[1], name: r[2], lat: r[3], lon: r[4] }]));

  let pending = null;
  function loadAreas() {
    if (pending) return pending;
    pending = (async () => {
      try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); if (Array.isArray(c) && c.length >= 30) return toMap(c); } catch { /* noop */ }
      for (const u of AREA_URLS) {
        try {
          const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 9000);
          const r = await fetch(u, { signal: ctl.signal, cache: 'force-cache' }); clearTimeout(t);
          if (!r.ok) continue;
          const rows = parseAreaCsv(await r.text());
          if (rows.length >= 30) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(rows)); } catch { /* noop */ } return toMap(rows); }
        } catch { /* 次の取得先へ */ }
      }
      pending = null;                                                     // 失敗時は次回また試す
      return new Map();
    })();
    return pending;
  }

  window.Geo = { PREFS, byCode, haversine, reversePref, loadAreas, _parseAreaCsv: parseAreaCsv };
})();
