#!/usr/bin/env node
// ============================================================
// ICS → 軽量JSON 変換
//   node scripts/build.mjs            … ICS_URL から取得
//   node scripts/build.mjs foo.ics    … ローカルファイルから
// ============================================================
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as C from './config.mjs';

const TZ_OFFSET_MIN = 9 * 60; // Asia/Tokyo（このカレンダーはJST固定）

// ---------- ICS パース ----------

/** 折り返し行（先頭が空白）を畳んで、1プロパティ=1行にする */
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

/** RFC5545 の TEXT エスケープを戻す */
function unescapeText(s) {
  return s.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** "NAME;PARAM=x:VALUE" を { name, params, value } に分解 */
function parseLine(line) {
  const colon = findUnquoted(line, ':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/** ダブルクォートの外側にある文字位置を探す */
function findUnquoted(s, ch) {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') q = !q;
    else if (s[i] === ch && !q) return i;
  }
  return -1;
}

/**
 * DTSTART/DTEND/UNTIL 等の日時を「JSTでのエポック分」に直す。
 * 返り値: { min: number, allDay: boolean }
 */
function parseDateTime(value, params) {
  const isDate = params.VALUE === 'DATE' || /^\d{8}$/.test(value);
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh = '0', mm = '0', , z] = m;
  // UTC基準のエポック分を作ってから、必要なら+9時間してJST壁時計に合わせる
  const utcMin = Date.UTC(+y, +mo - 1, +d, +hh, +mm) / 60000;
  return { min: z ? utcMin + TZ_OFFSET_MIN : utcMin, allDay: isDate };
}

/** JSTエポック分 → { y, m, d, hm } */
function toParts(min) {
  const dt = new Date(min * 60000);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    hm: dt.getUTCHours() * 60 + dt.getUTCMinutes(),
  };
}
const dayStart = (min) => Math.floor(min / 1440) * 1440;
const ymd = (min) => { const p = toParts(min); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };

/** VEVENT を切り出す */
function parseEvents(ics) {
  const lines = unfold(ics).split('\n');
  const events = [];
  let cur = null;
  let calName = 'カレンダー';
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdate: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    const p = parseLine(line);
    if (!p) continue;
    if (!cur) { if (p.name === 'X-WR-CALNAME') calName = unescapeText(p.value); continue; }
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.summary = unescapeText(p.value).trim(); break;
      case 'LOCATION': cur.location = unescapeText(p.value).trim(); break;
      case 'STATUS': cur.status = p.value; break;
      case 'DTSTART': cur.start = parseDateTime(p.value, p.params); break;
      case 'DTEND': cur.end = parseDateTime(p.value, p.params); break;
      case 'DURATION': cur.duration = p.value; break;
      case 'RRULE': cur.rrule = p.value; break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDateTime(p.value, p.params); break;
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const dt = parseDateTime(v, p.params);
          if (dt) cur.exdate.push(dt.min);
        }
        break;
      case 'X-MICROSOFT-CDO-ALLDAYEVENT': if (p.value === 'TRUE') cur.forceAllDay = true; break;
      // DESCRIPTION / DTSTAMP / SEQUENCE / X-MICROSOFT-* は意図的に捨てる（容量と個人情報）
    }
  }
  return { calName, events };
}

// ---------- 繰り返し展開 ----------

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** RRULE を windowStart..windowEnd の範囲で展開し、開始時刻（JSTエポック分）の配列を返す */
function expandRrule(startMin, rrule, winStart, winEnd) {
  const r = Object.fromEntries(rrule.split(';').map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i).toUpperCase(), kv.slice(i + 1)];
  }));
  const freq = r.FREQ;
  const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10));
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const untilDt = r.UNTIL ? parseDateTime(r.UNTIL, {}) : null;
  const until = untilDt ? untilDt.min : Infinity;
  const byday = r.BYDAY ? r.BYDAY.split(',').map((s) => WD[s.slice(-2)]).filter((v) => v !== undefined) : null;

  const out = [];
  const hardLimit = Math.min(until, winEnd);
  const MAX = 2000; // 暴走よけ
  let n = 0, emitted = 0;

  if (freq === 'WEEKLY' && byday && byday.length) {
    const base = dayStart(startMin);
    const tod = startMin - base;
    const weekStart = base - ((new Date(base * 60000).getUTCDay() + 7) % 7) * 1440;
    for (let w = 0; n < MAX && emitted < count; w += interval, n++) {
      const ws = weekStart + w * 7 * 1440;
      if (ws > hardLimit + 7 * 1440) break;
      for (const wd of byday.slice().sort((a, b) => a - b)) {
        const t = ws + wd * 1440 + tod;
        if (t < startMin || t > hardLimit) continue;
        if (emitted >= count) break;
        emitted++;
        if (t >= winStart) out.push(t);
      }
    }
    return out;
  }

  const p0 = toParts(startMin);
  for (let i = 0; n < MAX && emitted < count; i += interval, n++) {
    let t;
    if (freq === 'DAILY') t = startMin + i * 1440;
    else if (freq === 'WEEKLY') t = startMin + i * 7 * 1440;
    else if (freq === 'MONTHLY') t = Date.UTC(p0.y, p0.m - 1 + i, p0.d, 0, 0) / 60000 + p0.hm;
    else if (freq === 'YEARLY') t = Date.UTC(p0.y + i, p0.m - 1, p0.d, 0, 0) / 60000 + p0.hm;
    else return [startMin]; // 未対応のFREQは初回のみ
    if (t > hardLimit) break;
    emitted++;
    if (t >= winStart) out.push(t);
  }
  return out;
}

