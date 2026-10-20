import type { SubjectDTO } from '@zakir/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.ts';
import { Button, Card, daysUntil, ErrorText, inputClass } from '../components/ui.tsx';

export function SubjectsPage() {
  const [subjects, setSubjects] = useState<SubjectDTO[]>();
  const [name, setName] = useState('');
  const [doctor, setDoctor] = useState('');
  const [error, setError] = useState<string>();

  const load = () => api.subjects().then(setSubjects, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await api.createSubject(name, doctor);
      setName('');
      setDoctor('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold">المواد</h1>

      <Card title="مادة جديدة">
        <form onSubmit={create} className="flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم المادة" className={`${inputClass} min-w-0 flex-1`} />
          <input value={doctor} onChange={(e) => setDoctor(e.target.value)} placeholder="الدكتور (اختياري)" className={`${inputClass} min-w-0 flex-1`} />
          <Button variant="primary" className="py-2">
            إضافة
          </Button>
        </form>
        <ErrorText>{error}</ErrorText>
      </Card>

      {subjects && !subjects.length && <p className="text-stone-500">لا توجد مواد بعد. أضف أول مادة من الأعلى.</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {subjects?.map((s) => {
          const next = s.exams.find((e) => e.examDate && daysUntil(e.examDate) >= 0);
          return (
            <li key={s.id}>
              <Link to={`/subjects/${s.id}`} className="block space-y-1 rounded-xl border border-stone-200 bg-white p-4 hover:border-stone-400">
                <h2 className="text-lg font-semibold">{s.name}</h2>
                {s.doctor && <p className="text-sm text-stone-600">{s.doctor}</p>}
                <p className="text-sm text-stone-500">
                  {s.fileCount} ملف
                  {next?.examDate && ` · ${next.title} بعد ${daysUntil(next.examDate)} يوم`}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
