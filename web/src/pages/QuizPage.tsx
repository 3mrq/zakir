// Quiz runner: one question at a time, instant correction, optional countdown, results at the end.

import type { QuizDTO, QuizItemDTO } from '@zakir/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api.ts';
import { letter, QuestionMeta, QuestionReview, questionDir, ReportButton, Stem } from '../components/question.tsx';
import { CardNote } from '../components/CardNote.tsx';
import { Badge, Button, ErrorText } from '../components/ui.tsx';

function useCountdown(quiz?: QuizDTO) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!quiz?.timeLimitSec || quiz.finishedAt) return setLeft(null);
    const end = new Date(quiz.startedAt).getTime() + quiz.timeLimitSec * 1000;
    const tick = () => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [quiz?.timeLimitSec, quiz?.startedAt, quiz?.finishedAt]);
  return left;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function itemResult(item: QuizItemDTO): { tone: 'green' | 'amber' | 'red' | 'gray' | 'blue'; label: string } {
  const a = item.attempt;
  if (!a) return { tone: 'gray', label: 'بلا إجابة' };
  if (a.status === 'grading') return { tone: 'blue', label: 'جارٍ التصحيح' };
  if (a.status === 'failed') return { tone: 'red', label: 'فشل التصحيح' };
  if (a.score === 1) return { tone: 'green', label: 'صحيحة' };
  if (a.score === 0) return { tone: 'red', label: 'خاطئة' };
  return { tone: 'amber', label: `${Math.round((a.score ?? 0) * 100)}%` };
}

