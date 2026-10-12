/* 統計画面の描画: Stats.render(body, events, days, now, { end }) / Stats.bindTips(body, tipEl)
   events: app.js の正規化済みイベント { t, name, scale, mag, depth, type, ... } */
(() => {
  const DAY = 864e5, JST = 9 * 3600e3;
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* 震度の表示名と色（app.js と同じ配色） */
  const SC = [[10, '1', '#6db3f2', '#031526'], [20, '2', '#4fd1a0', '#032015'], [30, '3', '#ffe14d', '#2a2300'], [40, '4', '#ff9f2e', '#2e1500'], [45, '5弱', '#ff4538', '#ffffff'], [50, '5強', '#d4143c', '#ffffff'], [55, '6弱', '#d92ba6', '#ffffff'], [60, '6強', '#9b3bef', '#ffffff'], [70, '7', '#5a2bd9', '#ffffff']];
  const scKey = (v) => (v === 46 ? 45 : v);                              // 5弱以上は5弱に含める
  const scName = (v) => { const s = SC.find(x => x[0] === scKey(v)); return s ? s[1] : '不明'; };
  const jd = (t) => new Date(t + JST);                                     // UTC getter で JST の値になる
  const md = (t) => { const d = jd(t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
  const dayIndex = (t) => Math.floor((t + JST) / DAY);

  function hbars(rows, { wide = false, label = false } = {}) {
    const max = Math.max(1, ...rows.map(r => r.n));
    return `<div class="hbars">${rows.map(r => `<div class="hrow${wide ? ' wide' : ''}" ${r.tip ? `data-tip="${esc(r.tip)}"` : ''} style="--c:${r.c || 'var(--md-primary)'};--fg:${r.fg || '#fff'}">
      ${label ? `<span class="lab">${esc(r.k)}</span>` : `<span class="nm">${esc(r.k)}</span>`}<span class="track"><i style="width:${(r.n / max * 100).toFixed(1)}%"></i></span><span>${r.n}</span></div>`).join('')}</div>`;
  }
  function bars(items, { xl }) {                                          // items: [{ n, tip, c }]
    const max = Math.max(1, ...items.map(i => i.n)), top = Math.ceil(max / 5) * 5 || 5;
    const grid = [1, .5].map(f => `<div class="grid" style="bottom:${f * 100}%"><i>${Math.round(top * f)}</i></div>`).join('');
    return `<div class="chart"><div class="bars">${grid}${items.map(i => `<button class="bar${i.n ? '' : ' zero'}" type="button" data-tip="${esc(i.tip)}" aria-label="${esc(i.tip)}"><i style="height:${i.n ? Math.max(3, i.n / top * 100).toFixed(1) : 0}%;${i.c ? `background:${i.c}` : ''}"></i></button>`).join('')}</div>
      <div class="xlabels">${xl.map(x => `<span>${esc(x)}</span>`).join('')}</div></div>`;
  }

  function render(body, events, days, now, opts = {}) {
    const from = now - days * DAY;
    const list = events.filter(e => e.t >= from && e.t <= now + 3600e3 && e.type !== 'Foreign');
    const domestic = list.filter(e => e.scale >= 10);
    const oldest = events.length ? Math.min(...events.map(e => e.t)) : now;
    const partial = !opts.end && oldest > from + DAY;                      // 取得済みの履歴が期間の途中までしかない
    const maxScale = domestic.reduce((m, e) => Math.max(m, scKey(e.scale)), -1);
    const strongest = domestic.filter(e => scKey(e.scale) === maxScale).sort((a, b) => b.t - a.t)[0];
    const maxMag = list.reduce((b, e) => (e.mag > (b ? b.mag : -1) ? e : b), null);
    const sc = (v) => SC.find(x => x[0] === v);

    /* 日別 */
    const n0 = dayIndex(from), n1 = dayIndex(now), perDay = new Array(n1 - n0 + 1).fill(0), strongDay = new Array(perDay.length).fill(-1);
    list.forEach(e => { const i = dayIndex(e.t) - n0; if (i >= 0 && i < perDay.length) { perDay[i]++; strongDay[i] = Math.max(strongDay[i], scKey(e.scale)); } });
    const dayItems = perDay.map((n, i) => { const t = (n0 + i) * DAY - JST + DAY / 2, s = sc(strongDay[i]); return { n, tip: `${md(t)}  ${n}回${s ? `（最大震度${s[1]}）` : ''}`, c: s && strongDay[i] >= 45 ? s[2] : '' }; });
    const mid = (n0 + Math.floor(perDay.length / 2)) * DAY - JST;
    /* 震度別 */
    const byScale = SC.map(s => ({ k: s[1], n: domestic.filter(e => scKey(e.scale) === s[0]).length, c: s[2], fg: s[3], tip: `震度${s[1]}` })).reverse();
    /* 震源地 */
    const place = new Map(); list.forEach(e => { if (e.name) place.set(e.name, (place.get(e.name) || 0) + 1); });
    const topPlace = [...place.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8).map(([k, n]) => ({ k, n, tip: `${k} ${n}回` }));
    /* マグニチュード */
    const MB = [[0, 3, 'M3未満'], [3, 4, 'M3台'], [4, 5, 'M4台'], [5, 6, 'M5台'], [6, 7, 'M6台'], [7, 99, 'M7以上']];
    const byMag = MB.map(([a, b, k]) => ({ k, n: list.filter(e => e.mag >= a && e.mag < b).length, tip: k })).filter((r, i, all) => r.n || i < all.length);
    /* 時間帯（JST） */
    const hours = new Array(24).fill(0); list.forEach(e => { hours[jd(e.t).getUTCHours()]++; });
    const hourItems = hours.map((n, h) => ({ n, tip: `${h}時台  ${n}回` }));
    /* 深さ */
    const DB = [[0, 10, '〜10km'], [10, 30, '10〜30km'], [30, 60, '30〜60km'], [60, 100, '60〜100km'], [100, 1e4, '100km〜']];
    const byDepth = DB.map(([a, b, k]) => ({ k, n: list.filter(e => e.depth >= a && e.depth < b).length, tip: k }));

    body.innerHTML = `
      ${partial ? `<p class="hint">読み込み済みの履歴は ${esc(md(oldest))} 以降です。この期間の全件ではない場合があります（${opts.end ? '' : '古い履歴を読み込み中…'}）。</p>` : ''}
      <div class="tiles">
        <div class="tile"><small>地震の回数</small><b>${list.length}</b><span>直近${days}日 ・ 1日平均 ${(list.length / days).toFixed(1)}回</span></div>
        <div class="tile"><small>震度3以上</small><b>${domestic.filter(e => e.scale >= 30).length}</b><span>回</span></div>
        <div class="tile"><small>震度5弱以上</small><b>${domestic.filter(e => e.scale >= 45).length}</b><span>回</span></div>
        <div class="tile"><small>最大震度</small><b>${maxScale >= 0 ? esc(scName(maxScale)) : '—'}</b><span>${strongest ? esc(strongest.name || '震源調査中') + ' ' + esc(md(strongest.t)) : ''}</span></div>
        <div class="tile"><small>最大マグニチュード</small><b>${maxMag && maxMag.mag >= 0 ? 'M' + maxMag.mag.toFixed(1) : '—'}</b><span>${maxMag && maxMag.mag >= 0 ? esc(maxMag.name || '') + ' ' + esc(md(maxMag.t)) : ''}</span></div>
      </div>
      <div class="cards">
        <section class="card" style="grid-column:1/-1"><h3>日別の発生回数</h3><p class="sub">棒をタップで詳細。震度5弱以上の日は震度の色で表示します。</p>${bars(dayItems, { xl: [md(from), md(mid), md(now)] })}</section>
        <section class="card"><h3>震度別</h3><p class="sub">最大震度ごとの回数</p>${hbars(byScale, { label: true })}</section>
        <section class="card"><h3>震源地の多い順</h3><p class="sub">上位8か所</p>${topPlace.length ? hbars(topPlace, { wide: true }) : '<p class="sub">データなし</p>'}</section>
        <section class="card"><h3>マグニチュード別</h3><p class="sub">M不明を除く</p>${hbars(byMag)}</section>
        <section class="card"><h3>震源の深さ別</h3><p class="sub">深さ不明を除く</p>${hbars(byDepth)}</section>
        <section class="card" style="grid-column:1/-1"><h3>時間帯別（日本時間）</h3><p class="sub">0時〜23時</p>${bars(hourItems, { xl: ['0時', '6時', '12時', '18時', '23時'] })}</section>
      </div>`;
  }

  /* 棒・行に data-tip がある要素を、マウスのホバー / タッチのタップでツールチップ表示 */
  function bindTips(body, tip) {
    if (!tip || body._tipsBound) return; body._tipsBound = true;
    try { tip.setAttribute('popover', 'manual'); } catch { /* noop */ }      // <dialog> の最前面レイヤーより上に出す
    const hide = () => { clearTimeout(tip._t); try { if (tip.matches(':popover-open')) tip.hidePopover(); } catch { /* noop */ } tip.hidden = true; };
    const show = (el) => {
      const r = el.getBoundingClientRect();
      tip.textContent = el.dataset.tip; tip.hidden = false;
      try { if (tip.showPopover && !tip.matches(':popover-open')) tip.showPopover(); } catch { /* noop */ }
      tip.style.left = Math.min(innerWidth - 60, Math.max(60, r.left + r.width / 2)) + 'px'; tip.style.top = Math.max(30, r.top) + 'px';
      clearTimeout(tip._t); tip._t = setTimeout(hide, 3200);
    };
    body.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-tip]'); if (el && e.pointerType === 'mouse') show(el); });
    body.addEventListener('pointerout', (e) => { if (e.pointerType === 'mouse' && e.target.closest('[data-tip]')) hide(); });
    body.addEventListener('click', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); else hide(); });
    body.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
    body.addEventListener('scroll', hide, { passive: true });
  }

  window.Stats = { render, bindTips };
})();
