import { FILE_KIND_LABEL, FILE_STATUS_LABEL, type ChapterDTO, type FileDTO, type FileKind, type FileStatus, type SubjectDTO } from '@zakir/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, type ContentFile, type UploadResult } from '../api.ts';
import { ChaptersCard } from '../components/chapters.tsx';
import { Badge, Button, Card, daysUntil, ErrorText, formatDate, inputClass } from '../components/ui.tsx';

const STATUS_TONE: Record<FileStatus, 'green' | 'blue' | 'amber' | 'red'> = {
  processing: 'blue',
  ocr: 'blue',
  ready: 'green',
  partial: 'amber',
  failed: 'red',
};

export function SubjectPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const [subject, setSubject] = useState<SubjectDTO>();
  const [files, setFiles] = useState<FileDTO[]>([]);
  const [chapters, setChapters] = useState<ChapterDTO[]>([]);
  const [contentFiles, setContentFiles] = useState<ContentFile[]>([]);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [s, f, c] = await Promise.all([api.subject(id), api.files(id), api.chapters(id)]);
      setSubject(s);
      setFiles(f);
      setChapters(c.chapters);
      setContentFiles(c.files);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => void load(), [load]);

  // Poll while files are being processed.
  const busy = files.some((f) => f.status === 'processing' || f.status === 'ocr');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => api.files(id).then(setFiles, () => {}), 2000);
    return () => {
      clearInterval(t);
      void load(); // processing finished → page counts for the chapter editor changed
    };
  }, [busy, id, load]);

  if (error && !subject) return <main className="mx-auto max-w-5xl px-4 py-8"><ErrorText>{error}</ErrorText></main>;
  if (!subject) return <main className="mx-auto max-w-5xl px-4 py-8 text-stone-500">جارٍ التحميل...</main>;

  async function removeSubject() {
    if (!confirm(`حذف مادة «${subject!.name}» وكل ملفاتها نهائيًا؟`)) return;
    await api.deleteSubject(id);
    navigate('/');
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <SubjectHeader subject={subject} onSaved={setSubject} onDelete={removeSubject} />
      <div className="grid gap-6 md:grid-cols-[1fr_2fr]">
        <ExamsCard subject={subject} chapters={chapters} onChange={setSubject} />
        <UploadCard subjectId={id} onUploaded={load} />
      </div>
      <ChaptersCard subjectId={id} chapters={chapters} files={contentFiles} onChange={load} />
      <FilesCard files={files} onChange={load} />
    </main>
  );
}