function AnswerForm({ item, onSubmit }: { item: QuizItemDTO; onSubmit: (a: { choice?: number; bool?: boolean; text?: string }) => Promise<void> }) {
  const q = item.question;
  const [choice, setChoice] = useState<number>();
  const [bool, setBool] = useState<boolean>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const dir = questionDir(q.stem);
  const ready = q.type === 'mcq' ? choice !== undefined : q.type === 'true_false' ? bool !== undefined : text.trim().length > 0;

  async function submit() {
    setBusy(true);
    try {
      await onSubmit(q.type === 'mcq' ? { choice } : q.type === 'true_false' ? { bool } : { text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {q.type === 'mcq' && (
        <div dir={dir} className="space-y-2">
          {q.options?.map((o, i) => (
          <label key={i} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${choice === i ? 'border-stone-900 bg-stone-50' : 'border-stone-200 hover:bg-stone-50'}`}>
            <input type="radio" name={`q${q.id}`} checked={choice === i} onChange={() => setChoice(i)} className="mt-1" />
            <span className="font-medium text-stone-500">{letter(i, dir)})</span>
            <span>{o}</span>
          </label>
          ))}
        </div>
      )}
      {q.type === 'true_false' && (
        <div className="flex gap-2">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              onClick={() => setBool(v)}
              className={`flex-1 rounded-lg border p-3 font-medium ${bool === v ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-300 hover:bg-stone-50'}`}
            >
              {v ? 'صح' : 'خطأ'}
            </button>
          ))}
        </div>
      )}
      {(q.type === 'short_answer' || q.type === 'essay') && (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          dir="auto"
          rows={q.type === 'essay' ? 8 : 3}
          placeholder="اكتب إجابتك (بالعربية أو الإنجليزية)"
          className="w-full rounded-lg border border-stone-300 p-3 leading-relaxed focus:border-stone-500 focus:outline-none"
        />
      )}
      <Button variant="primary" onClick={submit} disabled={!ready || busy}>
        {busy ? 'جارٍ الإرسال...' : 'تحقق من إجابتي'}
      </Button>
    </div>
  );
}

export function QuizPage() {
  const id = Number(useParams().id);
  const [quiz, setQuiz] = useState<QuizDTO>();
  const [index, setIndex] = useState(0);
  const [names, setNames] = useState(new Map<number, string>());
  const [error, setError] = useState<string>();
  const left = useCountdown(quiz);

  const load = useCallback(() => api.quiz(id).then(setQuiz, (e: Error) => setError(e.message)), [id]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (quiz) api.files(quiz.subjectId).then((f) => setNames(new Map(f.map((x) => [x.id, x.name]))), () => {});
  }, [quiz?.subjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while an essay is being graded; reload when the timer runs out.
  const grading = quiz?.items.some((i) => i.attempt?.status === 'grading');
  useEffect(() => {
    if (!grading) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [grading, load]);
  useEffect(() => {
    if (left === 0) void load();
  }, [left, load]);

  async function act(fn: () => Promise<QuizDTO>) {
    setError(undefined);
    try {
      setQuiz(await fn());
    } catch (e) {
      setError((e as Error).message);
      void load();
    }
  }

  if (!quiz) return <main className="mx-auto max-w-3xl px-4 py-8">{error ? <ErrorText>{error}</ErrorText> : <p className="text-stone-500">جارٍ التحميل...</p>}</main>;

  const item = quiz.items[Math.min(index, quiz.items.length - 1)]!;
  const answered = quiz.items.filter((i) => i.attempt).length;
  const finished = !!quiz.finishedAt;

  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to={quiz.kind === 'review' ? '/review' : `/subjects/${quiz.subjectId}/practice`} className="text-sm text-stone-500 hover:underline">
            ‹ {quiz.kind === 'review' ? 'مراجعة اليوم' : 'التدريب'}
          </Link>
          <h1 className="text-xl font-bold">{quiz.title}</h1>
        </div>
        <div className="flex items-center gap-3">
          {left !== null && <span className={`rounded-lg px-3 py-1 font-mono text-lg ${left < 60 ? 'bg-red-100 text-red-800' : 'bg-stone-100'}`}>{mmss(left)}</span>}
          <span className="text-sm text-stone-500">
            أجبت {answered} من {quiz.items.length}
          </span>
          {!finished && (
            <Button onClick={() => (answered === quiz.items.length || confirm('إنهاء الاختبار؟ الأسئلة بلا إجابة تُحسب صفرًا.')) && act(() => api.finishQuiz(id))}>
              إنهاء الاختبار
            </Button>
          )}
        </div>
      </div>

      {finished && (
        <section className="space-y-3 rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="font-semibold">
            النتيجة: {quiz.score === null ? 'جارٍ تصحيح الأسئلة المقالية...' : `${Math.round(quiz.score * 100)}%`}
          </h2>
          {quiz.timeLimitSec && <p className="text-sm text-stone-500">اختبار بوقت ({Math.round(quiz.timeLimitSec / 60)} دقيقة).</p>}
        </section>
      )}

      <nav className="flex flex-wrap gap-1.5">
        {quiz.items.map((it, i) => {
          const r = itemResult(it);
          const color = { green: 'bg-emerald-500 text-white', red: 'bg-red-500 text-white', amber: 'bg-amber-400', blue: 'bg-sky-300', gray: 'bg-stone-200' }[r.tone];
          return (
            <button key={it.question.id} onClick={() => setIndex(i)} title={r.label} className={`size-8 rounded-lg text-sm ${color} ${i === index ? 'ring-2 ring-stone-900 ring-offset-1' : ''}`}>
              {i + 1}
            </button>
          );
        })}
      </nav>

      <section className="space-y-4 rounded-xl border border-stone-200 bg-white p-5">
        <div className="flex items-center justify-between gap-2">
          <QuestionMeta q={item.question} />
          {item.attempt && <Badge tone={itemResult(item).tone}>{itemResult(item).label}</Badge>}
        </div>
        <Stem text={item.question.stem} />
        <ErrorText>{error}</ErrorText>

        {!item.attempt && !finished && <AnswerForm key={item.question.id} item={item} onSubmit={(a) => act(() => api.answer(id, item.question.id, a))} />}
        {item.attempt?.status === 'grading' && <p className="animate-pulse text-sky-800">جارٍ تصحيح إجابتك مقابل المصادر...</p>}
        {item.attempt?.status === 'failed' && (
          <div className="space-y-2">
            <p className="text-sm text-red-700">{item.attempt.error}</p>
            <Button onClick={() => act(() => api.regrade(id, item.question.id))}>أعد التصحيح</Button>
          </div>
        )}
        {(item.attempt || finished) && item.question.answer && item.attempt?.status !== 'grading' && (
          <QuestionReview q={item.question} attempt={item.attempt} names={names} />
        )}
        {item.attempt?.status === 'graded' && <CardNote card={item.card} />}

        <div className="flex items-center justify-between border-t border-stone-100 pt-3">
          <ReportButton q={item.question} />
          <div className="flex gap-2">
            <Button onClick={() => setIndex(index - 1)} disabled={index === 0}>
              السابق
            </Button>
            <Button onClick={() => setIndex(index + 1)} disabled={index >= quiz.items.length - 1}>
              التالي
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
