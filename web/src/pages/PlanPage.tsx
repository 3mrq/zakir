// Study plan for one exam: setup, today's tasks, the days ahead, what did not fit, and what is done.

import type { PlanDTO, PlanSettings } from '@zakir/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api.ts';
import { minutesText, PlanTaskRow } from '../components/PlanTask.tsx';
import { Button, Card, daysCount, ErrorText, formatDate, inputClass } from '../components/ui.tsx';

const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString('ar-SA-u-ca-gregory', { weekday: 'long', day: 'numeric', month: 'long' });

function SettingsForm({ initial, onSave, onCancel }: { initial: PlanSettings | null; onSave: (s: PlanSettings) => Promise<void>; onCancel?: () => void }) {
  const [hours, setHours] = useState(initial ? initial.dailyMinutes / 60 : 2);
  const [offDays, setOffDays] = useState<number[]>(initial?.offDays ?? [5]);
  const [mpp, setMpp] = useState(initial?.minutesPerPage ?? 4);
  const [saving, setSaving] = useState(false);
  return (
    <div className="space-y-4">
      <label className="block space-y-1">
        <span className="text-sm font-medium">وقتك المتاح للمذاكرة يوميًا</span>
        <div className="flex items-center gap-2">
          <input type="number" min={0.25} max={15} step={0.25} value={hours} onChange={(e) => setHours(Number(e.target.value))} className={`${inputClass} w-24`} />
          <span className="text-sm text-stone-600">ساعة ({minutesText(Math.round(hours * 60))})</span>
        </div>
      </label>
      <div className="space-y-1">
        <span className="text-sm font-medium">أيام الراحة</span>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((name, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setOffDays((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i]))}
              className={`rounded-lg border px-2.5 py-1 text-sm ${offDays.includes(i) ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-300'}`}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">سرعتك التقريبية في المذاكرة</span>
        <div className="flex items-center gap-2">
          <input type="number" min={1} max={20} step={0.5} value={mpp} onChange={(e) => setMpp(Number(e.target.value))} className={`${inputClass} w-20`} />
          <span className="text-sm text-stone-600">دقيقة للصفحة (تقدير مدة كل مهمة مذاكرة)</span>
        </div>
      </label>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave({ dailyMinutes: Math.round(hours * 60), offDays, minutesPerPage: mpp });
            } finally {
              setSaving(false);
            }
          }}
        >
          {initial ? 'حفظ وإعادة التوزيع' : 'أنشئ الخطة'}
        </Button>
        {onCancel && <Button onClick={onCancel}>إلغاء</Button>}
      </div>
    </div>
  );
}

