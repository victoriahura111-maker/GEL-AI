import { ArrowRightCircle, Check, X } from 'lucide-react';
import { Button } from '../Button';
import type { TaskUpdateAction, TaskUpdateCard as TaskUpdateCardData } from '../../types/assistant';

interface TaskUpdateCardProps {
  card: TaskUpdateCardData;
  /** Disables the action buttons while a card action is in flight. */
  disabled?: boolean;
  onAction?: (action: TaskUpdateAction) => void;
}

/**
 * Phase 11 — renders a proposed task change with Confirm / Cancel. Confirming
 * posts the card's structured `{ taskId, changes }` to the action endpoint; the
 * assistant never mutates data without this explicit confirmation.
 */
export function TaskUpdateCard({ card, disabled, onAction }: TaskUpdateCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3.5 shadow-soft">
      <div className="flex items-start gap-2">
        <ArrowRightCircle className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{card.change}</p>
          <p className="mt-1 text-xs text-gray-500">
            Target task: <span className="font-medium text-gray-700">{card.targetTask}</span>
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {card.actions.includes('confirm') ? (
          <Button size="sm" disabled={disabled} onClick={() => onAction?.('confirm')}>
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Confirm
          </Button>
        ) : null}
        {card.actions.includes('cancel') ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => onAction?.('cancel')}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}
