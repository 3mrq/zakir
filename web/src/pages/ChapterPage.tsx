import type { ChapterDTO, SummaryDTO } from '@zakir/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, type ContentFile } from '../api.ts';
import { JobLine, useLatestJob } from '../components/jobs.tsx';
import { RefChip, RefList } from '../components/RefChip.tsx';
import { Button, Card, ErrorText, formatDate } from '../components/ui.tsx';

/** Renders point text; lines starting with "- " become sub-bullets. */
function PointText({ text }: { text: string }) {
  const lines = text.split('\n').filter((l) => l.trim());
  const [first, ...rest] = lines;
  return (
    <>
      <span>{first}</span>
      {rest.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 ps-5">
          {rest.map((l, i) => (
            <li key={i}>{l.replace(/^\s*-\s*/, '')}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ChapterPage() {
  const id = Number(useParams().id);
  const [chapter, setChapter] = useState<ChapterDTO>();
  const [summary, setSummary] = useState<SummaryDTO | null>(null);
  const [files, setFiles] = useState<ContentFile[]>([]);
  const [level, setLevel] = useState<'quick' | 'detailed'>('quick');
  const [error, setError] = useState<string>();
  const navigate = useNavigate();

  /** Opens «اسأل المادة» with an explanation limited to this chapter (or one topic's pages). */
  async function explain(range?: { fileId: number; from: number; to: number }, label?: string) {
    setError(undefined);
    try {
      const what = label ? `موضوع «${label}»` : 'هذا الشابتر';
      const t = await api.ask(chapter!.subjectId, `اشرح لي ${what} شرحًا مبسّطًا بالترتيب، مع أهم الأفكار التي يجب أن أفهمها للاختبار.`, { chapterId: id, range, label });
      navigate(`/subjects/${chapter!.subjectId}/ask?thread=${t.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const load = useCallback(
    () =>
      api.chapter(id).then(
        (r) => {
          setChapter(r.chapter);
          setSummary(r.summary);
          setFiles(r.files);
        },
        (e: Error) => setError(e.message),
      ),
    [id],
  );
  useEffect(() => void load(), [load]);
  const sum = useLatestJob('chapter', id, 'summarize', load);

  async function generate() {
    setError(undefined);
    try {
      sum.track(await api.summarize(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function cancel() {
    if (sum.job) await api.cancelJob(sum.job.id).catch(() => {});
  }

  if (!chapter) return <main className="mx-auto max-w-4xl px-4 py-8">{error ? <ErrorText>{error}</ErrorText> : <p className="text-stone-500">جارٍ التحميل...</p>}</main>;

  const names = new Map(files.map((f) => [f.id, f.name]));

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div>
        <Link to={`/subjects/${chapter.subjectId}`} className="text-sm text-stone-500 hover:underline">
          ‹ رجوع للمادة
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">
            <bdi>{chapter.title}</bdi>
          </h1>
          <Button onClick={() => explain()}>اشرح لي هذا الشابتر</Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-stone-600">
          <span>المصادر ({chapter.pageCount} صفحة):</span>
          {chapter.ranges.map((r, i) => (
            <RefChip key={i} r={{ fileId: r.fileId, page: r.from }} fileName={`${names.get(r.fileId) ?? r.fileId} ${r.from}–${r.to}`} />
          ))}
        </div>
        {chapter.topics.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            {chapter.topics.map((t, i) => (
              <span key={i} className="inline-flex items-center overflow-hidden rounded-full border border-stone-300">
                <Link to={`/files/${t.fileId}?page=${t.from}`} className="px-2.5 py-0.5 hover:bg-stone-100">
                  <bdi>{t.title}</bdi>
                </Link>
                <button onClick={() => explain({ fileId: t.fileId, from: t.from, to: t.to }, t.title)} className="border-s border-stone-300 bg-stone-50 px-2 py-0.5 text-xs hover:bg-amber-100">
                  اشرح
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <Card
        title="الملخص"
        actions={
          <Button variant={summary ? 'secondary' : 'primary'} onClick={generate} disabled={sum.active}>
            {sum.active ? 'جارٍ التلخيص...' : summary ? 'إعادة التوليد' : 'توليد الملخص'}
          </Button>
        }
      >
        <ErrorText>{error}</ErrorText>
        {(sum.active || sum.job?.status === 'failed') && <JobLine job={sum.job} onCancel={cancel} />}
        {summary?.stale && (
          <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">تغيّرت صفحات الشابتر بعد إنشاء هذا الملخص. أعد التوليد ليتطابق مع المحتوى الحالي.</p>
        )}
        {!summary && !sum.active && <p className="text-sm text-stone-500">لا يوجد ملخص بعد. يُولَّد المستويان (سريع ومفصّل) معًا في استدعاء واحد.</p>}

        {summary && (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-1 rounded-lg bg-stone-100 p-1 text-sm">
                {(['quick', 'detailed'] as const).map((l) => (
                  <button key={l} onClick={() => setLevel(l)} className={`rounded-md px-3 py-1 ${level === l ? 'bg-white shadow-sm' : 'text-stone-600'}`}>
                    {l === 'quick' ? 'سريع' : 'مفصّل'}
                  </button>
                ))}
              </div>
              <span className="text-xs text-stone-400">أُنشئ {formatDate(summary.createdAt)}</span>
            </div>

            {level === 'quick' ? (
              <ul className="space-y-3">
                {summary.quick.map((p, i) => (
                  <li key={i} className="flex gap-2 leading-relaxed">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-stone-400" />
                    <div className="space-y-1">
                      <PointText text={p.text} /> <RefList refs={p.refs} names={names} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="space-y-5">
                {summary.detailed.map((s, i) => (
                  <section key={i} className="space-y-2">
                    <h3 className="font-semibold">
                      <bdi>{s.heading}</bdi>
                    </h3>
                    <ul className="space-y-2.5">
                      {s.points.map((p, j) => (
                        <li key={j} className="flex gap-2 leading-relaxed">
                          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-stone-400" />
                          <div className="space-y-1">
                            <PointText text={p.text} /> <RefList refs={p.refs} names={names} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            <p className="border-t border-stone-100 pt-2 text-xs text-stone-500">
              كل نقطة مأخوذة من صفحات هذا الشابتر فقط. اضغط على المرجع لفتح الصفحة الأصلية والتأكد.
            </p>
          </>
        )}
      </Card>
    </main>
  );
}
