#!/usr/bin/env node
// QRコードのSVGを生成する。URLを変えたら再実行してコミットするだけ。
//   node scripts/make-qr.mjs
import { writeFile } from 'node:fs/promises';
import { qrSvg, qrMatrix } from './qr.mjs';

export const TARGETS = [
  { file: 'docs/qr-form.svg',   url: 'https://forms.cloud.microsoft/r/MNew8AxtDQ',            label: '予約フォーム' },
  { file: 'docs/qr-mobile.svg', url: 'https://chiemi627.github.io/onoff-lounge-calendar/',    label: 'スマホで予定を見る' },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const t of TARGETS) {
    const svg = qrSvg(t.url, { ecl: 'Q' });
    await writeFile(t.file, svg);
    const n = qrMatrix(t.url, { ecl: 'Q' }).length;
    console.log(`${t.file}  ${n}x${n} (v${(n - 17) / 4}, ECC=Q)  ${svg.length}B  ${t.url}`);
  }
}
