import type { AIHealth } from '@zakir/shared';

export function HealthCard({ health, error, onRecheck }: { health?: AIHealth; error?: string; onRecheck: () => void }) {
  const ok = health?.code === 'ok';
  const tone = !health && !error ? 'border-stone-200 bg-white' : ok ? 'border-emerald-200 bg-emerald-50' : 'border-amber-300 bg-amber-50';
  return (
    <section className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-semibold">محرّك الذكاء الاصطناعي</h2>
          {!health && !error && <p className="text-stone-500">جارٍ الفحص...</p>}
          {error && <p className="text-red-700">{error}</p>}
          {health && <p>{health.message}</p>}
          {health?.fix && (
            <p className="text-sm">
              <span className="font-semibold">الحل: </span>
              <bdi>{health.fix}</bdi>
            </p>
          )}
        </div>
        <button onClick={onRecheck} className="shrink-0 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm hover:bg-stone-100">
          إعادة الفحص
        </button>
      </div>
    </section>
  );
}
