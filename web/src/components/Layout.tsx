import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { api } from '../api.ts';

const link = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-200'}`;

export function Layout() {
  const { pathname } = useLocation();
  const [due, setDue] = useState(0);
  // Refresh the due count on every navigation (answers in a review change it).
  useEffect(() => {
    Promise.all([api.reviewToday(), api.todayTasks()]).then(
      ([r, t]) => setDue(r.reduce((n, s) => n + s.due, 0) + t.filter((x) => x.status === 'pending' && x.kind !== 'review').length),
      () => {},
    );
  }, [pathname]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <NavLink to="/" className="text-xl font-bold">
            ذاكِر
          </NavLink>
          <nav className="flex gap-1">
            <NavLink to="/" end className={link}>
              المواد
            </NavLink>
            <NavLink to="/review" className={link}>
              اليوم
              {due > 0 && <span className="ms-1.5 rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-stone-900">{due}</span>}
            </NavLink>
            <NavLink to="/engine" className={link}>
              المحرّك والمهام
            </NavLink>
          </nav>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
