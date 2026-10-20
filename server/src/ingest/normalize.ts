// Arabic normalization for search (FTS5). Display text is never normalized this way.
//
// - removes diacritics (tashkeel) and tatweel
// - unifies letter variants: أ إ آ ٱ → ا, ى → ي, ة → ه, ؤ → و, ئ → ي
// - Arabic-Indic digits → 0-9, Latin → lower case
// - for each Arabic word, also indexes a stem without the common prefixes
//   (و ف ب ك ل + ال), so "بالخلية" matches "خلية" and "الخلية".

const DIACRITICS = /[ً-ٰٟۖ-ۭـ]/g;
const PREFIX = /^(?:[وف]?(?:[بكل]?ال|لل)|[وفبكل])(?=[ء-ي]{2,})/;

export function normalizeArabic(s: string): string {
  return s
    .normalize('NFKC')
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase();
}

/** Strips one common prefix cluster from a normalized Arabic word; returns the word unchanged if none. */
export function stripPrefix(word: string): string {
  // Only strip "و/ف/ب/ك/ل" alone when the rest is long enough to be a real word.
  const m = word.match(PREFIX);
  if (!m) return word;
  const rest = word.slice(m[0].length);
  if (m[0].length === 1 && rest.length < 3) return word;
  return rest;
}

/** Text for the FTS column: normalized words, plus prefix-stripped variants of Arabic words. */
export function toSearchText(text: string): string {
  const words = normalizeArabic(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    if (/[ء-ي]/.test(w)) {
      const stem = stripPrefix(w);
      if (stem !== w) out.push(stem);
    }
  }
  return out.join(' ');
}
