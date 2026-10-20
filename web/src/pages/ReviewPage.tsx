// «مراجعة اليوم»: due cards per subject (Leitner), and a button to start each review.

import type { ReviewSubjectDTO, TodayTaskDTO } from '@zakir/shared';
import { LEITNER_DAYS } from '@zakir/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api.ts';
import { whenText } from '../components/CardNote.tsx';
import { PlanTaskRow } from '../components/PlanTask.tsx';
import { Button, Card, daysCount, ErrorText, questionsCount } from '../components/ui.tsx';

export function ReviewPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ReviewSubjectDTO[]>();
  const [error, setError] = useState<string>();
  const [tasks, setTasks] = useState<TodayTaskDTO[]>([]);
  const loadTasks = () => api.todayTasks().then((t) => setTasks(t.filter((x) => x.kind !== 'review')), () => {});
  useEffect(() => {
    void api.reviewToday().then(setRows, (e: Error) => setError(e.message));
    void loadTasks();
  }, []);

  async function start(subjectId: number) {
    setError(undefined);
    try {
      navigate(`/quizzes/${(await api.startReview(subjectId)).id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const totalDue = rows?.reduce((n, r) => n + r.due, 0) ?? 0;
  const withCards = rows?.filter((r) => r.learning + r.mastered > 0) ?? [];

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-bold">اليوم</h1>
      </div>

      {tasks.length > 0 && (
        <Card title={`مهام خطتك اليوم (${tasks.filter((t) => t.status === 'pending').length} متبقية)`}>
          <ul className="divide-y divide-stone-100">
            {tasks.map((t) => (
              <PlanTaskRow
                key={`${t.examId}-${t.key}`}
                task={t}
                examId={t.examId}
                subjectId={t.subjectId}
                scopeIds={t.chapterId ? [t.chapterId] : []}
                onChange={() => void loadTasks()}
                meta={`${t.subjectName} · ${t.examTitle}`}
              />
            ))}
          </ul>
        </Card>
      )}

      <div>
        <h2 className="text-xl font-bold">مراجعة الأخطاء</h2>
        <p className="text-stone-600">
          {totalDue ? `عندك ${questionsCount(totalDue)} للمراجعة اليوم.` : 'لا توجد مراجعات مستحقة اليوم.'} كل سؤال أخطأت فيه يعود لك في الوقت المناسب: إن أجبت صح انتقل لصندوق أعلى ومدة أطول، وإن أخطأت رجع للصندوق الأول.
        </p>
        <p className="text-sm text-stone-500">
          المدد بين المراجعات حسب الصندوق: {LEITNER_DAYS.slice(1).map((d, i) => `ص${i + 1}: ${daysCount(d)}`).join(' · ')}
        </p>
      </div>
      <ErrorText>{error}</ErrorText>
      {rows && !withCards.length && (
        <Card>
          <p className="text-stone-600">سجل الأخطاء فارغ. حل اختبارات تدريبية من صفحة «التدريب والأسئلة» في أي مادة، وكل خطأ سيظهر هنا للمراجعة.</p>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {withCards.map((r) => (
          <section key={r.subjectId} className="space-y-3 rounded-xl border border-stone-200 bg-white p-4">
            <div className="flex items-start justify-between gap-2">
              <Link to={`/subjects/${r.subjectId}/mistakes`} className="text-lg font-semibold hover:underline">
                {r.name}
              </Link>
              <span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${r.due ? 'bg-amber-100 text-amber-900' : 'bg-stone-100 text-stone-600'}`}>
                {r.due} مستحق
              </span>
            </div>
            <div className="flex items-end gap-1.5" aria-label="توزيع الأسئلة على الصناديق">
              {r.boxes.map((n, i) => {
                const max = Math.max(1, ...r.boxes);
                return (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1 text-xs text-stone-500">
                    <span>{n}</span>
                    <div className="w-full rounded-t bg-stone-700" style={{ height: `${4 + (n / max) * 40}px`, opacity: 0.35 + i * 0.15 }} />
                    <span>ص{i + 1}</span>
                  </div>
                );
              })}
            </div>
            <p className="text-sm text-stone-600">
              قيد التعلم {r.learning} · أتقنت {r.mastered}
              {!r.due && r.nextDueOn && ` · المراجعة القادمة ${whenText(r.nextDueOn)}`}
            </p>
            <Button variant="primary" disabled={!r.due} onClick={() => start(r.subjectId)}>
              ابدأ المراجعة
            </Button>
          </section>
        ))}
      </div>
    </main>
  );
}
