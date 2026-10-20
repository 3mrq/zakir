// Tracks the latest AI job of a kind attached to a record, polling while it is active.

import { JOB_STATUS_LABEL, type JobDTO, type TaskKind } from '@zakir/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { Badge } from './ui.tsx';

const isActive = (j?: JobDTO) => j?.status === 'queued' || j?.status === 'running';

export function useLatestJob(refType: string, refId: number, kind: TaskKind, onDone: () => void) {
  const [job, setJob] = useState<JobDTO>();
  const prev = useRef<JobDTO>(undefined);
  const done = useRef(onDone);
  done.current = onDone;

  const refresh = useCallback(async () => {
    const list = await api.jobsFor(refType, refId).catch(() => [] as JobDTO[]);
    const latest = list.find((j) => j.kind === kind);
    const before = prev.current;
    prev.current = latest;
    setJob(latest);
    if (isActive(before) && latest?.id === before!.id && !isActive(latest)) done.current();
  }, [refType, refId, kind]);

  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    if (!isActive(job)) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [job, refresh]);

  const track = (j: JobDTO) => {
    prev.current = j;
    setJob(j);
  };
  return { job, active: isActive(job), track };
}

function elapsed(job: JobDTO) {
  if (!job.startedAt) return '';
  const s = Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000);
  return ` (${s.toLocaleString('ar-SA')} ث)`;
}

/** One-line status of a job; shows the Arabic error when it failed. */
export function JobLine({ job, onCancel }: { job?: JobDTO; onCancel?: () => void }) {
  if (!job) return null;
  const tone = job.status === 'done' ? 'green' : job.status === 'failed' ? 'red' : job.status === 'cancelled' ? 'gray' : 'blue';
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center gap-2">
        <Badge tone={tone}>
          {JOB_STATUS_LABEL[job.status]}
          {job.status === 'running' && elapsed(job)}
        </Badge>
        {job.attempts > 1 && <span className="text-amber-700">إعادة محاولة بعد رد غير صالح</span>}
        {isActive(job) && onCancel && (
          <button onClick={onCancel} className="text-stone-500 underline hover:text-stone-800">
            إلغاء
          </button>
        )}
      </div>
      {job.status === 'failed' && job.error && <p className="text-red-700">{job.error}</p>}
    </div>
  );
}