function SubjectHeader({ subject, onSaved, onDelete }: { subject: SubjectDTO; onSaved: (s: SubjectDTO) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(subject.name);
  const [doctor, setDoctor] = useState(subject.doctor ?? '');
  const [error, setError] = useState<string>();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      onSaved(await api.updateSubject(subject.id, name, doctor));
      setEditing(false);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} text-lg`} />
        <input value={doctor} onChange={(e) => setDoctor(e.target.value)} placeholder="الدكتور" className={inputClass} />
        <Button variant="primary">حفظ</Button>
        <Button type="button" onClick={() => setEditing(false)}>
          إلغاء
        </Button>
        <ErrorText>{error}</ErrorText>
      </form>
    );
  }
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <Link to="/" className="text-sm text-stone-500 hover:underline">
          المواد ›
        </Link>
        <h1 className="text-2xl font-bold">{subject.name}</h1>
        {subject.doctor && <p className="text-stone-600">{subject.doctor}</p>}
      </div>
      <div className="flex gap-2">
        <Link to={`/subjects/${subject.id}/practice`} className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700">
          التدريب والأسئلة
        </Link>
        <Link to={`/subjects/${subject.id}/ask`} className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-100">
          اسأل المادة
        </Link>
        <Link to={`/subjects/${subject.id}/mistakes`} className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-100">
          نقاط الضعف
        </Link>
        <Button onClick={() => setEditing(true)}>تعديل</Button>
        <Button variant="danger" onClick={onDelete}>
          حذف المادة
        </Button>
      </div>
    </div>
  );
}

function ExamScope({ examId, selected, chapters, onChange }: { examId: number; selected: number[]; chapters: ChapterDTO[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  if (!chapters.length) return null;
  const label = selected.length === 0 ? 'لم يُحدَّد النطاق' : selected.length === chapters.length ? 'كل الشباترات' : `${selected.length} من ${chapters.length} شباترات`;

  async function toggle(chapterId: number) {
    const next = selected.includes(chapterId) ? selected.filter((x) => x !== chapterId) : [...selected, chapterId];
    try {
      await api.setExamScope(examId, next);
      setError(undefined);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="ps-2 text-xs">
      <button onClick={() => setOpen(!open)} className="text-stone-500 underline">
        النطاق: {label}
      </button>
      {open && (
        <ul className="mt-1 space-y-1">
          {chapters.map((c) => (
            <li key={c.id}>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
                <bdi>{c.title}</bdi>
              </label>
            </li>
          ))}
        </ul>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function ExamsCard({ subject, chapters, onChange }: { subject: SubjectDTO; chapters: ChapterDTO[]; onChange: (s: SubjectDTO) => void }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string>();

  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      onChange(await api.addExam(subject.id, title, date || null));
      setTitle('');
      setDate('');
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(examId: number) {
    await api.deleteExam(examId);
    onChange(await api.subject(subject.id));
  }

  return (
    <Card title="الاختبارات">
      {!subject.exams.length && <p className="text-sm text-stone-500">لم تُضف اختبارات بعد.</p>}
      <ul className="space-y-2">
        {subject.exams.map((ex) => {
          const days = ex.examDate ? daysUntil(ex.examDate) : null;
          return (
            <li key={ex.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-sm">
              <div>
                <span className="font-medium">{ex.title}</span>
                {ex.examDate && (
                  <span className="text-stone-500">
                    {' '}
                    · {formatDate(ex.examDate)}
                    {days !== null && days >= 0 && ` (بعد ${days} يوم)`}
                    {days !== null && days < 0 && ' (انتهى)'}
                  </span>
                )}
              </div>
              <button onClick={() => remove(ex.id)} className="text-stone-400 hover:text-red-700" aria-label="حذف الاختبار">
                ✕
              </button>
              </div>
              <ExamScope examId={ex.id} selected={ex.chapterIds} chapters={chapters} onChange={async () => onChange(await api.subject(subject.id))} />
              <div className="flex flex-wrap items-center gap-3 ps-2 text-xs">
                <Link to={`/exams/${ex.id}/plan`} className="font-medium text-stone-800 underline">
                  خطة المذاكرة
                </Link>
                <label className="flex items-center gap-1 text-stone-500">
                  التاريخ:
                  <input
                    type="date"
                    value={ex.examDate ?? ''}
                    onChange={async (e) => {
                      await api.updateExam(ex.id, { examDate: e.target.value || null });
                      onChange(await api.subject(subject.id));
                    }}
                    className="rounded border border-stone-200 px-1"
                  />
                </label>
              </div>
            </li>
          );
        })}
      </ul>
      <form onSubmit={add} className="space-y-2 border-t border-stone-100 pt-3">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثل: الاختبار النهائي" className={`${inputClass} w-full`} />
        <div className="flex gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${inputClass} min-w-0 flex-1`} />
          <Button>إضافة</Button>
        </div>
        {!chapters.length && <p className="text-xs text-stone-500">بعد تقسيم الشباترات يمكنك تحديد الشباترات الداخلة في كل اختبار.</p>}
        <ErrorText>{error}</ErrorText>
      </form>
    </Card>
  );
}