// ---------- 伏せ字 ----------

function maskSummary(summary) {
  let s = summary;
  for (const [re, rep] of C.TRIM_PATTERNS) s = s.replace(re, rep);
  s = s.trim();
  for (const re of C.ALWAYS_MASK) if (re.test(s)) return C.MASKED_LABEL;
  if (C.BOOKING_SUFFIX.test(s)) {
    const body = s.replace(C.BOOKING_SUFFIX, '').trim();
    const keep = C.KEEP_IF_INCLUDES.some((w) => body.includes(w));
    return keep ? body : C.MASKED_LABEL;
  }
  return s || C.MASKED_LABEL;
}

/**
 * 同じ日・同じタイトルで、隙間が MERGE_GAP_MIN 以内（または重なっている）
 * セグメントを1つにまとめる。細切れの連続予約を1ブロックにするため。
 */
function mergeAdjacent(list) {
  if (!C.MERGE_GAP_MIN) return list;
  const out = [];
  for (const x of list) {
    const prev = out.find(
      (p) => p.day === x.day && p.title === x.title && p.loc === x.loc && p.kind === x.kind &&
             p.s >= 0 && x.s >= 0 && x.s - p.e <= C.MERGE_GAP_MIN && x.s >= p.s
    );
    if (prev) { prev.e = Math.max(prev.e, x.e); continue; }
    // 終日どうしの重複も1件に畳む
    if (x.s < 0 && out.some((p) => p.day === x.day && p.title === x.title && p.s < 0)) continue;
    out.push({ ...x });
  }
  return out.sort((a, b) => a.day - b.day || a.s - b.s);
}

// ---------- メイン ----------

