// «اسأل المادة»: conversations answered from the subject's files only, every paragraph cited.
// /subjects/:id/ask?thread=N opens a conversation.

import { DIALECT_LABEL, type AskDTO, type AskThreadDTO, type ChapterDTO, type Dialect, type SubjectDTO } from '@zakir/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { RefList } from '../components/RefChip.tsx';
import { Badge, Button, ErrorText } from '../components/ui.tsx';

const RETRIEVAL_LABEL = {
  scope: 'من صفحات النطاق المحدد',
  search: 'من أكثر الصفحات صلة بسؤالك',
  'search+expand': 'بحث موسّع بكلمات مقترحة من الذكاء الاصطناعي',
};

/** Text where any leftover page tag ("F12:p7" / "[F12:p7]") becomes a clickable source chip. */
function TextWithRefs({ text, names }: { text: string; names: Map<number, string> }) {
  const parts = text.split(/\[?F(\d+):p(\d+)\]?/);
  return (
    <>
      {parts.map((p, i) =>
        i % 3 === 0 ? <span key={i}>{p}</span> : i % 3 === 1 ? <RefList key={i} refs={[{ fileId: Number(p), page: Number(parts[i + 1]) }]} names={names} /> : null,
      )}
    </>
  );
}

function AskMessage({ a, names, onRetry }: { a: AskDTO; names: Map<number, string>; onRetry: () => void }) {
  const r = a.result;
  return (
    <div className="space-y-3">
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-ss-sm bg-stone-900 px-4 py-2 text-white">
          {a.scope.label && <p className="text-xs text-stone-300">عن: {a.scope.label}</p>}
          <p dir="auto" className="whitespace-pre-wrap">
            {a.question}
          </p>
        </div>
      </div>
      <div className="flex justify-end">
        <div className="w-full max-w-[92%] space-y-2 rounded-2xl rounded-se-sm border border-stone-200 bg-white px-4 py-3">
          {(a.status === 'searching' || a.status === 'answering') && (
            <p className="animate-pulse text-sky-800">{a.status === 'searching' ? 'أبحث في ملفاتك...' : 'أقرأ الصفحات وأكتب الإجابة...'}</p>
          )}
          {a.status === 'failed' && (
            <div className="space-y-2">
              <p className="text-sm text-red-700">{a.error}</p>
              <Button onClick={onRetry}>أعد المحاولة</Button>
            </div>
          )}
          {r && (
            <>
              {r.found === 'no' && <Badge tone="amber">غير موجود في ملفاتك</Badge>}
              {r.found === 'partial' && <Badge tone="amber">إجابة جزئية من ملفاتك</Badge>}
              {r.segments.map((s, i) => (
                <p key={i} className="leading-loose">
                  <span className="whitespace-pre-wrap">
                    <TextWithRefs text={s.text} names={names} />
                  </span>{' '}
                  <RefList refs={s.refs} names={names} />
                </p>
              ))}
              {r.missing && (
                <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
                  <TextWithRefs text={r.missing} names={names} />
                </p>
              )}
              <p className="text-xs text-stone-400">
                {a.retrieval ? RETRIEVAL_LABEL[a.retrieval] : 'لم تُرسل صفحات'} · {a.pages.length} صفحة · {DIALECT_LABEL[a.dialect]}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function AskPage() {
  const subjectId = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const threadId = Number(params.get('thread')) || undefined;
  const [subject, setSubject] = useState<SubjectDTO>();
  const [threads, setThreads] = useState<Omit<AskThreadDTO, 'asks'>[]>([]);
  const [thread, setThread] = useState<AskThreadDTO>();
  const [chapters, setChapters] = useState<ChapterDTO[]>([]);
  const [names, setNames] = useState(new Map<number, string>());
  const [dialect, setDialect] = useState<Dialect>('fusha');
  const [question, setQuestion] = useState('');
  const [chapterId, setChapterId] = useState<number>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([api.subject(subjectId), api.chapters(subjectId), api.files(subjectId), api.settings(), api.askThreads(subjectId)]).then(
      ([s, c, f, st, th]) => {
        setSubject(s);
        setChapters(c.chapters);
        setNames(new Map(f.map((x) => [x.id, x.name])));
        setDialect(st.dialect);
        setThreads(th);
      },
      (e: Error) => setError(e.message),
    );
  }, [subjectId]);

  const loadThread = useCallback(() => {
    if (!threadId) return setThread(undefined);
    api.askThread(threadId).then(setThread, (e: Error) => setError(e.message));
  }, [threadId]);
  useEffect(() => void loadThread(), [loadThread]);

  const busy = thread?.asks.some((a) => a.status === 'searching' || a.status === 'answering');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(loadThread, 2000);
    return () => clearInterval(t);
  }, [busy, loadThread]);
  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect must not return one.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread?.asks.length, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(undefined);
    try {
      const chapter = chapters.find((c) => c.id === chapterId);
      const t = await api.ask(subjectId, question, chapter ? { chapterId: chapter.id } : {}, threadId);
      setThread(t);
      setQuestion('');
      if (!threadId) {
        setParams({ thread: String(t.id) });
        setThreads(await api.askThreads(subjectId));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function changeDialect(d: Dialect) {
    setDialect((await api.saveSettings({ dialect: d })).dialect);
  }

  async function removeThread(id: number) {
    if (!confirm('حذف هذه المحادثة؟')) return;
    await api.deleteAskThread(id);
    setThreads(await api.askThreads(subjectId));
    if (id === threadId) setParams({});
  }

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8 md:grid-cols-[16rem_1fr]">
      <aside className="space-y-3">
        <Link to={`/subjects/${subjectId}`} className="text-sm text-stone-500 hover:underline">
          ‹ {subject?.name}
        </Link>
        <h1 className="text-xl font-bold">اسأل المادة</h1>
        <Button variant="primary" className="w-full" onClick={() => setParams({})}>
          محادثة جديدة
        </Button>
        <div className="flex gap-1 rounded-lg bg-stone-100 p-1 text-sm">
          {(Object.keys(DIALECT_LABEL) as Dialect[]).map((d) => (
            <button key={d} onClick={() => changeDialect(d)} className={`flex-1 rounded-md py-1 ${dialect === d ? 'bg-white shadow-sm' : 'text-stone-600'}`}>
              {DIALECT_LABEL[d]}
            </button>
          ))}
        </div>
        <ul className="space-y-1 text-sm">
          {threads.map((t) => (
            <li key={t.id} className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 ${t.id === threadId ? 'bg-stone-200' : 'hover:bg-stone-100'}`}>
              <button onClick={() => setParams({ thread: String(t.id) })} className="min-w-0 flex-1 truncate text-start">
                <bdi>{t.title}</bdi>
              </button>
              <button onClick={() => removeThread(t.id)} className="text-stone-400 opacity-0 group-hover:opacity-100 hover:text-red-700" aria-label="حذف">
                ✕
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-[70vh] flex-col gap-4">
        <div className="flex-1 space-y-6">
          {!thread && (
            <div className="space-y-2 rounded-xl border border-dashed border-stone-300 p-6 text-center text-stone-600">
              <p className="font-medium">اسأل أي سؤال عن المادة.</p>
              <p className="text-sm">الإجابة من ملفاتك فقط، ومع كل فقرة رقم الصفحة. إذا لم تكن المعلومة في ملفاتك سأقول ذلك بوضوح.</p>
            </div>
          )}
          {thread?.asks.map((a) => (
            <AskMessage key={a.id} a={a} names={names} onRetry={async () => setThread(await api.retryAsk(a.id))} />
          ))}
          <div ref={bottom} />
        </div>

        <form onSubmit={send} className="sticky bottom-4 space-y-2 rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            dir="auto"
            rows={2}
            placeholder={thread ? 'سؤال متابعة...' : 'مثال: وش الفرق بين النقل النشط والسلبي؟'}
            className="w-full resize-none rounded-lg border border-stone-200 p-2 focus:border-stone-500 focus:outline-none"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <select value={chapterId ?? ''} onChange={(e) => setChapterId(Number(e.target.value) || undefined)} className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm">
              <option value="">ابحث في كل المادة</option>
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  داخل: {c.title}
                </option>
              ))}
            </select>
            <Button variant="primary" disabled={sending || busy || question.trim().length < 2}>
              {sending ? 'جارٍ الإرسال...' : 'اسأل'}
            </Button>
          </div>
          <ErrorText>{error}</ErrorText>
        </form>
      </section>
    </main>
  );
}
