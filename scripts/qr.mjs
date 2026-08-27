// ============================================================
// 最小QRコードエンコーダ（バイトモード / バージョン1-9）
//   依存パッケージなしでSVGを生成する。URLが変わったら
//   `node scripts/make-qr.mjs` を実行し直すだけ。
//   使い方: import { qrSvg } from './qr.mjs'
// ============================================================

// ---- GF(256) 演算表（原始多項式 0x11d） ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * 誤り訂正符号語を作るための生成多項式。
 * 内部では昇順（添字=次数）で (x - α^i) を掛け合わせ、
 * 最後に降順へ直して先頭の係数1（x^degree）を落として返す。
 */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse().slice(1);
}

/** データ符号語に対する誤り訂正符号語を計算 */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gmul(gen[i], factor);
  }
  return res;
}

// ---- バージョン別のブロック構成 ----
// [総符号語数, [L, M, Q, H]] 各要素は [ECC長, [ブロック数, データ長], ...]
const VERSIONS = {
  1: [26,  { L: [7,  [[1, 19]]],            M: [10, [[1, 16]]],            Q: [13, [[1, 13]]],            H: [17, [[1, 9]]] }],
  2: [44,  { L: [10, [[1, 34]]],            M: [16, [[1, 28]]],            Q: [22, [[1, 22]]],            H: [28, [[1, 16]]] }],
  3: [70,  { L: [15, [[1, 55]]],            M: [26, [[1, 44]]],            Q: [18, [[2, 17]]],            H: [22, [[2, 13]]] }],
  4: [100, { L: [20, [[1, 80]]],            M: [18, [[2, 32]]],            Q: [26, [[2, 24]]],            H: [16, [[4, 9]]] }],
  5: [134, { L: [26, [[1, 108]]],           M: [24, [[2, 43]]],            Q: [18, [[2, 15], [2, 16]]],   H: [22, [[2, 11], [2, 12]]] }],
  6: [172, { L: [18, [[2, 68]]],            M: [16, [[4, 27]]],            Q: [24, [[4, 19]]],            H: [28, [[4, 15]]] }],
  7: [196, { L: [20, [[2, 78]]],            M: [18, [[4, 31]]],            Q: [18, [[2, 14], [4, 15]]],   H: [26, [[4, 13], [1, 14]]] }],
  8: [242, { L: [24, [[2, 97]]],            M: [22, [[2, 38], [2, 39]]],   Q: [22, [[4, 18], [2, 19]]],   H: [26, [[4, 14], [2, 15]]] }],
  9: [292, { L: [30, [[2, 116]]],           M: [22, [[3, 36], [2, 37]]],   Q: [20, [[4, 16], [4, 17]]],   H: [24, [[4, 12], [4, 13]]] }],
};

// 位置合わせパターンの中心座標
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
};

const ECC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const dataCapacity = (ver, ecl) => {
  const [, levels] = VERSIONS[ver];
  const [ecLen, groups] = levels[ecl];
  return groups.reduce((n, [blocks, len]) => n + blocks * len, 0);
};

// ---- ビット列の組み立て ----
function encodeData(bytes, ver, ecl) {
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

  push(0b0100, 4);        // バイトモード
  push(bytes.length, 8);  // 文字数（バージョン1-9は8ビット）
  for (const b of bytes) push(b, 8);

  const cap = dataCapacity(ver, ecl) * 8;
  if (bits.length > cap) throw new Error('データが大きすぎます');
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0); // 終端
  while (bits.length % 8) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < cap / 8; i++) codewords.push(PAD[i % 2]);
  return codewords;
}

/** ブロックに分けて誤り訂正を付け、インターリーブする */
function interleave(codewords, ver, ecl) {
  const [ecLen, groups] = VERSIONS[ver][1][ecl];
  const dataBlocks = [];
  const ecBlocks = [];
  let pos = 0;
  for (const [blocks, len] of groups) {
    for (let i = 0; i < blocks; i++) {
      const block = codewords.slice(pos, pos + len);
      pos += len;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLen));
    }
  }
  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

// ---- マトリクス構築 ----
function buildMatrix(ver) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null)); // null = データ領域
  const set = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v; };

  // 位置検出パターン + 分離パターン
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const on = inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(br + r, bc + c, on ? 1 : 0);
      }
    }
  }
  // タイミングパターン
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  // 位置合わせパターン
  const centers = ALIGN[ver];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m[r + dr][c + dc] = on ? 1 : 0;
        }
      }
    }
  }
  m[size - 8][8] = 1; // 常に暗いモジュール
  // バージョン情報の予約領域（バージョン7以上）
  if (ver >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      if (m[b][a] === null) m[b][a] = 0;
      if (m[a][b] === null) m[a][b] = 0;
    }
  }
  // 形式情報の予約領域
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
  }
  return m;
}