async function loadIcs(arg) {
  if (arg) return readFile(arg, 'utf8');
  if (!C.ICS_URL) throw new Error('ICS_URL が未設定です（環境変数 ICS_URL、またはファイルパスを引数に）');
  const res = await fetch(C.ICS_URL, { headers: { 'User-Agent': 'ics-lite-viewer/1' } });
  if (!res.ok) throw new Error(`ICS取得失敗: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const raw = await loadIcs(process.argv[2]);
  const rawBytes = Buffer.byteLength(raw);
  const { calName, events } = parseEvents(raw);

  // 「今日」をJSTで求める
  const nowMin = Math.floor(Date.now() / 60000) + TZ_OFFSET_MIN;
  const today = dayStart(nowMin);
  const winStart = today - C.PAST_DAYS * 1440;
  const winEnd = today + C.FUTURE_DAYS * 1440;

  // RECURRENCE-ID（繰り返しの個別変更）は元インスタンスを打ち消す
  const overrides = new Set(
    events.filter((e) => e.recurrenceId).map((e) => `${e.uid}@${e.recurrenceId.min}`)
  );

  /** @type {Map<string, {day:number,s:number,e:number,title:string,loc:string,span:number}[]>} */
  const byMonth = new Map();
  let instances = 0;

  for (const ev of events) {
    if (!ev.start || ev.status === 'CANCELLED') continue;
    const allDay = ev.start.allDay || ev.forceAllDay === true;
    const durMin = ev.end ? Math.max(0, ev.end.min - ev.start.min) : (allDay ? 1440 : 60);

    const starts = ev.rrule
      ? expandRrule(ev.start.min, ev.rrule, winStart, winEnd)
      : (ev.start.min + durMin >= winStart && ev.start.min <= winEnd ? [ev.start.min] : []);

    const title = maskSummary(ev.summary || '');
    const loc = C.SHOW_LOCATION ? (ev.location || '') : '';
    // 0 = 貸切（ラウンジ利用不可） / 1 = 公開イベント
    const kind = C.OPEN_PATTERNS.some((re) => re.test(ev.summary || '')) ? 1 : 0;

    for (const s of starts) {
      if (ev.exdate.includes(s)) continue;
      if (ev.rrule && overrides.has(`${ev.uid}@${s}`)) continue;
      const e = s + durMin;

      // 日をまたぐ予定は日ごとに分割して置く
      const firstDay = dayStart(s);
      const lastDay = dayStart(allDay ? e - 1 : Math.max(s, e - 1));
      const nDays = Math.round((lastDay - firstDay) / 1440) + 1;
      for (let i = 0; i < nDays; i++) {
        const d = firstDay + i * 1440;
        if (d < winStart || d > winEnd) continue;
        const segS = Math.max(s, d);
        const segE = Math.min(e, d + 1440);
        const p = toParts(d);
        const key = `${p.y}-${String(p.m).padStart(2, '0')}`;
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key).push({
          day: p.d,
          s: allDay ? -1 : segS - d,
          e: allDay ? -1 : segE - d,
          title,
          loc,
          span: nDays > 1 ? (i === 0 ? 1 : i === nDays - 1 ? 3 : 2) : 0, // 0:単日 1:開始 2:中日 3:終了
          kind,
        });
        instances++;
      }
    }
  }

  // ---------- 出力（文字列テーブル＋タプル配列で圧縮） ----------
  await mkdir(C.OUT_DIR, { recursive: true });
  const months = {};
  const files = [];
  const hash = createHash('sha1');

  for (const key of [...byMonth.keys()].sort()) {
    const list = mergeAdjacent(
      byMonth.get(key).sort((a, b) => a.day - b.day || a.s - b.s || a.title.localeCompare(b.title))
    );
    const titles = [];
    const locs = [];
    const idx = (arr, v) => { if (!v) return -1; let i = arr.indexOf(v); if (i < 0) { i = arr.length; arr.push(v); } return i; };
    const rows = list.map((x) => {
      const row = [x.day, x.s, x.e, idx(titles, x.title), idx(locs, x.loc), x.span, x.kind];
      while (row.length > 5 && row[row.length - 1] === 0) row.pop();
      return row;
    });
    const body = {
      t: titles, l: locs, e: rows,
      // 表示ラベルと開放時間もデータに載せる（HTML側を触らず設定変更できるように）
      k: [C.EXCLUSIVE_LABEL, C.OPEN_LABEL],
      h: [C.OPEN_FROM_MIN, C.OPEN_TO_MIN],
    };
    const json = JSON.stringify(body);
    hash.update(key + json);
    months[key] = rows.length;
    files.push([key, json]);
  }

  const version = hash.digest('hex').slice(0, 10);
  const index = {
    name: calName,
    v: version,
    gen: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tz: 'Asia/Tokyo',
    months,
  };

  // 既存の月ファイルのうち、窓から外れたものを掃除
  const existing = (await readdir(C.OUT_DIR).catch(() => [])).filter((f) => /^\d{4}-\d{2}\.json$/.test(f));
  for (const f of existing) {
    if (!months[f.replace('.json', '')]) await rm(`${C.OUT_DIR}/${f}`);
  }

  let outBytes = 0;
  for (const [key, json] of files) {
    const payload = `{"v":"${version}",${json.slice(1)}`;
    outBytes += Buffer.byteLength(payload);
    await writeFile(`${C.OUT_DIR}/${key}.json`, payload);
  }
  const indexJson = JSON.stringify(index);
  outBytes += Buffer.byteLength(indexJson);
  await writeFile(`${C.OUT_DIR}/index.json`, indexJson);

  const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
  console.log(`ICS        : ${kb(rawBytes)} / VEVENT ${events.length}件`);
  console.log(`出力       : ${kb(outBytes)} / ${files.length}ファイル / ${instances}インスタンス`);
  console.log(`初回表示分 : ${kb(Buffer.byteLength(indexJson) + (files.find(([k]) => k === ymd(today).slice(0, 7))?.[1]?.length ?? 0))} (index + 当月)`);
  console.log(`削減率     : ${(100 - (outBytes / rawBytes) * 100).toFixed(1)}%`);
  console.log(`version    : ${version}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
