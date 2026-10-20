// One line telling the student what spaced repetition will do with this question next.

import type { CardState } from '@zakir/shared';
import { daysCount, daysUntil, formatDate } from './ui.tsx';

export function whenText(dueOn: string) {
  const d = daysUntil(dueOn);
  if (d <= 0) return 'اليوم';
  if (d === 1) return 'غدًا';
  if (d === 2) return 'بعد يومين';
  return `بعد ${daysCount(d)}${d > 10 ? ` (${formatDate(dueOn)})` : ''}`;
}

export function CardNote({ card }: { card: CardState | null }) {
  if (!card) return null;
  if (card.mastered) return <p className="text-sm text-emerald-700">أتقنت هذا السؤال — خرج من المراجعة حتى تخطئ فيه مرة أخرى.</p>;
  return (
    <p className="text-sm text-stone-600">
      في سجل الأخطاء · الصندوق {card.box} من 5 · المراجعة القادمة {whenText(card.dueOn)}
    </p>
  );
}