/** 予約領域を避けながらジグザグにデータを埋める */
function placeData(m, bytes) {
  const size = m.length;
  const reserved = m.map((row) => row.map((v) => v !== null));
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

  let idx = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 垂直タイミングパターンの列は飛ばす
    for (let n = 0; n < size; n++) {
      const row = up ? size - 1 - n : n;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        m[row][c] = idx < bits.length ? bits[idx] : 0;
        idx++;
      }
    }
    up = !up;
  }
  return reserved;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 形式情報15ビット（BCH(15,5) + マスク 0x5412） */
function formatBits(ecl, mask) {
  const data = (ECC_BITS[ecl] << 3) | mask;
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) if ((rem >> (i + 10)) & 1) rem ^= 0x537 << i;
  return ((data << 10) | rem) ^ 0x5412;
}

function applyFormat(m, ecl, mask) {
  const size = m.length;
  const bits = formatBits(ecl, mask);
  const bit = (i) => (bits >> i) & 1;
  // 1つめ（左上まわり）: 列8の縦帯 → 行8の横帯
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6);
  m[8][8] = bit(7);
  m[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) m[8][14 - i] = bit(i);
  // 2つめ（右上・左下）
  for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = bit(i);
  m[size - 8][8] = 1; // 常に暗いモジュール
}

/** バージョン情報18ビット（バージョン7以上で必要） */
function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

function applyVersion(m, ver) {
  if (ver < 7) return;
  const size = m.length;
  const bits = versionBits(ver);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m[b][a] = bit; // 右上
    m[a][b] = bit; // 左下
  }
}

/** 読み取りやすさの減点（規格の4ルール）。小さいほど良い */
function penalty(m) {
  const size = m.length;
  let score = 0;
  // ルール1: 同色5連続以上
  for (const line of [...m, ...m.map((_, c) => m.map((row) => row[c]))]) {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
      else run = 1;
    }
  }
  // ルール2: 2x2の同色ブロック
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  // ルール3: 位置検出パターンに似た並び
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const lines = [...m, ...m.map((_, c) => m.map((row) => row[c]))];
  for (const line of lines) {
    for (let i = 0; i + 11 <= size; i++) {
      const seg = line.slice(i, i + 11);
      if (P1.every((v, j) => v === seg[j]) || P2.every((v, j) => v === seg[j])) score += 40;
    }
  }
  // ルール4: 暗色モジュールの偏り
  const dark = m.flat().filter((v) => v === 1).length;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** 文字列 → モジュール配列（true=黒） */
export function qrMatrix(text, { ecl = 'Q' } = {}) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 0;
  for (let v = 1; v <= 9; v++) {
    // モード4bit + 文字数8bit + データ ≦ 容量
    if (2 + bytes.length <= dataCapacity(v, ecl)) { ver = v; break; }
  }
  if (!ver) throw new Error(`${bytes.length}バイトはバージョン9(${ecl})に収まりません`);

  const codewords = interleave(encodeData(bytes, ver, ecl), ver, ecl);
  const base = buildMatrix(ver);
  const reserved = placeData(base, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((row) => row.slice());
    for (let r = 0; r < m.length; r++) {
      for (let c = 0; c < m.length; c++) {
        if (!reserved[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
      }
    }
    applyFormat(m, ecl, mask);
    applyVersion(m, ver);
    const score = penalty(m);
    if (!best || score < best.score) best = { score, m };
  }
  return best.m.map((row) => row.map((v) => v === 1));
}

/** 文字列 → SVG（1モジュール=1単位のviewBox。CSSで拡大する前提） */
export function qrSvg(text, { ecl = 'Q', quiet = 4 } = {}) {
  const m = qrMatrix(text, { ecl });
  const size = m.length + quiet * 2;
  // 隣接する黒モジュールを横につないでパスを短くする
  const parts = [];
  for (let r = 0; r < m.length; r++) {
    let c = 0;
    while (c < m.length) {
      if (!m[r][c]) { c++; continue; }
      let w = 1;
      while (c + w < m.length && m[r][c + w]) w++;
      parts.push(`M${c + quiet} ${r + quiet}h${w}v1h-${w}z`);
      c += w;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QRコード">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path fill="#000" d="${parts.join('')}"/></svg>`;
}
