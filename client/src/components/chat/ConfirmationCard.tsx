import { Check, X } from 'lucide-react';
import { Button } from '../Button';
import type {
  ConfirmationAction,
  ConfirmationCard as ConfirmationCardData,
} from '../../types/assistant';

interface ConfirmationCardProps {
  card: ConfirmationCardData;
  /** Disables the action buttons while a card action is in flight. */
  disabled?: boolean;
  /** `databaseId` is set when the user picks a candidate database. */
  onAction?: (action: ConfirmationAction, databaseId?: string) => void;
}

export function ConfirmationCard({ card, disabled, onAction }: ConfirmationCardProps) {
  const candidates = card.candidates ?? [];

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3.5 shadow-soft">
      <p className="text-sm font-semibold text-gray-900">{card.prompt}</p>

      {candidates.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {candidates.map((candidate) => (
            <Button
              key={candidate.databaseId}
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => onAction?.('confirm', candidate.databaseId)}
            >
              {candidate.title}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {card.actions.includes('confirm') && candidates.length === 0 ? (
          <Button size="sm" disabled={disabled} onClick={() => onAction?.('confirm')}>
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Yes
          </Button>
        ) : null}
        {card.actions.includes('cancel') ? (
          <Button
            size="sm"
            variant={candidates.length > 0 ? 'ghost' : 'secondary'}
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
