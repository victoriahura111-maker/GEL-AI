import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

export type TaskStatTone = 'default' | 'info' | 'warn' | 'danger' | 'success';

const TONE_STYLES: Record<TaskStatTone, { icon: string; value: string }> = {
  default: { icon: 'bg-gray-100 text-gray-600', value: 'text-gray-900' },
  info: { icon: 'bg-blue-100 text-blue-700', value: 'text-blue-700' },
  warn: { icon: 'bg-amber-100 text-amber-700', value: 'text-amber-700' },
  danger: { icon: 'bg-red-100 text-red-700', value: 'text-red-700' },
  success: { icon: 'bg-green-100 text-green-700', value: 'text-green-700' },
};

const CARD_STYLES =
  'rounded-xl border border-gray-200 bg-white shadow-card flex items-center gap-3 px-4 py-4';

interface TaskStatCardProps {
  label: string;
  count: number;
  icon: LucideIcon;
  tone?: TaskStatTone;
  /** Marks the card as the active section filter. */
  active?: boolean;
  onClick?: () => void;
}

/**
 * One dashboard summary tile, e.g. "Today's Tasks — 3". With `onClick` the tile
 * becomes a keyboard-accessible button that scrolls/filters to its section.
 */
export function TaskStatCard({
  label,
  count,
  icon: Icon,
  tone = 'default',
  active = false,
  onClick,
}: TaskStatCardProps) {
  const styles = TONE_STYLES[tone];

  const content = (
    <>
      <span className={cn('flex h-10 w-10 items-center justify-center rounded-lg', styles.icon)}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-gray-500">{label}</span>
        <span className={cn('block text-2xl font-semibold', styles.value)}>{count}</span>
      </span>
    </>
  );

  if (!onClick) {
    return <div className={CARD_STYLES}>{content}</div>;
  }

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        CARD_STYLES,
        'text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        active && 'ring-2 ring-brand-500'
      )}
    >
      {content}
    </button>
  );
}
