'use strict';
// ============================================================
// サイネージ用スクリプト（無操作・常時表示）
//   ・今週/来週を表示。日付が変わったら自動で送る
//   ・index.json を定期チェックし、変わった月だけ取り直す
//   ・通信が落ちても直前の内容を出し続ける
//   ・1日1回ページ自体を再読込して、コード更新も自動で拾う
// ============================================================

const REFRESH_MS   = 5 * 60 * 1000;   // データ確認の間隔
const TICK_MS      = 15 * 1000;       // 状態・日付跨ぎの確認
const RELOAD_MS    = 24 * 60 * 60 * 1000; // ページ自体の再読込
const SHIFT_MS     = 7 * 60 * 1000;   // 焼き付き防止のずらし
const WD = ['日', '月', '火', '水', '木', '金', '土'];

const el = (id) => document.getElementById(id);
// 縦置きは1行あたりの高さが限られるので、出す件数を絞る
const portrait = matchMedia('(max-aspect-ratio: 1/1)');
const maxShown = () => (portrait.matches ? 3 : 4);
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// JST固定で「今」を扱う（表示端末のタイムゾーン設定に左右されないように）
const TZ = 9 * 60;
const nowJstMin = () => Math.floor(Date.now() / 60000) + TZ;
const dayStart = (min) => Math.floor(min / 1440) * 1440;
const partsOf = (min) => {
  const d = new Date(min * 60000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay() };
};
const mkeyOf = (min) => { const p = partsOf(min); return `${p.y}-${pad(p.m)}`; };

/** その日を含む週の月曜0時（JSTエポック分） */
function mondayOf(min) {
  const p = partsOf(min);
  const back = (p.w + 6) % 7; // 日曜=6日戻る
  return dayStart(min) - back * 1440;
}

const state = {
  index: null,
  months: new Map(),   // "2026-08" -> {t,l,e,k,h}
  labels: ['貸切', '公開'],
  weekStart: 0,
  lastGood: 0,
  reloadAt: Date.now() + RELOAD_MS,
};

