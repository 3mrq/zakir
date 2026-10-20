import type { ChapterDTO, ChapterInput, RangeDTO, TopicDTO } from '@zakir/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, type ContentFile } from '../api.ts';
import { JobLine, useLatestJob } from './jobs.tsx';
import { Badge, Button, Card, ErrorText, inputClass } from './ui.tsx';

const SUMMARY_BADGE = {
  none: <Badge tone="gray">بلا ملخص</Badge>,
  ready: <Badge tone="green">ملخّص</Badge>,
  stale: <Badge tone="amber">الملخص قديم</Badge>,
};

function rangeText(r: RangeDTO, names: Map<number, string>) {
  return `«${names.get(r.fileId) ?? r.fileId}» ص ${r.from === r.to ? r.from : `${r.from}–${r.to}`}`;
}

export function ChaptersCard({
  subjectId,
  chapters,
  files,
  onChange,
}: {
  subjectId: number;
  chapters: ChapterDTO[];
  files: ContentFile[];
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const seg = useLatestJob('subject', subjectId, 'segment', onChange);
  const names = new Map(files.map((f) => [f.id, f.name]));

  async function auto() {
    if (chapters.length && !confirm('التقسيم التلقائي يستبدل كل الشباترات الحالية، وتُحذف ملخصاتها ونطاقات الاختبارات المرتبطة بها. متابعة؟')) return;
    setError(undefined);
    try {
      seg.track(await api.autoChapters(subjectId));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (editing) {
    return (
      <ChapterEditor
        subjectId={subjectId}
        chapters={chapters}
        files={files}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChange();
        }}
      />
    );
  }

  return (
    <Card
      title={`الشباترات (${chapters.length})`}
      actions={
        <div className="flex gap-2">
          <Button onClick={auto} disabled={seg.active}>
            {seg.active ? 'جارٍ التقسيم...' : 'تقسيم تلقائي'}
          </Button>
          <Button onClick={() => setEditing(true)} disabled={seg.active || !files.length}>
            تعديل يدويًا
          </Button>
        </div>
      }
    >
      <ErrorText>{error}</ErrorText>
      {(seg.active || seg.job?.status === 'failed') && <JobLine job={seg.job} />}
      {!chapters.length && (
        <p className="text-sm text-stone-500">
          {files.length ? 'لا توجد شباترات بعد. اضغط «تقسيم تلقائي» ليقترحها الذكاء الاصطناعي من عناوين الصفحات، ثم عدّلها إن لزم.' : 'ارفع ملفات محتوى أولًا.'}
        </p>
      )}
      <ol className="divide-y divide-stone-100">
        {chapters.map((c, i) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
            <span className="w-6 text-stone-400">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <Link to={`/chapters/${c.id}`} className="font-medium hover:underline">
                <bdi>{c.title}</bdi>
              </Link>
              <p className="text-xs text-stone-500">
                {c.pageCount} صفحة · {c.ranges.map((r) => rangeText(r, names)).join('، ')}
                {c.topics.length > 0 && ` · ${c.topics.length} موضوع`}
              </p>
            </div>
            {SUMMARY_BADGE[c.summary]}
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ---------- manual editor ----------

type Draft = ChapterInput & { key: number };
let keySeq = 0;

function toDraft(c: ChapterDTO): Draft {
  return { key: ++keySeq, id: c.id, title: c.title, ranges: c.ranges.map((r) => ({ ...r })), topics: c.topics.map((t) => ({ ...t })) };
}

function NumberBox({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <input
      type="number"
      min={1}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-16 rounded border border-stone-300 px-1 py-1 text-center"
    />
  );
}

function RangeRow<T extends RangeDTO>({ r, files, onChange, onRemove, children }: { r: T; files: ContentFile[]; onChange: (r: T) => void; onRemove: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {children}
      <select value={r.fileId} onChange={(e) => onChange({ ...r, fileId: Number(e.target.value) })} className="max-w-56 rounded border border-stone-300 px-1 py-1">
        {files.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} ({f.pageCount} ص)
          </option>
        ))}
      </select>
      <span>من</span>
      <NumberBox value={r.from} label="من صفحة" onChange={(from) => onChange({ ...r, from })} />
      <span>إلى</span>
      <NumberBox value={r.to} label="إلى صفحة" onChange={(to) => onChange({ ...r, to })} />
      <button onClick={onRemove} className="text-stone-400 hover:text-red-700" aria-label="حذف">
        ✕
      </button>
    </div>
  );
}

/** Pages of content files not in any chapter — shown so gaps are visible before saving. */
function uncovered(drafts: Draft[], files: ContentFile[]) {
  const out: string[] = [];
  for (const f of files) {
    const missing: number[] = [];
    for (let p = 1; p <= f.pageCount; p++) {
      if (!drafts.some((d) => d.ranges.some((r) => r.fileId === f.id && r.from <= p && p <= r.to))) missing.push(p);
    }
    if (missing.length) out.push(`«${f.name}»: ${missing.length} صفحة (${missing.slice(0, 8).join('، ')}${missing.length > 8 ? '…' : ''})`);
  }
  return out;
}

function ChapterEditor({
  subjectId,
  chapters,
  files,
  onClose,
  onSaved,
}: {
  subjectId: number;
  chapters: ChapterDTO[];
  files: ContentFile[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => chapters.map(toDraft));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const firstFile = files[0]!;

  const update = (key: number, fn: (d: Draft) => Draft) => setDrafts((ds) => ds.map((d) => (d.key === key ? fn(d) : d)));
  const move = (i: number, by: number) =>
    setDrafts((ds) => {
      const next = [...ds];
      const [d] = next.splice(i, 1);
      next.splice(Math.min(Math.max(0, i + by), next.length), 0, d!);
      return next;
    });

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      await api.saveChapters(subjectId, drafts.map(({ key: _key, ...c }) => c));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const gaps = uncovered(drafts, files);

  return (
    <Card
      title="تعديل الشباترات"
      actions={
        <div className="flex gap-2">
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'جارٍ الحفظ...' : 'حفظ'}
          </Button>
          <Button onClick={onClose}>إلغاء</Button>
        </div>
      }
    >
      <p className="text-sm text-stone-500">
        كل شابتر نطاق صفحات أو أكثر (يمكن أن يمتد عبر عدة ملفات). الصفحة الواحدة تتبع شابترًا واحدًا فقط. تعديل صفحات شابتر له ملخص يجعل الملخص «قديمًا».
      </p>
      {error && <pre className="whitespace-pre-wrap font-sans text-sm text-red-700">{error}</pre>}
      {gaps.length > 0 && <p className="text-sm text-amber-800">صفحات خارج أي شابتر — {gaps.join(' · ')}</p>}

      <ol className="space-y-4">
        {drafts.map((d, i) => (
          <li key={d.key} className="space-y-2 rounded-lg border border-stone-200 p-3">
            <div className="flex items-center gap-2">
              <span className="text-stone-400">{i + 1}</span>
              <input
                value={d.title}
                onChange={(e) => update(d.key, (x) => ({ ...x, title: e.target.value }))}
                placeholder="عنوان الشابتر"
                className={`${inputClass} min-w-0 flex-1 py-1.5`}
              />
              <button onClick={() => move(i, -1)} disabled={i === 0} className="px-1 text-stone-500 disabled:opacity-30" aria-label="أعلى">
                ↑
              </button>
              <button onClick={() => move(i, 1)} disabled={i === drafts.length - 1} className="px-1 text-stone-500 disabled:opacity-30" aria-label="أسفل">
                ↓
              </button>
              <Button variant="danger" onClick={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))}>
                حذف
              </Button>
            </div>
            <div className="space-y-1.5 ps-6">
              <p className="text-xs font-medium text-stone-500">الصفحات</p>
              {d.ranges.map((r, j) => (
                <RangeRow
                  key={j}
                  r={r}
                  files={files}
                  onChange={(nr) => update(d.key, (x) => ({ ...x, ranges: x.ranges.map((o, k) => (k === j ? nr : o)) }))}
                  onRemove={() => update(d.key, (x) => ({ ...x, ranges: x.ranges.filter((_, k) => k !== j) }))}
                />
              ))}
              <button
                onClick={() => update(d.key, (x) => ({ ...x, ranges: [...x.ranges, { fileId: firstFile.id, from: 1, to: firstFile.pageCount }] }))}
                className="text-sm text-stone-600 underline"
              >
                + نطاق صفحات
              </button>
              <p className="pt-1 text-xs font-medium text-stone-500">المواضيع (اختياري)</p>
              {d.topics.map((t, j) => (
                <RangeRow<TopicDTO>
                  key={j}
                  r={t}
                  files={files}
                  onChange={(nt) => update(d.key, (x) => ({ ...x, topics: x.topics.map((o, k) => (k === j ? nt : o)) }))}
                  onRemove={() => update(d.key, (x) => ({ ...x, topics: x.topics.filter((_, k) => k !== j) }))}
                >
                  <input
                    value={t.title}
                    onChange={(e) => update(d.key, (x) => ({ ...x, topics: x.topics.map((o, k) => (k === j ? { ...o, title: e.target.value } : o)) }))}
                    placeholder="عنوان الموضوع"
                    className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1"
                  />
                </RangeRow>
              ))}
              <button
                onClick={() => {
                  const r = d.ranges[0] ?? { fileId: firstFile.id, from: 1, to: 1 };
                  update(d.key, (x) => ({ ...x, topics: [...x.topics, { title: '', fileId: r.fileId, from: r.from, to: r.from }] }));
                }}
                className="text-sm text-stone-600 underline"
              >
                + موضوع
              </button>
            </div>
          </li>
        ))}
      </ol>
      <Button
        onClick={() => setDrafts((ds) => [...ds, { key: ++keySeq, title: '', ranges: [{ fileId: firstFile.id, from: 1, to: firstFile.pageCount }], topics: [] }])}
      >
        + شابتر جديد
      </Button>
    </Card>
  );
}
