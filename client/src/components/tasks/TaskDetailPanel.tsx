import { useEffect, useId, useRef } from 'react';
import { ExternalLink, X } from 'lucide-react';
import type { Task } from '../../services/tasks';
import { Button } from '../Button';
import { TaskPriorityBadge, TaskStatusBadge } from './TaskBadges';
import { formatTaskDue, formatTimestamp } from './format';

interface TaskDetailPanelProps {
  task: Task;
  timeZone: string;
  onClose: () => void;
}

/** One labelled detail row (renders nothing when the value is empty). */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="text-sm text-gray-800">{children}</dd>
    </div>
  );
}

/**
 * A responsive slide-over drawer showing one task in full. Accessible: it is a
 * labelled modal dialog, closes on Escape or a backdrop click, and moves focus
 * to the close button on open.
 */
export function TaskDetailPanel({ task, timeZone, onClose }: TaskDetailPanelProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const due = formatTaskDue(task, timeZone);
  const created = formatTimestamp(task.created_at, timeZone);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="presentation">
      <div
        className="absolute inset-0 bg-gray-900/40"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-xl sm:max-w-lg"
      >
        <header className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-lg font-semibold text-gray-900">
              {task.title}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <TaskStatusBadge status={task.status} />
              <TaskPriorityBadge priority={task.priority} />
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close task details"
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <dl className="flex flex-1 flex-col gap-4 px-5 py-4">
          <DetailRow label="Description">
            {task.description ? (
              <p className="whitespace-pre-wrap">{task.description}</p>
            ) : (
              <span className="text-gray-400">No description</span>
            )}
          </DetailRow>

          <DetailRow label="Category">
            {task.category ?? <span className="text-gray-400">Uncategorized</span>}
          </DetailRow>

          <DetailRow label="Due">
            {due ?? <span className="text-gray-400">No due date</span>}
          </DetailRow>

          <DetailRow label="Notion database">
            {task.notion_database_name ? (
              task.notion_database_name
            ) : (
              <span className="text-gray-400">Not linked</span>
            )}
          </DetailRow>

          {created ? <DetailRow label="Created">{created}</DetailRow> : null}
        </dl>

        {task.notion_url ? (
          <footer className="border-t border-gray-100 px-5 py-4">
            <a
              href={task.notion_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm font-medium text-brand-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              View in Notion
            </a>
          </footer>
        ) : null}

        <div className="border-t border-gray-100 px-5 py-4">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
