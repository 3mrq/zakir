import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.ts';
import { normalizeArabic, stripPrefix, toSearchText } from './normalize.ts';

describe('normalizeArabic', () => {
  it('removes tashkeel and tatweel and unifies letters', () => {
    expect(normalizeArabic('الخَلِيَّةُ')).toBe('الخليه');
    expect(normalizeArabic('أإآ ـــ مستشفى مسؤول')).toBe('ااا  مستشفي مسوول');
    expect(normalizeArabic('٣ ATP')).toBe('3 atp');
  });

  it('turns presentation forms into base letters', () => {
    expect(normalizeArabic('ﺍﻟﺨﻠﻴﺔ')).toBe('الخليه');
  });
});

describe('stripPrefix', () => {
  it.each([
    ['الخليه', 'خليه'],
    ['بالخليه', 'خليه'],
    ['والخليه', 'خليه'],
    ['للخليه', 'خليه'],
    ['وخليه', 'خليه'],
    ['ولد', 'ولد'], // too short to strip و
    ['خليه', 'خليه'],
  ])('%s → %s', (w, stem) => expect(stripPrefix(w)).toBe(stem));
});

describe('FTS with normalized text', () => {
  it('finds Arabic words regardless of prefix, hamza, ta marbuta, diacritics', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO subjects (name) VALUES ('أحياء')`).run();
    db.prepare(`INSERT INTO files (subject_id, kind, name, stored_path, mime, size, sha256, status) VALUES (1,'content','a.pdf','a','application/pdf',1,'x','ready')`).run();
    const ins = db.prepare(`INSERT INTO pages (file_id, page_no, text, text_norm, source, status) VALUES (1, ?, ?, ?, 'direct', 'ok')`);
    ins.run(1, 'يحيط بالخلية غشاء بلازمي', toSearchText('يحيط بالخلية غشاء بلازمي'));
    ins.run(2, 'الإنزيمات (Enzymes) تسرّع التفاعلات', toSearchText('الإنزيمات (Enzymes) تسرّع التفاعلات'));

    const search = (q: string) =>
      (db.prepare(`SELECT p.page_no FROM pages_fts f JOIN pages p ON p.id = f.rowid WHERE pages_fts MATCH ?`).all(q) as { page_no: number }[]).map((r) => r.page_no);

    expect(search(stripPrefix(normalizeArabic('خلية')))).toEqual([1]);
    expect(search(stripPrefix(normalizeArabic('الخلية')))).toEqual([1]);
    expect(search(stripPrefix(normalizeArabic('إنزيمات')))).toEqual([2]);
    expect(search('enzymes')).toEqual([2]);

    // Updates keep the index in sync.
    db.prepare(`UPDATE pages SET text_norm = ? WHERE page_no = 1`).run(toSearchText('ميتوكوندريا'));
    expect(search('خليه')).toEqual([]);
    expect(search('ميتوكوندريا')).toEqual([1]);
    db.close();
  });
});
