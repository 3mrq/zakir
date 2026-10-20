// Practice hub for a subject: the doctor's style, question generation, question sets, bank and quizzes.

import {
  CONFIDENCE_LABEL,
  DIFFICULTY_LABEL,
  QUESTION_TYPE_LABEL,
  QUESTION_TYPES,
  SET_STATUS_LABEL,
  type ChapterDTO,
  type Difficulty,
  type QuestionDTO,
  type QuestionSetDTO,
  type QuestionType,
  type StyleProfileDTO,
  type SubjectDTO,
} from '@zakir/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, type QuizSummary } from '../api.ts';
import { JobLine, useLatestJob } from '../components/jobs.tsx';
import { QuestionMeta, QuestionReview, ReportButton, Stem } from '../components/question.tsx';
import { RefList } from '../components/RefChip.tsx';
import { Badge, Button, Card, ErrorText, formatDate, inputClass } from '../components/ui.tsx';

function Bar({ label, percent, count }: { label: string; percent: number; count: number }) {
  return (
    <div className="space-y-0.5 text-sm">
      <div className="flex justify-between gap-2">
        <bdi>{label}</bdi>
        <span className="text-stone-500">
          {percent}% ({count})
        </span>
      </div>
      <div className="h-2 rounded-full bg-stone-100">
        <div className="h-2 rounded-full bg-stone-700" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function StyleCard({ subjectId, names }: { subjectId: number; names: Map<number, string> }) {
  const [style, setStyle] = useState<StyleProfileDTO | null>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => api.style(subjectId).then((r) => setStyle(r.style), (e: Error) => setError(e.message)), [subjectId]);
  useEffect(() => void load(), [load]);
  const job = useLatestJob('subject', subjectId, 'analyze_style', load);

  async function analyze() {
    setError(undefined);
    try {
      job.track(await api.analyzeStyle(subjectId));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const tone = { low: 'red', medium: 'amber', high: 'green' } as const;
  const p = style?.profile;

  return (
    <Card
      title="أسلوب الدكتور"
      actions={
        <Button onClick={analyze} disabled={job.active} variant={style ? 'secondary' : 'primary'}>
          {job.active ? 'جارٍ التحليل...' : style ? 'إعادة التحليل' : 'حلّل الاختبارات السابقة'}
        </Button>
      }
    >
      <ErrorText>{error}</ErrorText>
      {(job.active || job.job?.status === 'failed') && <JobLine job={job.job} />}
      {style === null && !job.active && (
        <p className="text-sm text-stone-500">ارفع اختبارات الدكتور السابقة (كـ«اختبار سابق») ثم حلّلها. الأسئلة المولّدة ستتبع أسلوبه.</p>
      )}
      {style && p && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone[style.confidence]}>الثقة: {CONFIDENCE_LABEL[style.confidence]}</Badge>
            <span className="text-sm text-stone-600">{style.confidenceReason}</span>
          </div>
          {style.outdated && (
            <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">تغيّرت ملفات الاختبارات السابقة بعد هذا التحليل. أعد التحليل ليشملها.</p>
          )}
          <p className="text-sm text-stone-600">
            اللغة: <bdi>{p.language}</bdi> · {p.structure}
          </p>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">أنواع الأسئلة</h3>
              {p.types.map((t) => (
                <Bar key={t.type} label={t.type === 'other' ? 'أخرى' : QUESTION_TYPE_LABEL[t.type]} percent={t.percent} count={t.count} />
              ))}
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">التوزيع على الشباترات</h3>
              {p.chapters.map((c, i) => (
                <Bar key={i} label={c.title} percent={c.percent} count={c.count} />
              ))}
            </div>
          </div>
          {p.recurringTopics.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">مواضيع متكررة</h3>
              <ul className="space-y-1 text-sm">
                {p.recurringTopics.map((t, i) => (
                  <li key={i}>
                    <bdi>{t.topic}</bdi> <span className="text-stone-500">({t.count} مرات)</span> <RefList refs={t.refs} names={names} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">أسلوب الصياغة</h3>
            <ul className="list-disc space-y-1 ps-5 text-sm">
              {p.phrasing.map((x, i) => (
                <li key={i} dir="auto">
                  {x}
                </li>
              ))}
            </ul>
          </div>
          <details>
            <summary className="cursor-pointer text-sm font-semibold">أمثلة من اختباراته ({p.examples.length})</summary>
            <ul className="mt-2 space-y-2 text-sm">
              {p.examples.map((e, i) => (
                <li key={i} className="rounded-lg bg-stone-50 p-2">
                  <p dir="auto" className="whitespace-pre-wrap">
                    {e.text}
                  </p>
                  <RefList refs={e.refs} names={names} />
                </li>
              ))}
            </ul>
          </details>
          <p className="text-xs text-stone-400">
            حُلّل {formatDate(style.createdAt)} من: {style.files.map((f) => f.name).join('، ')}
          </p>
        </div>
      )}
    </Card>
  );
}

function GenerateCard({ subjectId, chapters, onCreated }: { subjectId: number; chapters: ChapterDTO[]; onCreated: () => void }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [type, setType] = useState<QuestionType | 'mixed'>('mixed');
  const [difficulty, setDifficulty] = useState<Difficulty | 'mixed'>('mixed');
  const [count, setCount] = useState(10);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await api.generate(subjectId, { chapterIds: selected, type, difficulty, count });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!chapters.length) {
    return (
      <Card title="توليد أسئلة">
        <p className="text-sm text-stone-500">قسّم المادة إلى شباترات أولًا من صفحة المادة.</p>
      </Card>
    );
  }

  return (
    <Card title="توليد أسئلة">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">الشباترات</p>
          <button className="text-xs text-stone-500 underline" onClick={() => setSelected(selected.length === chapters.length ? [] : chapters.map((c) => c.id))}>
            {selected.length === chapters.length ? 'إلغاء الكل' : 'اختيار الكل'}
          </button>
        </div>
        <div className="grid gap-1 sm:grid-cols-2">
          {chapters.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
              <bdi>{c.title}</bdi>
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="space-y-1">
          <span className="block text-stone-600">النوع</span>
          <select value={type} onChange={(e) => setType(e.target.value as QuestionType | 'mixed')} className={inputClass}>
            <option value="mixed">منوّعة (حسب أسلوب الدكتور)</option>
            {QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {QUESTION_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-stone-600">الصعوبة</span>
          <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty | 'mixed')} className={inputClass}>
            <option value="mixed">منوّعة</option>
            {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => (
              <option key={d} value={d}>
                {DIFFICULTY_LABEL[d]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-stone-600">العدد</span>
          <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} className={`${inputClass} w-20`} />
        </label>
        <Button variant="primary" className="py-2" onClick={submit} disabled={busy || !selected.length}>
          ولّد الأسئلة
        </Button>
      </div>
      <p className="text-xs text-stone-500">كل سؤال يُراجَع مقابل صفحات مصدره في استدعاء مستقل، ولا يظهر إلا إذا اجتاز المراجعة.</p>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

function SetRow({ set, chapters, names, onChange }: { set: QuestionSetDTO; chapters: ChapterDTO[]; names: Map<number, string>; onChange: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [questions, setQuestions] = useState<QuestionDTO[]>();
  const [error, setError] = useState<string>();
  const titles = set.chapterIds.map((id) => chapters.find((c) => c.id === id)?.title ?? 'شابتر محذوف');
  const busy = set.status === 'generating' || set.status === 'verifying';
  const tone = { generating: 'blue', verifying: 'blue', ready: 'green', failed: 'red' } as const;

  async function expand() {
    setOpen(!open);
    if (!questions) setQuestions(await api.questions(set.subjectId, set.id));
  }
  async function act(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone[set.status]}>{SET_STATUS_LABEL[set.status]}</Badge>
        <span className="text-sm">
          {set.type === 'mixed' ? 'منوّعة' : QUESTION_TYPE_LABEL[set.type]} · {set.difficulty === 'mixed' ? 'صعوبة منوّعة' : DIFFICULTY_LABEL[set.difficulty]} ·{' '}
          <bdi>{titles.join('، ')}</bdi>
        </span>
        {set.usedStyle && <Badge tone="gray">بأسلوب الدكتور</Badge>}
      </div>
      {set.status === 'ready' && (
        <p className="text-sm text-stone-600">
          طُلب {set.requested} · اجتاز التحقق {set.counts.active}
          {set.counts.rejected > 0 && ` · استُبعد ${set.counts.rejected} لعدم دعم المصدر`}
          {set.counts.reported > 0 && ` · مبلّغ عنه ${set.counts.reported}`}
        </p>
      )}
      {set.error && <p className="text-sm text-red-700">{set.error}</p>}
      <div className="flex flex-wrap gap-2">
        {set.counts.active > 0 && (
          <Button variant="primary" onClick={() => act(async () => navigate(`/quizzes/${(await api.createQuiz(set.subjectId, { setId: set.id })).id}`))}>
            ابدأ اختبارًا
          </Button>
        )}
        {!busy && set.counts.active + set.counts.rejected + set.counts.reported > 0 && <Button onClick={expand}>{open ? 'إخفاء الأسئلة' : 'عرض الأسئلة'}</Button>}
        {set.status === 'failed' && set.counts.pending > 0 && <Button onClick={() => act(async () => (await api.retryVerify(set.id), onChange()))}>أعد التحقق</Button>}
      </div>
      <ErrorText>{error}</ErrorText>
      {open && questions && (
        <ol className="space-y-4 border-s-2 border-stone-200 ps-4">
          {questions.map((q, i) => (
            <li key={q.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-stone-400">{i + 1}.</span>
                <QuestionMeta q={q} />
                {q.status === 'rejected' && <Badge tone="red">مستبعد</Badge>}
                {q.status === 'reported' && <Badge tone="amber">مبلّغ عنه</Badge>}
              </div>
              {q.statusNote && <p className="text-sm text-red-700">السبب: {q.statusNote}</p>}
              <Stem text={q.stem} />
              <QuestionReview q={q} names={names} />
              {q.status === 'active' && <ReportButton q={q} onDone={onChange} />}
              {q.status === 'reported' && (
                <button className="text-xs text-stone-500 underline" onClick={() => act(async () => (await api.restoreQuestion(q.id), setQuestions(await api.questions(set.subjectId, set.id)), onChange()))}>
                  البلاغ غير صحيح — أعد السؤال
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function BankQuizCard({ subjectId, chapters }: { subjectId: number; chapters: ChapterDTO[] }) {
  const navigate = useNavigate();
  const [chapterIds, setChapterIds] = useState<number[]>([]);
  const [count, setCount] = useState(10);
  const [timed, setTimed] = useState(false);
  const [minutes, setMinutes] = useState(20);
  const [error, setError] = useState<string>();

  async function start() {
    setError(undefined);
    try {
      const q = await api.createQuiz(subjectId, { chapterIds, count, timeLimitMin: timed ? minutes : null });
      navigate(`/quizzes/${q.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card title="اختبار من بنك الأسئلة">
      <p className="text-sm text-stone-500">يختار من الأسئلة المُتحقق منها، ويقدّم الأقل تدريبًا أولًا. اترك الشباترات فارغة لاختيار الكل.</p>
      <div className="grid gap-1 sm:grid-cols-2">
        {chapters.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={chapterIds.includes(c.id)} onChange={() => setChapterIds((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))} />
            <bdi>{c.title}</bdi>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          عدد الأسئلة
          <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))} className={`${inputClass} w-20 py-1`} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} />
          بوقت
        </label>
        {timed && (
          <label className="flex items-center gap-2">
            <input type="number" min={1} max={300} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={`${inputClass} w-20 py-1`} />
            دقيقة
          </label>
        )}
        <Button variant="primary" onClick={start}>
          ابدأ
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

export function PracticePage() {
  const subjectId = Number(useParams().id);
  const [subject, setSubject] = useState<SubjectDTO>();
  const [chapters, setChapters] = useState<ChapterDTO[]>([]);
  const [names, setNames] = useState(new Map<number, string>());
  const [sets, setSets] = useState<QuestionSetDTO[]>([]);
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [s, c, f, qs, qz] = await Promise.all([api.subject(subjectId), api.chapters(subjectId), api.files(subjectId), api.questionSets(subjectId), api.quizzes(subjectId)]);
      setSubject(s);
      setChapters(c.chapters);
      setNames(new Map(f.map((x) => [x.id, x.name])));
      setSets(qs);
      setQuizzes(qz);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [subjectId]);
  useEffect(() => void load(), [load]);

  // Poll while a set is being generated or verified.
  const busy = sets.some((s) => s.status === 'generating' || s.status === 'verifying');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => api.questionSets(subjectId).then(setSets, () => {}), 2500);
    return () => clearInterval(t);
  }, [busy, subjectId]);

  if (!subject) return <main className="mx-auto max-w-5xl px-4 py-8">{error ? <ErrorText>{error}</ErrorText> : <p className="text-stone-500">جارٍ التحميل...</p>}</main>;

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <div>
        <Link to={`/subjects/${subjectId}`} className="text-sm text-stone-500 hover:underline">
          ‹ {subject.name}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">التدريب والأسئلة</h1>
          <Link to={`/subjects/${subjectId}/mistakes`} className="text-sm text-stone-600 underline">
            نقاط الضعف وسجل الأخطاء
          </Link>
        </div>
      </div>
      <StyleCard subjectId={subjectId} names={names} />
      <GenerateCard subjectId={subjectId} chapters={chapters} onCreated={load} />
      <Card title={`مجموعات الأسئلة (${sets.length})`}>
        {!sets.length && <p className="text-sm text-stone-500">لم تُولَّد أسئلة بعد.</p>}
        <ul className="divide-y divide-stone-100">
          {sets.map((s) => (
            <SetRow key={s.id} set={s} chapters={chapters} names={names} onChange={load} />
          ))}
        </ul>
      </Card>
      {sets.some((s) => s.counts.active > 0) && <BankQuizCard subjectId={subjectId} chapters={chapters} />}
      {quizzes.length > 0 && (
        <Card title="اختباراتك السابقة">
          <ul className="divide-y divide-stone-100 text-sm">
            {quizzes.map((q) => (
              <li key={q.id} className="flex items-center justify-between py-2">
                <Link to={`/quizzes/${q.id}`} className="hover:underline">
                  {q.title} · {formatDate(q.startedAt)}
                </Link>
                <span className="text-stone-600">
                  {q.finishedAt ? (q.score === null ? 'جارٍ التصحيح' : `${Math.round(q.score * 100)}%`) : `لم ينتهِ (${q.answered}/${q.total})`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
