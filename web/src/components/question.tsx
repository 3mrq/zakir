// Shows a question with its answer, explanation and sources — and, when given, the student's attempt
// with why it was wrong. Used by the question bank and by the quiz after answering.

import { DIFFICULTY_LABEL, QUESTION_TYPE_LABEL, type AttemptDTO, type QuestionDTO } from '@zakir/shared';
import { useState } from 'react';
import { api } from '../api.ts';
import { RefList } from './RefChip.tsx';
import { Badge, Button, ErrorText } from './ui.tsx';

/** Direction of a question from its first strong character: English questions read left-to-right like the exam paper. */
export const questionDir = (stem: string): 'rtl' | 'ltr' => {
  const m = stem.match(/[A-Za-z؀-ۿ]/);
  return m && /[A-Za-z]/.test(m[0]) ? 'ltr' : 'rtl';
};

const LETTERS = { rtl: ['أ', 'ب', 'ج', 'د', 'هـ'], ltr: ['a', 'b', 'c', 'd', 'e'] };
export const letter = (i: number, dir: 'rtl' | 'ltr' = 'rtl') => LETTERS[dir][i] ?? String(i + 1);

export function QuestionMeta({ q }: { q: QuestionDTO }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge tone="gray">{QUESTION_TYPE_LABEL[q.type]}</Badge>
      <Badge tone="gray">{DIFFICULTY_LABEL[q.difficulty]}</Badge>
    </div>
  );
}

export function Stem({ text }: { text: string }) {
  return (
    <p dir={questionDir(text)} className="whitespace-pre-wrap text-lg font-medium leading-relaxed">
      {text}
    </p>
  );
}

export function ReportButton({ q, onDone }: { q: QuestionDTO; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(q.status === 'reported');

  if (sent) return <span className="text-xs text-amber-800">بُلّغ عن هذا السؤال — لن يظهر في الاختبارات القادمة.</span>;
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-stone-500 underline hover:text-red-700">
        بلّغ عن خطأ
      </button>
    );
  return (
    <div className="space-y-2 rounded-lg border border-stone-200 p-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="ما الخطأ؟ مثل: الخيار ج صحيح أيضًا، أو المعلومة غير موجودة في الصفحة"
        className="w-full rounded border border-stone-300 p-2 text-sm"
      />
      <div className="flex gap-2">
        <Button
          variant="danger"
          onClick={async () => {
            try {
              await api.reportQuestion(q.id, note);
              setSent(true);
              onDone?.();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          إرسال البلاغ
        </Button>
        <Button onClick={() => setOpen(false)}>إلغاء</Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

const KP_STYLE = {
  covered: { tone: 'green' as const, label: 'مذكورة' },
  partial: { tone: 'amber' as const, label: 'ناقصة' },
  missing: { tone: 'red' as const, label: 'غير مذكورة' },
};

/** Full review of an answered (or bank) question. `names` maps file ids to names for source chips. */
export function QuestionReview({ q, attempt, names }: { q: QuestionDTO; attempt?: AttemptDTO | null; names: Map<number, string> }) {
  const a = q.answer;
  if (!a) return null;
  const chosen = attempt?.answer.choice;
  const dir = questionDir(q.stem);

  return (
    <div className="space-y-3">
      {q.type === 'mcq' && q.options && (
        <ol dir={dir} className="space-y-1.5">
          {q.options.map((o, i) => {
            const correct = i === a.correctIndex;
            const mine = i === chosen;
            const style = correct ? 'border-emerald-300 bg-emerald-50' : mine ? 'border-red-300 bg-red-50' : 'border-stone-200';
            return (
              <li key={i} className={`rounded-lg border p-2 ${style}`}>
                <div className="flex items-start gap-2">
                  <span className="font-medium text-stone-500">{letter(i, dir)})</span>
                  <span className="flex-1">
                    {o}
                  </span>
                  {correct && <Badge tone="green">الصحيحة</Badge>}
                  {mine && !correct && <Badge tone="red">إجابتك</Badge>}
                </div>
                {(correct || mine) && a.optionExplanations?.[i] && (
                  <p dir="rtl" className="mt-1 text-sm text-stone-700">
                    {a.optionExplanations[i]}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {q.type === 'true_false' && (
        <p>
          الإجابة الصحيحة: <strong>{a.correct ? 'صح' : 'خطأ'}</strong>
          {attempt && attempt.answer.bool !== a.correct && <span className="text-red-700"> — اخترت «{attempt.answer.bool ? 'صح' : 'خطأ'}»</span>}
        </p>
      )}

      {(q.type === 'short_answer' || q.type === 'essay') && (
        <>
          {attempt && (
            <div className="rounded-lg bg-stone-50 p-3">
              <p className="mb-1 text-xs text-stone-500">إجابتك</p>
              <p dir="auto" className="whitespace-pre-wrap">
                {attempt.answer.text}
              </p>
            </div>
          )}
          {attempt?.status === 'graded' && attempt.feedback && (
            <div className="space-y-2">
              <p>{attempt.feedback.summary}</p>
              <ul className="space-y-1.5">
                {attempt.feedback.keyPoints.map((k, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <Badge tone={KP_STYLE[k.status].tone}>{KP_STYLE[k.status].label}</Badge>
                    <div>
                      <span dir="auto">{a.keyPoints?.[i]?.text}</span>
                      {k.note && <p className="text-stone-600">{k.note}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              {attempt.feedback.mistakes.length > 0 && (
                <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="font-medium text-red-800">أخطاء في إجابتك</p>
                  {attempt.feedback.mistakes.map((m, i) => (
                    <div key={i} className="text-sm">
                      <p dir="auto">«{m.quote}»</p>
                      <p className="text-stone-700">
                        {m.why} <RefList refs={m.refs} names={names} />
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <details className="rounded-lg border border-stone-200 p-2">
            <summary className="cursor-pointer text-sm font-medium">الإجابة النموذجية ونقاط التصحيح</summary>
            <p dir="auto" className="mt-2 whitespace-pre-wrap">
              {a.modelAnswer}
            </p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-sm">
              {a.keyPoints?.map((k, i) => (
                <li key={i}>
                  <span dir="auto">{k.text}</span> <RefList refs={k.refs} names={names} />
                </li>
              ))}
            </ul>
          </details>
        </>
      )}

      <div className="rounded-lg bg-amber-50/60 p-3 text-sm leading-relaxed">
        <span className="font-medium">الشرح: </span>
        {a.explanation} <RefList refs={q.refs} names={names} />
      </div>
    </div>
  );
}
