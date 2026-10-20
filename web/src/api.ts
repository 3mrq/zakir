import type {
  AIHealth,
  AnswerInput,
  AskScope,
  AskThreadDTO,
  ChapterDTO,
  ChapterInput,
  FileDTO,
  FileKind,
  GenerateRequest,
  JobDTO,
  MistakeDTO,
  PageDTO,
  PlanDTO,
  PlanSettings,
  QuestionDTO,
  QuestionSetDTO,
  QuizDTO,
  QuizRequest,
  ReviewSubjectDTO,
  Settings,
  StyleProfileDTO,
  SubjectDTO,
  SummaryDTO,
  TodayTaskDTO,
  WeaknessesDTO,
} from '@zakir/shared';

export interface QuizSummary {
  id: number;
  title: string;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  answered: number;
  score: number | null;
}

export interface ContentFile {
  id: number;
  name: string;
  pageCount: number;
  status: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // Only declare JSON for string bodies: Fastify rejects an empty body with content-type JSON,
    // and FormData must set its own multipart boundary.
    const headers = typeof init?.body === 'string' ? { 'content-type': 'application/json' } : undefined;
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new Error('تعذّر الاتصال بالخادم. تأكد أن الأمر npm run dev يعمل.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `خطأ من الخادم (${res.status}).`);
  return body as T;
}

const json = (method: string, data?: unknown): RequestInit => ({ method, body: data === undefined ? undefined : JSON.stringify(data) });

export interface UploadResult {
  name: string;
  ok: boolean;
  duplicate?: boolean;
  fileId?: number;
  error?: string;
}

export const api = {
  aiHealth: () => request<AIHealth>('/api/ai/health'),
  jobs: () => request<JobDTO[]>('/api/jobs'),
  smokeTest: (question: string) => request<JobDTO>('/api/jobs/smoke-test', json('POST', { question })),
  cancelJob: (id: number) => request<{ ok: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  subjects: () => request<SubjectDTO[]>('/api/subjects'),
  subject: (id: number) => request<SubjectDTO>(`/api/subjects/${id}`),
  createSubject: (name: string, doctor: string) => request<SubjectDTO>('/api/subjects', json('POST', { name, doctor })),
  updateSubject: (id: number, name: string, doctor: string) => request<SubjectDTO>(`/api/subjects/${id}`, json('PATCH', { name, doctor })),
  deleteSubject: (id: number) => request<{ ok: boolean }>(`/api/subjects/${id}`, { method: 'DELETE' }),
  addExam: (subjectId: number, title: string, examDate: string | null) =>
    request<SubjectDTO>(`/api/subjects/${subjectId}/exams`, json('POST', { title, examDate })),
  deleteExam: (id: number) => request<{ ok: boolean }>(`/api/exams/${id}`, { method: 'DELETE' }),

  files: (subjectId: number) => request<FileDTO[]>(`/api/subjects/${subjectId}/files`),
  file: (id: number) => request<FileDTO>(`/api/files/${id}`),
  pages: (id: number) => request<PageDTO[]>(`/api/files/${id}/pages`),
  rawUrl: (id: number) => `/api/files/${id}/raw`,
  upload: (subjectId: number, kind: FileKind, files: File[]) => {
    const form = new FormData();
    form.append('kind', kind); // must precede the files
    files.forEach((f) => form.append('file', f, f.name));
    return request<{ results: UploadResult[] }>(`/api/subjects/${subjectId}/files`, { method: 'POST', body: form });
  },
  setFileKind: (id: number, kind: FileKind) => request<FileDTO>(`/api/files/${id}`, json('PATCH', { kind })),
  retryOcr: (id: number) => request<{ queued: number }>(`/api/files/${id}/retry-ocr`, { method: 'POST' }),
  deleteFile: (id: number) => request<{ ok: boolean }>(`/api/files/${id}`, { method: 'DELETE' }),

  jobsFor: (refType: string, refId: number) => request<JobDTO[]>(`/api/jobs?refType=${refType}&refId=${refId}`),
  chapters: (subjectId: number) => request<{ chapters: ChapterDTO[]; files: ContentFile[] }>(`/api/subjects/${subjectId}/chapters`),
  saveChapters: (subjectId: number, chapters: ChapterInput[]) =>
    request<{ chapters: ChapterDTO[]; files: ContentFile[] }>(`/api/subjects/${subjectId}/chapters`, json('PUT', { chapters })),
  autoChapters: (subjectId: number) => request<JobDTO>(`/api/subjects/${subjectId}/chapters/auto`, { method: 'POST' }),
  chapter: (id: number) => request<{ chapter: ChapterDTO; summary: SummaryDTO | null; files: ContentFile[] }>(`/api/chapters/${id}`),
  summarize: (id: number) => request<JobDTO>(`/api/chapters/${id}/summarize`, { method: 'POST' }),
  setExamScope: (examId: number, chapterIds: number[]) => request<{ ok: boolean }>(`/api/exams/${examId}/scope`, json('PUT', { chapterIds })),

  style: (subjectId: number) => request<{ style: StyleProfileDTO | null }>(`/api/subjects/${subjectId}/style`),
  analyzeStyle: (subjectId: number) => request<JobDTO>(`/api/subjects/${subjectId}/style/analyze`, { method: 'POST' }),
  questionSets: (subjectId: number) => request<QuestionSetDTO[]>(`/api/subjects/${subjectId}/question-sets`),
  generate: (subjectId: number, req: GenerateRequest) => request<QuestionSetDTO>(`/api/subjects/${subjectId}/question-sets`, json('POST', req)),
  retryVerify: (setId: number) => request<{ ok: boolean }>(`/api/question-sets/${setId}/verify`, { method: 'POST' }),
  questions: (subjectId: number, setId?: number) => request<QuestionDTO[]>(`/api/subjects/${subjectId}/questions${setId ? `?setId=${setId}` : ''}`),
  reportQuestion: (id: number, note: string) => request<{ ok: boolean }>(`/api/questions/${id}/report`, json('POST', { note })),
  restoreQuestion: (id: number) => request<{ ok: boolean }>(`/api/questions/${id}/restore`, { method: 'POST' }),
  quizzes: (subjectId: number) => request<QuizSummary[]>(`/api/subjects/${subjectId}/quizzes`),
  createQuiz: (subjectId: number, req: QuizRequest) => request<QuizDTO>(`/api/subjects/${subjectId}/quizzes`, json('POST', req)),
  quiz: (id: number) => request<QuizDTO>(`/api/quizzes/${id}`),
  answer: (id: number, questionId: number, answer: AnswerInput) => request<QuizDTO>(`/api/quizzes/${id}/answer`, json('POST', { questionId, ...answer })),
  regrade: (id: number, questionId: number) => request<QuizDTO>(`/api/quizzes/${id}/regrade`, json('POST', { questionId })),
  finishQuiz: (id: number) => request<QuizDTO>(`/api/quizzes/${id}/finish`, { method: 'POST' }),

  settings: () => request<Settings>('/api/settings'),
  saveSettings: (s: Settings) => request<Settings>('/api/settings', json('PUT', s)),
  askThreads: (subjectId: number) => request<Omit<AskThreadDTO, 'asks'>[]>(`/api/subjects/${subjectId}/ask-threads`),
  askThread: (id: number) => request<AskThreadDTO>(`/api/ask-threads/${id}`),
  deleteAskThread: (id: number) => request<{ ok: boolean }>(`/api/ask-threads/${id}`, { method: 'DELETE' }),
  ask: (subjectId: number, question: string, scope: AskScope = {}, threadId?: number) =>
    request<AskThreadDTO>(`/api/subjects/${subjectId}/ask`, json('POST', { question, scope, threadId })),
  retryAsk: (id: number) => request<AskThreadDTO>(`/api/asks/${id}/retry`, { method: 'POST' }),

  reviewToday: () => request<ReviewSubjectDTO[]>('/api/review/today'),
  startReview: (subjectId: number) => request<QuizDTO>(`/api/subjects/${subjectId}/review`, { method: 'POST' }),
  weaknesses: (subjectId: number) => request<WeaknessesDTO>(`/api/subjects/${subjectId}/weaknesses`),
  mistakes: (subjectId: number) => request<MistakeDTO[]>(`/api/subjects/${subjectId}/mistakes`),

  plan: (examId: number) => request<{ settings: PlanSettings | null; plan: PlanDTO | null }>(`/api/exams/${examId}/plan`),
  savePlan: (examId: number, s: PlanSettings) => request<{ settings: PlanSettings; plan: PlanDTO }>(`/api/exams/${examId}/plan`, json('PUT', s)),
  deletePlan: (examId: number) => request<{ ok: boolean }>(`/api/exams/${examId}/plan`, { method: 'DELETE' }),
  setPlanTask: (examId: number, key: string, status: 'pending' | 'done' | 'skipped') =>
    request<PlanDTO>(`/api/exams/${examId}/plan/tasks`, json('POST', { key, status })),
  todayTasks: () => request<TodayTaskDTO[]>('/api/plans/today'),
  updateExam: (examId: number, data: { title?: string; examDate?: string | null }) => request<{ ok: boolean }>(`/api/exams/${examId}`, json('PATCH', data)),
};
