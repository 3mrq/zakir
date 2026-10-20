// Weak chapters/topics and the mistake log of a subject.

import type { MistakeDTO, SubjectDTO, WeaknessesDTO, WeaknessRow } from '@zakir/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api.ts';
import { CardNote } from '../components/CardNote.tsx';
import { QuestionMeta, QuestionReview, Stem } from '../components/question.tsx';
import { Badge, Button, Card, ErrorText, formatDate } from '../components/ui.tsx';

const WEAK = 0.6;

function Accuracy({ row, min }: { row: WeaknessRow; min: number }) {
  if (!row.attempts) return <span className="text-xs text-stone-400">لم تُختبر بعد</span>;
  const pct = Math.round(row.accuracy * 100);
  const judged = row.attempts >= min;
  const color = !judged ? 'bg-stone-400' : row.accuracy < WEAK ? 'bg-red-500' : row.accuracy < 0.8 ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <div className="flex min-w-40 items-center gap-2">
      <div className="h-2 flex-1 rounded-full bg-stone-100">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.max(pct, 3)}%` }} />
      </div>
      <span className="w-24 text-xs text-stone-600">
        {pct}% من {row.attempts}
        {!judged && ' (قليل)'}
      </span>
    </div>
  );
}

function WeakTable({ title, rows, min, onExplain }: { title: string; rows: WeaknessRow[]; min: number; onExplain?: (r: WeaknessRow) => void }) {
  if (!rows.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="divide-y divide-stone-100">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <bdi>{r.title}</bdi>
              {r.attempts >= min && r.accuracy < WEAK && (
                <Badge tone="red">
                  <span className="ms-1">نقطة ضعف</span>
                </Badge>
              )}
            </span>
            <Accuracy row={r} min={min} />
            {r.openCards > 0 && <span className="text-xs text-amber-800">{r.openCards} في المراجعة</span>}
            {onExplain && r.attempts >= min && r.accuracy < WEAK && (
              <button onClick={() => onExplain(r)} className="text-xs text-stone-600 underline hover:text-stone-900">
                اشرحه لي
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MistakeItem({ m, names }: { m: MistakeDTO; names: Map<number, string> }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="space-y-2 py-3">
      <button onClick={() => setOpen(!open)} className="w-full space-y-1 text-start">
        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
          <QuestionMeta q={m.question} />
          {m.chapterTitle && <bdi>{m.chapterTitle}</bdi>}
          <span>{formatDate(m.createdAt)}</span>
          <Badge tone={m.score === 0 ? 'red' : 'amber'}>{m.score === 0 ? 'خاطئة' : `${Math.round(m.score * 100)}%`}</Badge>
        </div>
        <Stem text={m.question.stem} />
      </button>
      <CardNote card={m.card} />
      {open && <QuestionReview q={m.question} attempt={m.attempt} names={names} />}
    </li>
  );
}

export function InsightsPage() {
  const subjectId = Number(useParams().id);
  const navigate = useNavigate();
  const [subject, setSubject] = useState<SubjectDTO>();
  const [weak, setWeak] = useState<WeaknessesDTO>();
  const [mistakes, setMistakes] = useState<MistakeDTO[]>([]);
  const [names, setNames] = useState(new Map<number, string>());
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([api.subject(subjectId), api.weaknesses(subjectId), api.mistakes(subjectId), api.files(subjectId)]).then(
      ([s, w, m, f]) => {
        setSubject(s);
        setWeak(w);
        setMistakes(m);
        setNames(new Map(f.map((x) => [x.id, x.name])));
      },
      (e: Error) => setError(e.message),
    );
  }, [subjectId]);

  async function explain(r: WeaknessRow) {
    try {
      const what = r.range ? `موضوع «${r.title}»` : `شابتر «${r.title}»`;
      const t = await api.ask(
        subjectId,
        `أخطئ كثيرًا في ${what}. اشرحه لي من البداية بشكل مبسّط، ونبّهني على النقاط التي يسهل الخلط فيها.`,
        r.chapterId ? { chapterId: r.chapterId, range: r.range, label: r.title } : {},
      );
      navigate(`/subjects/${subjectId}/ask?thread=${t.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function review() {
    try {
      navigate(`/quizzes/${(await api.startReview(subjectId)).id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!subject || !weak) return <main className="mx-auto max-w-4xl px-4 py-8">{error ? <ErrorText>{error}</ErrorText> : <p className="text-stone-500">جارٍ التحميل...</p>}</main>;

  const tested = weak.chapters.some((c) => c.attempts > 0);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to={`/subjects/${subjectId}`} className="text-sm text-stone-500 hover:underline">
            ‹ {subject.name}
          </Link>
          <h1 className="text-2xl font-bold">نقاط الضعف وسجل الأخطاء</h1>
        </div>
        <Button variant="primary" onClick={review}>
          راجع أخطاء اليوم
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>

      <Card title="نقاط الضعف">
        {!tested ? (
          <p className="text-sm text-stone-500">لا توجد إجابات بعد. حل اختبارًا تدريبيًا لتظهر نسبك هنا.</p>
        ) : (
          <>
            <p className="text-xs text-stone-500">
              النسبة = متوسط درجاتك في أسئلة الشابتر أو الموضوع. يُحكم على الموضوع بعد {weak.minAttempts} إجابات على الأقل. الموضوع يُحسب من صفحات مصدر كل سؤال.
            </p>
            <WeakTable title="حسب الشابتر" rows={weak.chapters} min={weak.minAttempts} onExplain={explain} />
            <WeakTable title="حسب الموضوع" rows={weak.topics} min={weak.minAttempts} onExplain={explain} />
          </>
        )}
      </Card>

      <Card title={`سجل الأخطاء (${mistakes.length})`}>
        {!mistakes.length && <p className="text-sm text-stone-500">لا توجد أخطاء مسجلة.</p>}
        <ul className="divide-y divide-stone-100">
          {mistakes.map((m) => (
            <MistakeItem key={m.attemptId} m={m} names={names} />
          ))}
        </ul>
      </Card>
    </main>
  );
}
