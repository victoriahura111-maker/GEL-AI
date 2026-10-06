import { ListTodo, X } from 'lucide-react';
import { Button } from '../Button';
import type {
  TaskSelectCandidate,
  TaskSelectCard as TaskSelectCardData,
} from '../../types/assistant';

interface TaskSelectCardProps {
  card: TaskSelectCardData;
  /** Disables the candidate buttons while a card action is in flight. */
  disabled?: boolean;
  onSelect?: (candidate: TaskSelectCandidate) => void;
  onCancel?: () => void;
}

/**
 * Phase 11 — the disambiguation card. Lists the candidate tasks the identifier
 * could refer to; picking one confirms the carried change for that task.
 */
export function TaskSelectCard({ card, disabled, onSelect, onCancel }: TaskSelectCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3.5 shadow-soft">
      <p className="text-sm font-semibold text-gray-900">{card.prompt}</p>

      <div className="mt-3 flex flex-col gap-2">
        {card.candidates.map((candidate) => (
          <Button
            key={candidate.taskId}
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => onSelect?.(candidate)}
          >
            <ListTodo className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="flex flex-col items-start">
              <span>{candidate.title}</span>
              {candidate.dueDate || candidate.database ? (
                <span className="text-[11px] font-normal text-gray-500">
                  {[candidate.dueDate, candidate.database].filter(Boolean).join(' · ')}
                </span>
              ) : null}
            </span>
          </Button>
        ))}
      </div>

      {card.actions.includes('cancel') ? (
        <div className="mt-3">
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onCancel?.()}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}