// ---------- 取得 ----------
async function fetchJson(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** index.json を見て、必要な月のデータを揃える。更新があれば true */
async function sync() {
  const idx = await fetchJson('data/index.json', { cache: 'no-cache' });
  const changed = !state.index || state.index.v !== idx.v;
  state.index = idx;

  const need = new Set();
  for (let d = state.weekStart; d < state.weekStart + 14 * 1440; d += 1440) need.add(mkeyOf(d));

  let loaded = false;
  for (const key of need) {
    if (!changed && state.months.has(key)) continue;
    if (!idx.months[key]) { state.months.set(key, null); continue; }
    try {
      // URLにバージョンを付ける。同じ版ならキャッシュがそのまま効き、
      // 版が変われば別URLになるので確実に新しいものを取りに行く
      const data = await fetchJson(`data/${key}.json?v=${idx.v}`, { cache: 'force-cache' });
      state.months.set(key, data);
      if (data.k) state.labels = data.k;
      loaded = true;
    } catch (e) {
      if (!state.months.has(key)) state.months.set(key, null);
    }
  }
  state.lastGood = Date.now();
  return changed || loaded;
}

/** 指定日の予定を取り出す */
function eventsOn(dayMin) {
  const p = partsOf(dayMin);
  const data = state.months.get(`${p.y}-${pad(p.m)}`);
  if (!data) return [];
  return data.e
    .filter((r) => r[0] === p.d)
    .map((r) => ({ s: r[1], e: r[2], title: data.t[r[3]] || '', span: r[5] || 0, kind: r[6] || 0 }))
    .sort((a, b) => a.s - b.s);
}

// ---------- 描画 ----------

/** 予定チップのHTML */
function evHtml(ev) {
  let t;
  if (ev.s < 0) t = '終日';
  else if (ev.span === 1) t = `${hhmm(ev.s)} →`;
  else if (ev.span === 2) t = '終日 →';
  else if (ev.span === 3) t = `→ ${hhmm(ev.e)}`;
  else t = `${hhmm(ev.s)}–${hhmm(ev.e)}`;
  return `<div class="ev${ev.kind ? ' open' : ''}">
      <span class="ev-time">${t}</span>
      <span class="ev-name">${esc(ev.title)}</span>
    </div>`;
}

/** 今週：主役。1日1枚のカードで大きく出す */
function renderThisWeek() {
  const today = dayStart(nowJstMin());
  const frag = document.createDocumentFragment();

  for (let i = 0; i < 7; i++) {
    const dayMin = state.weekStart + i * 1440;
    const p = partsOf(dayMin);
    const evs = eventsOn(dayMin);

    const card = document.createElement('div');
    card.className = 'day' +
      (dayMin === today ? ' today' : dayMin < today ? ' past' : '') +
      (p.w === 0 ? ' sun' : p.w === 6 ? ' sat' : '');

    // 「今日」バッジも日付ブロックの中に入れて、予定チップの開始位置を揃える
    const head = `<div class="day-head">
        <span class="day-num">${p.m}/${p.d}</span>
        <span class="day-wd">${WD[p.w]}</span>
        ${dayMin === today ? '<span class="badge-today">今日</span>' : ''}
      </div>`;

    let body;
    if (!evs.length) {
      body = `<div class="free-mark">空き</div>`;
    } else {
      const shown = evs.slice(0, maxShown());
      body = '<div class="evs">' + shown.map(evHtml).join('') +
        (evs.length > shown.length ? `<span class="ev-more">ほか${evs.length - shown.length}件</span>` : '') +
        '</div>';
    }
    card.innerHTML = head + body;
    frag.appendChild(card);
  }
  el('week0').replaceChildren(frag);
}

/** 来週：おまけ。貸切か空きかだけ分かればよい */
function renderNextWeek() {
  const frag = document.createDocumentFragment();

  for (let i = 0; i < 7; i++) {
    const dayMin = state.weekStart + (7 + i) * 1440;
    const p = partsOf(dayMin);
    const evs = eventsOn(dayMin);
    const busy = evs.some((ev) => ev.kind === 0);

    const cell = document.createElement('div');
    cell.className = 'mini-day' + (busy ? ' busy' : '') +
      (p.w === 0 ? ' sun' : p.w === 6 ? ' sat' : '');
    const state_ = evs.length
      ? (busy ? state.labels[0] : state.labels[1]) + (evs.length > 1 ? ` ${evs.length}件` : '')
      : '空き';
    cell.innerHTML = `<span class="mini-date">${p.m}/${p.d}</span>` +
      `<span class="mini-wd">${WD[p.w]}</span>` +
      `<span class="mini-state">${esc(state_)}</span>`;
    frag.appendChild(cell);
  }
  el('week1').replaceChildren(frag);
}

function renderWeeks() {
  renderThisWeek();
  renderNextWeek();
}

/** ヘッダの「ただいま」表示 */
function renderStatus() {
  const now = nowJstMin();
  const today = dayStart(now);
  const tod = now - today;
  const evs = eventsOn(today).filter((ev) => ev.kind === 0);

  const current = evs.find((ev) => (ev.s < 0) || (tod >= ev.s && tod < ev.e));
  const box = el('status');
  const label = el('status-label');
  const detail = el('status-detail');

  if (current) {
    box.className = 'status busy';
    label.textContent = `ただいま${state.labels[0]}中`;
    detail.textContent = current.s < 0
      ? current.title
      : `${current.title}／${hhmm(current.e)} まで`;
  } else {
    box.className = 'status free';
    label.textContent = 'ただいま自由に使えます';
    const next = evs.find((ev) => ev.s > tod);
    detail.textContent = next
      ? `次の${state.labels[0]}は ${hhmm(next.s)} から（${next.title}）`
      : '今日はこのあと予定がありません';
  }
}

function renderClock() {
  const now = nowJstMin();
  const p = partsOf(now);
  el('clock-time').textContent = hhmm(now - dayStart(now));
  el('clock-date').textContent = `${p.y}年${p.m}月${p.d}日（${WD[p.w]}）`;
}

function renderFoot() {
  const foot = el('foot');
  const stale = Date.now() - state.lastGood > 30 * 60 * 1000;
  const gen = state.index ? new Date(state.index.gen) : null;
  const t = gen ? gen.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  foot.className = 'foot' + (stale ? ' stale' : '');
  foot.textContent = stale ? `更新できていません（最終 ${t}）` : `最終更新 ${t}`;
}

// ---------- 常時稼働のループ ----------
async function refresh(force) {
  try {
    const changed = await sync();
    if (changed || force) renderWeeks();
  } catch {
    // 通信断。前回の表示をそのまま残す
  }
  renderStatus();
  renderFoot();
}

function tick() {
  renderClock();
  renderStatus();
  renderFoot();

  // 日付が変わって週がずれたら week を送り直す
  const ws = mondayOf(nowJstMin());
  if (ws !== state.weekStart) {
    state.weekStart = ws;
    refresh(true);
  }
  // 長時間の連続稼働に備えて1日1回だけ読み込み直す
  if (Date.now() > state.reloadAt) location.reload();
}

/** 焼き付き防止に数分ごとに数ピクセルだけ動かす */
function drift() {
  const n = Math.floor(Date.now() / SHIFT_MS) % 4;
  const x = [0, 3, 3, 0][n];
  const y = [0, 0, 3, 3][n];
  document.body.style.setProperty('--shift-x', `${x}px`);
  document.body.style.setProperty('--shift-y', `${y}px`);
}

(async function init() {
  state.weekStart = mondayOf(nowJstMin());
  renderClock();
  drift();
  await refresh(true);

  setInterval(tick, TICK_MS);
  setInterval(() => refresh(false), REFRESH_MS);
  setInterval(drift, 60 * 1000);
  // 復帰時はすぐ取り直す
  addEventListener('online', () => refresh(true));
  // 画面の向きが変わったら件数を調整して描き直す
  portrait.addEventListener('change', () => renderWeeks());
  addEventListener('resize', () => renderWeeks());
})();
