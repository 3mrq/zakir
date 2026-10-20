// Page-by-page text extraction from PDFs with pdfjs, with Arabic line reconstruction.
//
// pdfjs returns Arabic as positioned glyph items in *visual* order and in presentation forms
// (e.g. "ﺔﻴﻠﺨﻟا" for "الخلية"). We rebuild each line from item positions and directions,
// then NFKC-normalize to base letters.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface TextItem {
  str: string;
  dir: string; // 'rtl' | 'ltr' | 'ttb'
  x: number;
  y: number;
  width: number;
  height: number;
  hasEOL?: boolean;
}

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-z0-9À-ɏ]/;

type Dir = 'rtl' | 'ltr' | 'neutral';

function itemDir(s: string): Dir {
  if (RTL_CHAR.test(s)) return 'rtl';
  if (LTR_CHAR.test(s)) return 'ltr';
  return 'neutral';
}

/** Groups items into lines (top to bottom) by baseline y. */
export function groupLines(items: TextItem[]): TextItem[][] {
  const sorted = items.filter((i) => i.str.length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextItem[][] = [];
  for (const it of sorted) {
    const tol = Math.max(2, (it.height || 10) * 0.4);
    const line = lines.find((l) => Math.abs(l[0]!.y - it.y) <= tol);
    if (line) line.push(it);
    else lines.push([it]);
  }
  return lines.sort((a, b) => b[0]!.y - a[0]!.y);
}

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
const mirror = (s: string) => s.replace(/[()[\]{}<>«»]/g, (c) => MIRROR[c]!);

/**
 * Turns one visual line into logical text.
 * RTL base line: segments read right→left, but runs of LTR text (English terms, numbers)
 * keep their own left→right order. Neutral items (spaces, punctuation) between two LTR
 * items join that LTR run. Neutral brackets outside LTR runs are mirrored, and sentence
 * punctuation stuck to the visual left of an LTR run (".ATP") belongs after it ("ATP.").
 * `baseRtl` marks lines of an RTL page that happen to contain only LTR text.
 */
export function lineToText(line: TextItem[], baseRtl = false): string {
  const visual = [...line].sort((a, b) => a.x - b.x);
  // Insert a space where there is a visible gap with no space item.
  const withGaps: string[] = [];
  const dirs: Dir[] = [];
  visual.forEach((it, i) => {
    const prev = visual[i - 1];
    if (prev) {
      const gap = it.x - (prev.x + prev.width);
      const size = it.height || prev.height || 10;
      if (gap > size * 0.25 && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) {
        withGaps.push(' ');
        dirs.push('neutral');
      }
    }
    withGaps.push(it.str);
    dirs.push(itemDir(it.str));
  });

  if (!dirs.includes('rtl') && !baseRtl) return withGaps.join('');

  // Build segments in visual order: maximal LTR runs (LTR items + neutrals between them) or single items.
  const segments: string[] = [];
  let i = 0;
  while (i < withGaps.length) {
    if (dirs[i] === 'ltr') {
      let end = i;
      for (let j = i + 1; j < withGaps.length; j++) {
        if (dirs[j] === 'rtl') break;
        if (dirs[j] === 'ltr') end = j;
      }
      const run = withGaps.slice(i, end + 1).join('');
      const m = run.match(/^([.,:;!?،؛]+)(.*)$/s);
      segments.push(m ? m[2]! + m[1]! : run);
      i = end + 1;
    } else {
      segments.push(dirs[i] === 'neutral' ? mirror(withGaps[i]!) : withGaps[i]!);
      i++;
    }
  }
  return segments.reverse().join('');
}

/** Normalizes extracted text: presentation forms → base letters, tidy whitespace. */
export function cleanText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[​-‏‪-‮⁦-⁩]/g, '') // zero-width + bidi controls
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MARK_ONLY = /^\p{M}+$/u;

/**
 * Diacritics (shadda, tanween, damma...) come as separate zero-width items placed inside their
 * letter's box, slightly higher. Left alone they end up detached ("يع ّدل") or on a line of their
 * own. Attach each one to the letter whose box contains it; drop it if none does.
 */
