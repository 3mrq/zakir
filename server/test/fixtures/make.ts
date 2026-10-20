// Regenerates the test PDFs from the HTML sources with headless Edge/Chrome.
// Run: npx tsx test/fixtures/make.ts   (from server/)
//   text.pdf  — 3 pages of real Arabic/English text (like a PDF exported from Word)
//   scan.png  — a "photographed note" image
//   mixed.pdf — page 1 = real text, page 2 = the image only (a scanned page)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const dir = dirname(fileURLToPath(import.meta.url));
const browser = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!browser) throw new Error('Edge or Chrome is required to build fixtures');

const headless = (args: string[]) => execFileSync(browser, ['--headless', '--disable-gpu', '--no-pdf-header-footer', ...args], { stdio: 'ignore' });

headless([`--print-to-pdf=${join(dir, 'text.pdf')}`, pathToFileURL(join(dir, 'src', 'text.html')).href]);
// course.pdf — 8 pages: cover, Chapter 1 (3 pages), Chapter 2 (3 pages), references. For segmentation/summary runs.
headless([`--print-to-pdf=${join(dir, 'course.pdf')}`, pathToFileURL(join(dir, 'src', 'course.html')).href]);
// Two past exams in English (a typical doctor's style) covering course.pdf — for style analysis runs.
for (const exam of ['exam2023', 'exam2024']) {
  headless([`--print-to-pdf=${join(dir, `${exam}.pdf`)}`, pathToFileURL(join(dir, 'src', `${exam}.html`)).href]);
}
headless(['--window-size=800,1000', `--screenshot=${join(dir, 'scan.png')}`, pathToFileURL(join(dir, 'src', 'scan.html')).href]);

const textPdf = await PDFDocument.load(readFileSync(join(dir, 'text.pdf')));
const mixed = await PDFDocument.create();
const [first] = await mixed.copyPages(textPdf, [0]);
mixed.addPage(first!);
const png = await mixed.embedPng(readFileSync(join(dir, 'scan.png')));
const page = mixed.addPage([595, 744]);
page.drawImage(png, { x: 0, y: 0, width: 595, height: 744 });
writeFileSync(join(dir, 'mixed.pdf'), await mixed.save());
console.log('fixtures written');
