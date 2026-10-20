import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Layout } from './components/Layout.tsx';
import './index.css';
import { AskPage } from './pages/AskPage.tsx';
import { ChapterPage } from './pages/ChapterPage.tsx';
import { EnginePage } from './pages/EnginePage.tsx';
import { FilePage } from './pages/FilePage.tsx';
import { InsightsPage } from './pages/InsightsPage.tsx';
import { PracticePage } from './pages/PracticePage.tsx';
import { PlanPage } from './pages/PlanPage.tsx';
import { QuizPage } from './pages/QuizPage.tsx';
import { ReviewPage } from './pages/ReviewPage.tsx';
import { SubjectPage } from './pages/SubjectPage.tsx';
import { SubjectsPage } from './pages/SubjectsPage.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<SubjectsPage />} />
          <Route path="subjects/:id" element={<SubjectPage />} />
          <Route path="files/:id" element={<FilePage />} />
          <Route path="chapters/:id" element={<ChapterPage />} />
          <Route path="subjects/:id/practice" element={<PracticePage />} />
          <Route path="quizzes/:id" element={<QuizPage />} />
          <Route path="subjects/:id/ask" element={<AskPage />} />
          <Route path="subjects/:id/mistakes" element={<InsightsPage />} />
          <Route path="review" element={<ReviewPage />} />
          <Route path="exams/:id/plan" element={<PlanPage />} />
          <Route path="engine" element={<EnginePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