export function PlanPage() {
  const examId = Number(useParams().id);
  const [plan, setPlan] = useState<PlanDTO | null>();
  const [settings, setSettings] = useState<PlanSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(
    () =>
      api.plan(examId).then(
        (r) => {
          setSettings(r.settings);
          setPlan(r.plan);
          setError(undefined);
        },
        (e: Error) => {
          setError(e.message);
          setPlan(null);
        },
      ),
    [examId],
  );
  useEffect(() => void load(), [load]);

  async function save(s: PlanSettings) {
    try {
      const r = await api.savePlan(examId, s);
      setSettings(r.settings);
      setPlan(r.plan);
      setEditing(false);
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (plan === undefined) return <main className="mx-auto max-w-4xl px-4 py-8 text-stone-500">جارٍ التحميل...</main>;

  if (!plan) {
    return (
      <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
        <h1 className="text-2xl font-bold">خطة المذاكرة</h1>
        <ErrorText>{error}</ErrorText>
        <Card title="إعداد الخطة">
          <p className="text-sm text-stone-600">
            الخطة تُبنى من تاريخ الاختبار ونطاقه (الشباترات) ووقتك. تُعاد حسابها كل مرة تفتحها: ما تأخرت فيه يُوزّع على الأيام الباقية، ونقاط ضعفك تضيف مهام تقوية،
            وأوزان الشباترات في اختبارات الدكتور ترتّب الأولويات إن ضاق الوقت. لا تستهلك أي استدعاء للذكاء الاصطناعي.
          </p>
          <SettingsForm initial={settings} onSave={save} />
        </Card>
      </main>
    );
  }

  const scopeIds = plan.scope.map((s) => s.chapterId);
  const progress = plan.stats.totalMinutes ? Math.round((plan.stats.doneMinutes / plan.stats.totalMinutes) * 100) : 0;
  const today = plan.days[0];
  const upcoming = plan.days.slice(1).filter((d) => d.tasks.length || d.capacity === 0);
  const visible = showAll ? upcoming : upcoming.slice(0, 7);
  const row = (t: PlanDTO['days'][number]['tasks'][number]) => (
    <PlanTaskRow key={t.key} task={t} examId={examId} subjectId={plan.subjectId} scopeIds={scopeIds} onChange={(p) => setPlan(p)} />
  );

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to={`/subjects/${plan.subjectId}`} className="text-sm text-stone-500 hover:underline">
            ‹ المادة
          </Link>
          <h1 className="text-2xl font-bold">خطة: {plan.examTitle}</h1>
          <p className="text-stone-600">
            الاختبار {dayLabel(plan.examDate)} · {plan.stats.daysLeft ? `باقي ${daysCount(plan.stats.daysLeft)} للمذاكرة` : 'لا أيام متبقية'}
          </p>
        </div>
        <Button onClick={() => setEditing(!editing)}>إعدادات الخطة</Button>
      </div>
      <ErrorText>{error}</ErrorText>

      {editing && (
        <Card title="إعدادات الخطة">
          <SettingsForm initial={plan.settings} onSave={save} onCancel={() => setEditing(false)} />
        </Card>
      )}

      <section className="space-y-2 rounded-xl border border-stone-200 bg-white p-4">
        <div className="flex justify-between text-sm">
          <span>
            أنجزت {minutesText(plan.stats.doneMinutes)} من {minutesText(plan.stats.totalMinutes)}
          </span>
          <span className="text-stone-500">
            المتبقي {minutesText(plan.stats.remainingMinutes)} · المتاح {minutesText(plan.stats.availableMinutes)}
          </span>
        </div>
        <div className="h-2.5 rounded-full bg-stone-100">
          <div className="h-2.5 rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
        </div>
        {plan.warnings.map((w, i) => (
          <p key={i} className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
            {w}
          </p>
        ))}
      </section>

      <Card title={today?.date === new Date().toLocaleDateString('en-CA') ? `اليوم — ${dayLabel(today.date)}` : 'أقرب يوم'}>
        {!today || !today.tasks.length ? (
          <p className="text-sm text-stone-500">{today?.capacity === 0 ? 'يوم راحة. 🌿' : 'لا مهام لليوم.'}</p>
        ) : (
          <ul className="divide-y divide-stone-100">{today.tasks.map(row)}</ul>
        )}
      </Card>

      {upcoming.length > 0 && (
        <Card title="الأيام القادمة">
          <ol className="space-y-4">
            {visible.map((d) => (
              <li key={d.date}>
                <div className="flex items-center justify-between border-b border-stone-100 pb-1">
                  <span className="font-medium">{dayLabel(d.date)}</span>
                  <span className="text-xs text-stone-500">
                    {d.capacity === 0
                      ? 'راحة'
                      : `${minutesText(d.tasks.reduce((n, t) => n + t.minutes, 0))} من ${minutesText(d.capacity)}${d.reserved ? ` · ${d.reserved} د للمراجعة` : ''}`}
                  </span>
                </div>
                {d.tasks.length > 0 && <ul className="divide-y divide-stone-100">{d.tasks.map(row)}</ul>}
              </li>
            ))}
          </ol>
          {upcoming.length > visible.length && (
            <Button onClick={() => setShowAll(true)}>اعرض كل الأيام ({upcoming.length})</Button>
          )}
        </Card>
      )}

      {plan.overflow.length > 0 && (
        <Card title={`لم يتسع له الوقت (${plan.overflow.length})`}>
          <p className="text-sm text-stone-500">هذه المهام أقل أولوية حسب أوزان الشباترات وضعفك. أنجز أيًا منها إن سنح وقت، أو زد وقتك اليومي من الإعدادات.</p>
          <ul className="divide-y divide-stone-100">{plan.overflow.map(row)}</ul>
        </Card>
      )}

      {plan.history.length > 0 && (
        <details className="rounded-xl border border-stone-200 bg-white p-4">
          <summary className="cursor-pointer font-semibold">ما أنجزته ({plan.history.filter((t) => t.status === 'done').length})</summary>
          <ul className="divide-y divide-stone-100">{plan.history.map(row)}</ul>
        </details>
      )}

      <p className="text-xs text-stone-400">
        النطاق: {plan.scope.map((s) => s.title).join('، ')} · الخطة تُعاد حسابها عند كل فتح، بلا أي استدعاء للذكاء الاصطناعي. ·{' '}
        <button
          className="underline"
          onClick={async () => {
            if (!confirm('حذف الخطة وسجل إنجازها؟')) return;
            await api.deletePlan(examId);
            await load();
          }}
        >
          حذف الخطة
        </button>{' '}
        · أُنشئت للاختبار بتاريخ {formatDate(plan.examDate)}
      </p>
    </main>
  );
}
