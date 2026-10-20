import type { AIHealth, JobDTO } from '@zakir/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { HealthCard } from '../components/HealthCard.tsx';
import { JobList } from '../components/JobList.tsx';

export function EnginePage() {
  const [health, setHealth] = useState<AIHealth>();
  const [healthError, setHealthError] = useState<string>();
  const [jobs, setJobs] = useState<JobDTO[]>([]);
  const [question, setQuestion] = useState('أين يتم إنتاج ATP؟');
  const [error, setError] = useState<string>();

  const checkHealth = useCallback(() => {
    setHealth(undefined);
    setHealthError(undefined);
    api.aiHealth().then(setHealth, (e: Error) => setHealthError(e.message));
  }, []);

  const loadJobs = useCallback(() => api.jobs().then(setJobs, (e: Error) => setError(e.message)), []);

  useEffect(checkHealth, [checkHealth]);

  // Poll faster while something is in flight.
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    void loadJobs();
    const t = setInterval(loadJobs, active ? 1000 : 5000);
    return () => clearInterval(t);
  }, [active, loadJobs]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await api.smokeTest(question);
      await loadJobs();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function cancel(id: number) {
    try {
      await api.cancelJob(id);
    } catch (err) {
      setError((err as Error).message);
    }
    await loadJobs();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold">المحرّك والمهام</h1>

      <HealthCard health={health} error={healthError} onRecheck={checkHealth} />

      <section className="space-y-3 rounded-xl border border-stone-200 bg-white p-4">
        <h2 className="font-semibold">اختبار استدعاء</h2>
        <p className="text-sm text-stone-500">
          يرسل السؤال مع صفحتين تجريبيتين عن الخلية والميتوكوندريا. الإجابة يجب أن تأتي منهما فقط مع رقم الصفحة، أو «غير موجود».
        </p>
        <form onSubmit={submit} className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2 focus:border-stone-500 focus:outline-none"
            placeholder="اكتب سؤالًا"
          />
          <button className="rounded-lg bg-stone-900 px-4 py-2 font-medium text-white hover:bg-stone-700">إرسال</button>
        </form>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">المهام</h2>
        <JobList jobs={jobs} onCancel={cancel} />
      </section>
    </main>
  );
}
