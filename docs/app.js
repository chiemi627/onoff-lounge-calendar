'use strict';
// ============================================================
// 軽量ICSビューア（クライアント側）
//   - index.json だけ毎回検証（数百バイト）
//   - 月データは version が同じならlocalStorageから再利用＝通信ゼロ
//   - 表示する月だけ取得。隣の月はアイドル時に先読み
// ============================================================

const KEY = 'lounge-cal:';
const el = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const mkey = (y, m) => `${y}-${pad(m)}`;

const state = {
  ready: false, index: null, cache: new Map(), y: 0, m: 0, selDay: 0, today: null,
  labels: ['貸切', '公開'], hours: [510, 1200],
};

// ---------- ストレージ（容量オーバー等は握りつぶす） ----------
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(KEY + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* noop */ } },
  purge(v) {
    try {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(KEY)) continue;
        const o = store.get(k.slice(KEY.length));
        if (o && o.v && o.v !== v) localStorage.removeItem(k);
      }
    } catch { /* noop */ }
  },
};

// ---------- 日付（JST固定で扱う） ----------
function jstNow() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
const dowOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const hhmm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

// ---------- データ取得 ----------
async function loadIndex() {
  try {
    const res = await fetch('data/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const idx = await res.json();
    store.set('index', idx);
    store.purge(idx.v);
    return { idx, live: true };
  } catch {
    const idx = store.get('index');
    if (!idx) throw new Error('データを取得できませんでした');
    return { idx, live: false };
  }
}

async function loadMonth(key) {
  if (state.cache.has(key)) return state.cache.get(key);
  if (!state.index.months[key]) { state.cache.set(key, null); return null; }

  const cached = store.get(key);
  if (cached && cached.v === state.index.v) { state.cache.set(key, cached); return cached; }

  try {
    const res = await fetch(`data/${key}.json`, { cache: 'force-cache' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    store.set(key, data);
    state.cache.set(key, data);
    return data;
  } catch {
    if (cached) { state.cache.set(key, cached); return cached; }
    return null;
  }
}

/** 月データ → 日ごとの配列 { s, e, title, span, kind } */
function byDay(data) {
  const map = new Map();
  if (!data) return map;
  state.labels = data.k || ['貸切', '公開'];
  state.hours = data.h || [510, 1200];
  for (const r of data.e) {
    const [day, s, e, ti, , span, kind] = r;
    if (!map.has(day)) map.set(day, []);
    map.get(day).push({ s, e, title: data.t[ti] || '', span: span || 0, kind: kind || 0 });
  }
  return map;
}

/** 開放時間を 0–100% にマップした帯の位置 */
function barStyle(ev) {
  const [from, to] = state.hours;
  const span = Math.max(1, to - from);
  if (ev.s < 0 || ev.span === 2) return 'left:0;width:100%';
  const a = Math.min(Math.max(ev.s, from), to);
  const b = Math.min(Math.max(ev.e, from), to);
  const left = ((a - from) / span) * 100;
  const width = Math.max(8, ((b - a) / span) * 100);
  return `left:${left.toFixed(1)}%;width:${Math.min(width, 100 - left).toFixed(1)}%`;
}

// ---------- 描画 ----------
function renderGrid(map) {
  const { y, m } = state;
  const grid = el('grid');
  const frag = document.createDocumentFragment();
  const lead = dowOf(y, m, 1);
  const n = daysIn(y, m);

  for (let i = 0; i < lead; i++) {
    const c = document.createElement('div');
    c.className = 'cell pad';
    frag.appendChild(c);
  }
  for (let d = 1; d <= n; d++) {
    const evs = map.get(d) || [];
    const w = dowOf(y, m, d);
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'cell' + (w === 0 ? ' sun' : w === 6 ? ' sat' : '') +
      (isToday(y, m, d) ? ' today' : '') + (state.selDay === d ? ' sel' : '');
    c.dataset.day = d;
    if (evs.some((ev) => ev.kind === 0)) c.classList.add('busy');
    const bars = evs.map((ev) => `<i class="${ev.kind ? 'open' : ''}" style="${barStyle(ev)}"></i>`).join('');
    c.innerHTML = `<div class="n">${d}</div>` +
      (evs.length ? `<div class="tl">${bars}</div><div class="tag">${evs.some((ev) => ev.kind === 0) ? esc(state.labels[0]) : esc(state.labels[1])}</div>` : '');
    frag.appendChild(c);
  }
  grid.replaceChildren(frag);
}

const isToday = (y, m, d) => state.today && y === state.today.y && m === state.today.m && d === state.today.d;

function renderAgenda(map) {
  const { y, m } = state;
  const box = el('agenda');
  if (map.size === 0) {
    box.innerHTML = '<p class="empty">この月に予定はありません<br><small>ラウンジは自由に使えます</small></p>';
    return;
  }
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const frag = document.createDocumentFragment();
  for (const d of [...map.keys()].sort((a, b) => a - b)) {
    const sec = document.createElement('section');
    sec.className = 'day' + (isToday(y, m, d) ? ' is-today' : '') + (state.selDay === d ? ' is-sel' : '');
    sec.id = `d${d}`;
    const w = dowOf(y, m, d);
    const rows = map.get(d).sort((a, b) => a.s - b.s).map((ev) => {
      let t;
      if (ev.s < 0) t = '終日';
      else if (ev.span === 1) t = `${hhmm(ev.s)} →`;
      else if (ev.span === 2) t = '終日 →';
      else if (ev.span === 3) t = `→ ${hhmm(ev.e)}`;
      else t = `${hhmm(ev.s)}–${hhmm(ev.e)}`;
      const label = esc(state.labels[ev.kind] || '');
      return `<div class="ev ${ev.kind ? 'is-open' : 'is-excl'}">` +
             `<div class="time">${t}</div>` +
             `<div class="name"><span class="badge">${label}</span>${esc(ev.title)}</div></div>`;
    }).join('');
    sec.innerHTML = `<h2>${m}/${d}<span>(${WD[w]})</span>${isToday(y, m, d) ? '<span>今日</span>' : ''}</h2>${rows}`;
    frag.appendChild(sec);
  }
  box.replaceChildren(frag);
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function show(y, m, opts = {}) {
  state.y = y; state.m = m;
  if (opts.resetSel !== false) state.selDay = 0;
  const map = byDay(await loadMonth(mkey(y, m)));
  if (state.y !== y || state.m !== m) return; // 連打で追い越された
  el('month').textContent = `${y}年${m}月`;
  renderGrid(map);
  renderAgenda(map);
  if (opts.scrollTo) document.getElementById(`d${opts.scrollTo}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  prefetchNeighbors(y, m);
}

function prefetchNeighbors(y, m) {
  const go = () => { for (const s of [1, -1]) { const t = shift(y, m, s); loadMonth(mkey(t.y, t.m)); } };
  ('requestIdleCallback' in window) ? requestIdleCallback(go, { timeout: 2000 }) : setTimeout(go, 600);
}

function shift(y, m, delta) {
  const t = m - 1 + delta;
  return { y: y + Math.floor(t / 12), m: ((t % 12) + 12) % 12 + 1 };
}

// ---------- 起動 ----------
(async function init() {
  const step = (delta) => {
    if (!state.ready) return;
    const t = shift(state.y, state.m, delta);
    show(t.y, t.m);
  };
  el('prev').onclick = () => step(-1);
  el('next').onclick = () => step(1);
  el('today').onclick = () => {
    if (!state.ready) return;
    const t = state.today;
    state.selDay = t.d;
    show(t.y, t.m, { resetSel: false, scrollTo: t.d });
  };
  el('grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell[data-day]');
    if (!cell || !state.ready) return;
    state.selDay = +cell.dataset.day;
    show(state.y, state.m, { resetSel: false, scrollTo: state.selDay });
  });

  // 左右スワイプで月送り
  let x0 = null, y0 = null;
  addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) step(dx < 0 ? 1 : -1);
    x0 = null;
  }, { passive: true });

  try {
    const { idx, live } = await loadIndex();
    state.index = idx;
    state.today = jstNow();
    el('title').textContent = idx.name || 'カレンダー';
    document.title = `${idx.name || 'カレンダー'} 予定`;
    const gen = new Date(idx.gen);
    el('status').textContent =
      (live ? '更新 ' : 'オフライン表示 / ') +
      gen.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    state.selDay = state.today.d;
    state.ready = true;
    await show(state.today.y, state.today.m, { resetSel: false });
  } catch (e) {
    el('title').textContent = 'エラー';
    el('agenda').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
})();
