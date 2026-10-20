// Small shared UI pieces.

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-stone-200 bg-white p-4">
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3">
          {title && <h2 className="font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const styles = {
    primary: 'bg-stone-900 text-white hover:bg-stone-700 disabled:bg-stone-400',
    secondary: 'border border-stone-300 bg-white hover:bg-stone-100 disabled:text-stone-400',
    danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
  }[variant];
  return <button className={`rounded-lg px-3 py-1.5 text-sm font-medium ${styles} ${className}`} {...props} />;
}

export const inputClass = 'rounded-lg border border-stone-300 bg-white px-3 py-2 focus:border-stone-500 focus:outline-none';

export function ErrorText({ children }: { children?: ReactNode }) {
  return children ? <p className="text-sm text-red-700">{children}</p> : null;
}

export function Badge({ tone, children }: { tone: 'green' | 'blue' | 'amber' | 'red' | 'gray'; children: ReactNode }) {
  const t = {
    green: 'bg-emerald-100 text-emerald-800',
    blue: 'bg-sky-100 text-sky-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
    gray: 'bg-stone-200 text-stone-700',
  }[tone];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}

export function formatDate(iso: string | null) {
  if (!iso) return '';
  return new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('ar-SA-u-ca-gregory', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Arabic count agreement: سؤال واحد / سؤالان / 3 أسئلة / 11 سؤالًا. */
export function questionsCount(n: number) {
  if (n === 0) return 'لا أسئلة';
  if (n === 1) return 'سؤال واحد';
  if (n === 2) return 'سؤالان';
  if (n <= 10) return `${n} أسئلة`;
  return `${n} سؤالًا`;
}

/** Arabic day count: يوم / يومان / 3 أيام / 14 يومًا. */
export function daysCount(n: number) {
  if (n === 1) return 'يوم';
  if (n === 2) return 'يومان';
  if (n <= 10) return `${n} أيام`;
  return `${n} يومًا`;
}

export function daysUntil(date: string) {
  const ms = new Date(`${date}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime();
  return Math.round(ms / 86_400_000);
}
