// One plan task: done/skip controls and the action that starts it (open chapter, practice, review, mock...).

import { PLAN_TASK_LABEL, type PlanDTO, type PlanTaskDTO } from '@zakir/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api.ts';
import { Badge, Button, ErrorText, formatDate } from './ui.tsx';

const KIND_TONE = { study: 'blue', practice: 'green', strengthen: 'red', review: 'amber', mock: 'gray', final: 'gray' } as const;

export function minutesText(m: number) {
  if (m < 60) return `${m} د`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} س ${r} د` : `${h} س`;
}

export function PlanTaskRow({
  task,
  examId,
  subjectId,
  scopeIds,
  onChange,
  meta,
}: {
  task: PlanTaskDTO;
  examId: number;
  subjectId: number;
  scopeIds: number[];
  onChange: (plan: PlanDTO | null) => void;
  meta?: string;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const done = task.status === 'done';
  const skipped = task.status === 'skipped';

  async function run(fn: () => Promise<void>) {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const set = (status: 'pending' | 'done' | 'skipped') => run(async () => onChange(await api.setPlanTask(examId, task.key, status)));
  const quiz = (req: Parameters<typeof api.createQuiz>[1]) =>
    run(async () => {
      try {
        navigate(`/quizzes/${(await api.createQuiz(subjectId, req)).id}`);
      } catch (e) {
        throw new Error(`${(e as Error).message} — افتح «التدريب والأسئلة» لتوليد أسئلة لهذا الشابتر.`);
      }
    });
  const explain = () =>
    run(async () => {
      const t = await api.ask(subjectId, `${task.detail} اشرح لي هذه النقاط من البداية بشكل مبسّط، ونبّهني على ما يسهل الخلط فيه.`, { chapterId: task.chapterId! });
      navigate(`/subjects/${subjectId}/ask?thread=${t.id}`);
    });

  const actions = !done && !skipped && (
    <div className="flex flex-wrap gap-2">
      {task.kind === 'study' && task.chapterId && (
        <>
          <Link to={`/chapters/${task.chapterId}`} className="rounded-lg border border-stone-300 px-2.5 py-1 text-sm hover:bg-stone-100">
            الشابتر وملخصه
          </Link>
          {task.range && (
            <Link to={`/files/${task.range.fileId}?page=${task.range.from}`} className="rounded-lg border border-stone-300 px-2.5 py-1 text-sm hover:bg-stone-100">
              افتح الصفحات
            </Link>
          )}
        </>
      )}
      {task.kind === 'practice' && <Button onClick={() => quiz({ chapterIds: [task.chapterId!], count: 10 })}>ابدأ التدريب</Button>}
      {task.kind === 'strengthen' && (
        <>
          <Button onClick={explain}>اشرحه لي</Button>
          <Button onClick={() => quiz({ chapterIds: [task.chapterId!], count: 8 })}>تدرّب عليه</Button>
        </>
      )}
      {task.kind === 'review' && <Button onClick={() => run(async () => navigate(`/quizzes/${(await api.startReview(subjectId)).id}`))}>ابدأ المراجعة</Button>}
      {task.kind === 'mock' && <Button onClick={() => quiz({ chapterIds: scopeIds, count: 20, timeLimitMin: task.minutes })}>ابدأ الاختبار التجريبي</Button>}
      {task.kind === 'final' && (
        <Link to={`/subjects/${subjectId}`} className="rounded-lg border border-stone-300 px-2.5 py-1 text-sm hover:bg-stone-100">
          الشباترات والملخصات
        </Link>
      )}
    </div>
  );

  return (
    <li className={`space-y-2 py-3 ${done || skipped ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        {task.kind !== 'review' ? (
          <input
            type="checkbox"
            checked={done}
            onChange={() => set(done ? 'pending' : 'done')}
            className="mt-1.5 size-4 cursor-pointer"
            aria-label={done ? 'إلغاء الإنجاز' : 'تم'}
          />
        ) : (
          <span className="mt-1.5 size-4" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={KIND_TONE[task.kind]}>{PLAN_TASK_LABEL[task.kind]}</Badge>
            <span className={`font-medium ${done ? 'line-through' : ''}`}>
              <bdi>{task.title}</bdi>
            </span>
            <span className="text-xs text-stone-500">{minutesText(task.minutes)}</span>
            {task.delayedFrom && <Badge tone="amber">مؤجلة من {formatDate(task.delayedFrom)}</Badge>}
            {task.auto && <Badge tone="green">أُنجزت تلقائيًا</Badge>}
            {skipped && <Badge tone="gray">تُخطّيت</Badge>}
          </div>
          {meta && <p className="text-xs text-stone-500">{meta}</p>}
          <p className="text-sm text-stone-600">{task.detail}</p>
          {actions}
          <ErrorText>{error}</ErrorText>
        </div>
        {task.kind !== 'review' &&
          (skipped ? (
            <button onClick={() => set('pending')} className="text-xs text-stone-500 underline">
              أعدها
            </button>
          ) : (
            !done && (
              <button onClick={() => set('skipped')} className="text-xs text-stone-400 hover:text-stone-700" title="لن تُجدول مرة أخرى">
                تخطَّ
              </button>
            )
          ))}
      </div>
    </li>
  );
}
