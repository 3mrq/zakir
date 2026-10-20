// A source reference: opens the original page in the in-app viewer.

import type { PageRef } from '@zakir/shared';
import { Link } from 'react-router';

export function RefChip({ r, fileName }: { r: PageRef; fileName?: string }) {
  return (
    <Link
      to={`/files/${r.fileId}?page=${r.page}`}
      className="inline-flex items-center gap-1 rounded-md bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 hover:bg-amber-100 hover:text-stone-900"
      title="افتح الصفحة الأصلية"
    >
      <bdi className="max-w-40 truncate">{fileName ?? `ملف ${r.fileId}`}</bdi>
      <span>ص {r.page}</span>
    </Link>
  );
}

export function RefList({ refs, names }: { refs: PageRef[]; names: Map<number, string> }) {
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {refs.map((r) => (
        <RefChip key={`${r.fileId}-${r.page}`} r={r} fileName={names.get(r.fileId)} />
      ))}
    </span>
  );
}
