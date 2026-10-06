import { Calendar, CheckCircle2, ExternalLink, ListTodo } from 'lucide-react';
import { Button } from '../Button';
import { cn } from '../../utils/cn';
import type { TaskAction, TaskCard as TaskCardData, TaskPriority } from '../../types/assistant';

interface TaskCardProps {
  card: TaskCardData;
  /** Disables the action buttons while a card action is in flight. */
  disabled?: boolean;
  onAction?: (action: TaskAction) => void;
}

const priorityStyles: Record<TaskPriority, string> = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-amber-100 text-amber-800',
  high: 'bg-red-100 text-red-700',
};

const priorityLabels: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export function TaskCard({ card, disabled, onAction }: TaskCardProps) {
  const dueLine = card.due ?? card.dueDate;
  const databaseTitle = card.database?.title;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3.5 shadow-soft">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900">{card.title}</p>
        {card.priority ? (
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              priorityStyles[card.priority]
            )}
          >
            {priorityLabels[card.priority]}
          </span>
        ) : null}
      </div>

      {dueLine ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
          <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {dueLine}
        </p>
      ) : null}

      {databaseTitle ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
          <ListTodo className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {databaseTitle}
        </p>
      ) : null}

      {card.notionUrl ? (
        <a
          href={card.notionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          View in Notion
        </a>
      ) : null}

      {card.actions.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {card.actions.includes('create') ? (
            <Button size="sm" disabled={disabled} onClick={() => onAction?.('create')}>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Create Task
            </Button>
          ) : null}
          {card.actions.includes('edit') ? (
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onAction?.('edit')}>
              Edit
            </Button>
          ) : null}
          {card.actions.includes('cancel') ? (
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onAction?.('cancel')}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
