import { useState } from 'react';
import { AlertCircle, CalendarClock, Check, Clock, PauseCircle, X } from 'lucide-react';
import { Button } from '../Button';
import type { FollowUpActionId, FollowUpCard as FollowUpCardData } from '../../types/assistant';

interface FollowUpCardProps {
  card: FollowUpCardData;
  /** Disables the action buttons while a card action is in flight. */
  disabled?: boolean;
  /**
   * Reports a chosen action. Direct buttons omit `value`; the inline forms pass
   * the typed reason (for `blocked`) or the new deadline (for the reschedule
   * actions) as `value`.
   */
  onAction?: (action: FollowUpActionId, value?: string) => void;
}

/** Button labels for every follow-up action id. */
const ACTION_LABELS: Record<FollowUpActionId, string> = {
  completed: 'Completed',
  in_progress: 'In progress',
  blocked: 'Blocked',
  need_more_time: 'Need more time',
  mark_completed: 'Mark completed',
  continue_working: 'Continue working',
  move_deadline: 'Move deadline',
};

/** Which inline form (if any) a clicked action reveals. */
function inlineFormFor(action: FollowUpActionId): 'reason' | 'deadline' | null {
  if (action === 'blocked') return 'reason';
  if (action === 'need_more_time' || action === 'move_deadline') return 'deadline';
  return null;
}

/**
 * Phase 15 — renders an interactive follow-up prompt.
 *
 * Direct actions (`completed`, `in_progress`, `mark_completed`,
 * `continue_working`) are posted immediately. **Blocked** reveals an inline
 * reason textarea and **Need more time / Move deadline** reveal an inline
 * date-time input; both post their richer action on submit. The component is
 * presentational — the parent maps the reported action to the action endpoint.
 */
export function FollowUpCard({ card, disabled, onAction }: FollowUpCardProps) {
  const [active, setActive] = useState<FollowUpActionId | null>(null);
  const [reason, setReason] = useState('');
  const [deadline, setDeadline] = useState('');

  const isOverdue = card.kind === 'overdue';
  const form = active ? inlineFormFor(active) : null;

  const handleClick = (action: FollowUpActionId) => {
    if (disabled) return;
    const target = inlineFormFor(action);
    if (target) {
      setActive(action);
      return;
    }
    onAction?.(action);
  };

  const submitReason = () => {
    const value = reason.trim();
    if (!value || disabled) return;
    onAction?.('blocked', value);
  };

  const submitDeadline = () => {
    const value = deadline.trim();
    if (!value || disabled) return;
    onAction?.(active ?? 'move_deadline', value);
  };

  return (
    <div
      className={
        isOverdue
          ? 'rounded-xl border border-amber-200 bg-amber-50 p-3.5 shadow-soft'
          : 'rounded-xl border border-gray-200 bg-white p-3.5 shadow-soft'
      }
    >
      <div className="flex items-start gap-2">
        {isOverdue ? (
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        ) : (
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{card.prompt}</p>
          <p className="mt-1 text-xs text-gray-500">
            Task: <span className="font-medium text-gray-700">{card.taskTitle}</span> · Due{' '}
            {card.dueLabel}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {card.actions.map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === 'move_deadline' ? 'primary' : 'secondary'}
            disabled={disabled}
            onClick={() => handleClick(action)}
          >
            {action === 'completed' || action === 'mark_completed' ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : null}
            {action === 'blocked' ? (
              <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
            ) : null}
            {action === 'need_more_time' || action === 'move_deadline' ? (
              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
            ) : null}
            {ACTION_LABELS[action]}
          </Button>
        ))}
      </div>

      {form === 'reason' ? (
        <div className="mt-3 space-y-2">
          <textarea
            aria-label="Blocking reason"
            placeholder="What is blocking you?"
            rows={2}
            value={reason}
            disabled={disabled}
            onChange={(event) => setReason(event.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={disabled || reason.trim().length === 0} onClick={submitReason}>
              Send
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setActive(null)}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {form === 'deadline' ? (
        <div className="mt-3 space-y-2">
          <input
            type="datetime-local"
            aria-label="New deadline"
            value={deadline}
            disabled={disabled}
            onChange={(event) => setDeadline(event.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={disabled || deadline.trim().length === 0} onClick={submitDeadline}>
              Send
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setActive(null)}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
