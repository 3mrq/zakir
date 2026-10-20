// npm run extract -- <file.pdf> [...]
// Prints the locally extracted text of each page and whether it would be sent for AI reading.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractPdfPages } from '../ingest/pdfText.ts';

const files = process.argv.slice(2);
if (!files.length) {
  console.log('الاستخدام: npm run extract -- <ملف.pdf>');
  process.exit(1);
}
for (const f of files) {
  console.log(`===== ${f}`);
  for (const p of await extractPdfPages(new Uint8Array(readFileSync(resolve(process.env.INIT_CWD ?? '.', f))))) {
    console.log(`--- صفحة ${p.page} [${p.quality}]\n${p.text}`);
  }
}