function attachMarks(lines: TextItem[][], marks: TextItem[]) {
  for (const m of marks) {
    const line = lines
      .filter((l) => Math.abs(l[0]!.y - m.y) <= Math.max(4, (m.height || 10) * 0.9))
      .sort((a, b) => Math.abs(a[0]!.y - m.y) - Math.abs(b[0]!.y - m.y))[0];
    if (!line) continue;
    const base = line
      .filter((it) => !/^\s*$/.test(it.str) && m.x >= it.x - 0.8 && m.x <= it.x + it.width + 0.8)
      .sort((a, b) => a.width - b.width)[0];
    if (!base) continue;
    const chars = [...base.str];
    if (chars.length <= 1) {
      base.str += m.str;
      continue;
    }
    // Multi-char item: pick the character under the mark (RTL items read from the right edge).
    const frac = base.width > 0 ? (RTL_CHAR.test(base.str) ? base.x + base.width - m.x : m.x - base.x) / base.width : 1;
    const idx = Math.min(chars.length - 1, Math.max(0, Math.floor(frac * chars.length)));
    chars.splice(idx + 1, 0, m.str);
    base.str = chars.join('');
  }
}

export function itemsToText(items: TextItem[]): string {
  const copies = items.map((i) => ({ ...i }));
  const lines = groupLines(copies.filter((i) => !MARK_ONLY.test(i.str)));
  attachMarks(lines, copies.filter((i) => MARK_ONLY.test(i.str)));
  const rtlLines = lines.filter((l) => l.some((i) => RTL_CHAR.test(i.str))).length;
  const baseRtl = rtlLines > lines.length / 2;
  return cleanText(lines.map((l) => lineToText(l, baseRtl)).join('\n'));
}

export type PageQuality = 'ok' | 'empty' | 'garbled';

/**
 * Decides whether extracted text is usable. Empty or near-empty pages (scans) and pages whose
 * text is mostly private-use/replacement glyphs (broken font encodings) go to AI reading.
 */
export function assessText(text: string): PageQuality {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 15) return 'empty';
  const junk = text.match(/[-�]/g)?.length ?? 0;
  if (junk / (letters + junk) > 0.1) return 'garbled';
  return 'ok';
}

export interface ExtractedPage {
  page: number;
  text: string;
  quality: PageQuality;
}

// pdfjs in Node: legacy build, no worker, no eval.
const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | undefined;
const loadPdfjs = () =>
  (pdfjsPromise ??= import(pathToFileURL(join(pdfjsRoot, 'legacy', 'build', 'pdf.mjs')).href) as Promise<PdfJs>);

async function openPdf(data: Uint8Array) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data,
    useSystemFonts: false,
    cMapUrl: pathToFileURL(join(pdfjsRoot, 'cmaps')).href + '/',
    cMapPacked: true,
    standardFontDataUrl: pathToFileURL(join(pdfjsRoot, 'standard_fonts')).href + '/',
  });
}

/**
 * Renders the given pages to PNG files (page-<n>.png) for AI reading, long side ≈ maxSide px.
 * Done locally so the AI never needs external PDF tools (Claude's Read needs poppler for PDFs).
 */
export async function renderPdfPages(data: Uint8Array, pages: number[], outDir: string, maxSide = 1800): Promise<string[]> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { writeFileSync } = await import('node:fs');
  const task = await openPdf(data);
  const doc = await task.promise;
  try {
    const out: string[] = [];
    for (const n of pages) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: maxSide / Math.max(base.width, base.height) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
      const name = `page-${n}.png`;
      writeFileSync(join(outDir, name), canvas.toBuffer('image/png'));
      out.push(name);
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}

export async function extractPdfPages(data: Uint8Array): Promise<ExtractedPage[]> {
  const task = await openPdf(data);
  const doc = await task.promise;
  try {
    const pages: ExtractedPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const items: TextItem[] = [];
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        items.push({ str: it.str, dir: it.dir, x: it.transform[4], y: it.transform[5], width: it.width, height: it.height, hasEOL: it.hasEOL });
      }
      const text = itemsToText(items);
      pages.push({ page: n, text, quality: assessText(text) });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
