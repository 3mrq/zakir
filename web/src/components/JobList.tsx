import { JOB_STATUS_LABEL, TASK_KIND_LABEL, type JobDTO, type JobStatus, type SourceRef } from '@zakir/shared';

const STATUS_STYLE: Record<JobStatus, string> = {
  queued: 'bg-stone-200 text-stone-700',
  running: 'bg-sky-100 text-sky-800 animate-pulse',
  done: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-stone-200 text-stone-500',
};

interface SmokeResult {
  found: boolean;
  answer: string;
  refs: SourceRef[];
}

function seconds(ms: number | null) {
  return ms == null ? '' : `${(ms / 1000).toLocaleString('ar-SA', { maximumFractionDigits: 1 })} ث`;
}

export function JobList({ jobs, onCancel }: { jobs: JobDTO[]; onCancel: (id: number) => void }) {
  if (!jobs.length) return <p className="text-stone-500">لا توجد مهام بعد.</p>;
  return (
    <ul className="space-y-3">
      {jobs.map((job) => {
        const result = job.kind === 'smoke_test' ? (job.result as SmokeResult | null) : null;
        return (
          <li key={job.id} className="rounded-xl border border-stone-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`rounded-full px-2.5 py-0.5 font-medium ${STATUS_STYLE[job.status]}`}>{JOB_STATUS_LABEL[job.status]}</span>
              <span className="font-medium">{TASK_KIND_LABEL[job.kind] ?? job.kind}</span>
              <span className="text-stone-400">#{job.id}</span>
              {job.model && <bdi className="text-stone-400">{job.model}</bdi>}
              {job.attempts > 1 && <span className="text-amber-700">محاولة {job.attempts}</span>}
              <span className="text-stone-400">{seconds(job.durationMs)}</span>
              {(job.status === 'queued' || job.status === 'running') && (
                <button onClick={() => onCancel(job.id)} className="ms-auto rounded-lg border border-stone-300 px-2.5 py-1 hover:bg-stone-100">
                  إلغاء
                </button>
              )}
            </div>
            {job.error && <p className="mt-2 text-sm text-red-700">{job.error}</p>}
            {result && (
              <div className="mt-3 space-y-2">
                {!result.found && <p className="text-sm font-medium text-amber-700">غير موجود في الملفات</p>}
                <p className="leading-relaxed">{result.answer}</p>
                {result.refs.length > 0 && (
                  <div className="flex flex-wrap gap-2 text-sm">
                    {result.refs.map((r) => (
                      <span key={`${r.file}-${r.page}`} className="rounded-md bg-stone-100 px-2 py-0.5 text-stone-700">
                        المصدر: <bdi>{r.file}</bdi>، صفحة {r.page}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