function UploadCard({ subjectId, onUploaded }: { subjectId: number; onUploaded: () => void }) {
  const [kind, setKind] = useState<FileKind>('content');
  const [results, setResults] = useState<UploadResult[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  async function send(list: FileList | File[]) {
    const files = [...list];
    if (!files.length) return;
    setUploading(true);
    setError(undefined);
    try {
      const { results } = await api.upload(subjectId, kind, files);
      setResults(results);
      onUploaded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <Card title="رفع ملفات">
      <div className="flex gap-2 text-sm">
        {(Object.keys(FILE_KIND_LABEL) as FileKind[]).map((k) => (
          <label key={k} className={`cursor-pointer rounded-lg border px-3 py-1.5 ${kind === k ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-300'}`}>
            <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
            {FILE_KIND_LABEL[k]}
          </label>
        ))}
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void send(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center ${dragging ? 'border-stone-700 bg-stone-100' : 'border-stone-300'}`}
      >
        <p className="font-medium">{uploading ? 'جارٍ الرفع...' : `اسحب الملفات هنا أو اضغط للاختيار — تُرفع كـ«${FILE_KIND_LABEL[kind]}»`}</p>
        <p className="text-sm text-stone-500">PDF أو صور (PNG، JPG، WEBP). السلايدات: حوّلها إلى PDF أولًا.</p>
        <input ref={input} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" className="hidden" onChange={(e) => e.target.files && send(e.target.files)} />
      </div>
      <ErrorText>{error}</ErrorText>
      {results.length > 0 && (
        <ul className="space-y-1 text-sm">
          {results.map((r, i) => (
            <li key={i} className={r.ok ? 'text-stone-700' : 'text-red-700'}>
              {r.ok ? (r.duplicate ? `«${r.name}» مرفوع سابقًا — لن يُعالَج مرة أخرى.` : `«${r.name}» رُفع وبدأت معالجته.`) : r.error}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function FilesCard({ files, onChange }: { files: FileDTO[]; onChange: () => void }) {
  const [error, setError] = useState<string>();
  const act = (fn: () => Promise<unknown>) => async () => {
    setError(undefined);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Card title={`الملفات (${files.length})`}>
      <ErrorText>{error}</ErrorText>
      {!files.length && <p className="text-sm text-stone-500">لا توجد ملفات بعد.</p>}
      <ul className="divide-y divide-stone-100">
        {files.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
            <div className="min-w-0 flex-1">
              <Link to={`/files/${f.id}`} className="font-medium hover:underline">
                <bdi>{f.name}</bdi>
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                <Badge tone={STATUS_TONE[f.status]}>{FILE_STATUS_LABEL[f.status]}</Badge>
                <span>{FILE_KIND_LABEL[f.kind]}</span>
                {f.pageCount != null && <span>{f.pageCount} صفحة</span>}
                {f.pages.direct > 0 && <span>نص مباشر: {f.pages.direct}</span>}
                {f.pages.ai > 0 && <span>قُرئت بالذكاء الاصطناعي: {f.pages.ai}</span>}
                {f.pages.pending > 0 && <span>بانتظار القراءة: {f.pages.pending}</span>}
                {f.pages.failed > 0 && <span className="text-red-700">فشلت قراءتها: {f.pages.failed}</span>}
              </div>
              {f.error && <p className="mt-1 text-sm text-red-700">{f.error}</p>}
            </div>
            <div className="flex gap-2">
              {f.pages.failed > 0 && <Button onClick={act(() => api.retryOcr(f.id))}>إعادة قراءة الصفحات</Button>}
              <select
                value={f.kind}
                onChange={(e) => act(() => api.setFileKind(f.id, e.target.value as FileKind))()}
                className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm"
                aria-label="نوع الملف"
              >
                {(Object.keys(FILE_KIND_LABEL) as FileKind[]).map((k) => (
                  <option key={k} value={k}>
                    {FILE_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <Button variant="danger" onClick={() => confirm(`حذف «${f.name}»؟`) && act(() => api.deleteFile(f.id))()}>
                حذف
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
