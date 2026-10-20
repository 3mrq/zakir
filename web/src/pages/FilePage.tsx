// In-app viewer: the original page beside the text the app extracted from it.
// Opened from source references as /files/:id?page=N.

import type { FileDTO, PageDTO } from '@zakir/shared';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { PdfPage, usePdf } from '../components/PdfPage.tsx';
import { Badge, Button, ErrorText } from '../components/ui.tsx';

function SourceBadge({ page }: { page: PageDTO }) {
  if (page.status === 'pending_ocr') return <Badge tone="blue">بانتظار القراءة بالذكاء الاصطناعي</Badge>;
  if (page.status === 'ocr_failed') return <Badge tone="red">فشلت القراءة</Badge>;
  if (page.source === 'ai') return <Badge tone="amber">قُرئت بالذكاء الاصطناعي — راجعها مع الأصل</Badge>;
  return <Badge tone="green">نص مستخرج مباشرة</Badge>;
}

export function FilePage() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const [file, setFile] = useState<FileDTO>();
  const [pages, setPages] = useState<PageDTO[]>([]);
  const [error, setError] = useState<string>();
  const isPdf = file?.mime === 'application/pdf';
  const { doc, error: pdfError } = usePdf(isPdf ? api.rawUrl(id) : undefined);

  const count = file?.pageCount ?? 1;
  const pageNo = Math.min(Math.max(1, Number(params.get('page')) || 1), count);
  const go = (n: number) => setParams({ page: String(Math.min(Math.max(1, n), count)) }, { replace: true });

  useEffect(() => {
    Promise.all([api.file(id), api.pages(id)]).then(
      ([f, p]) => {
        setFile(f);
        setPages(p);
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);

  // Keep page texts fresh while AI reading is in progress.
  const busy = pages.some((p) => p.status === 'pending_ocr');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => api.pages(id).then(setPages, () => {}), 3000);
    return () => clearInterval(t);
  }, [busy, id]);

  if (error) return <main className="mx-auto max-w-6xl px-4 py-8"><ErrorText>{error}</ErrorText></main>;
  if (!file) return <main className="mx-auto max-w-6xl px-4 py-8 text-stone-500">جارٍ التحميل...</main>;

  const page = pages.find((p) => p.pageNo === pageNo);

  return (
    <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to={`/subjects/${file.subjectId}`} className="text-sm text-stone-500 hover:underline">
            ‹ رجوع للمادة
          </Link>
          <h1 className="text-xl font-bold">
            <bdi>{file.name}</bdi>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => go(pageNo - 1)} disabled={pageNo <= 1}>
            السابقة
          </Button>
          <span className="text-sm">
            صفحة{' '}
            <input
              type="number"
              min={1}
              max={count}
              value={pageNo}
              onChange={(e) => go(Number(e.target.value))}
              className="w-16 rounded border border-stone-300 px-1 text-center"
            />{' '}
            من {count}
          </span>
          <Button onClick={() => go(pageNo + 1)} disabled={pageNo >= count}>
            التالية
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          {isPdf ? (
            pdfError ? <ErrorText>{pdfError}</ErrorText> : doc ? <PdfPage doc={doc} pageNo={pageNo} /> : <p className="text-stone-500">جارٍ فتح الملف...</p>
          ) : (
            <img src={api.rawUrl(id)} alt={file.name} className="w-full rounded-lg border border-stone-200" />
          )}
        </div>
        <section className="space-y-3 rounded-xl border border-stone-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">النص المستخرج — صفحة {pageNo}</h2>
            {page && <SourceBadge page={page} />}
          </div>
          {page?.aiNote && <p className="text-sm text-amber-800">{page.aiNote}</p>}
          {page?.text ? (
            // One element per line so each takes its own direction (an English line stays LTR).
            <div className="leading-loose">
              {page.text.split('\n').map((line, i) =>
                line.trim() ? (
                  <p key={i} dir="auto" className="whitespace-pre-wrap">
                    {line}
                  </p>
                ) : (
                  <div key={i} className="h-3" />
                ),
              )}
            </div>
          ) : (
            <p className="text-stone-500">{file.status === 'processing' ? 'جارٍ الاستخراج...' : 'لا يوجد نص لهذه الصفحة.'}</p>
          )}
        </section>
      </div>
    </main>
  );
}
