import type { TaskPriority, TaskStatus } from '../../services/tasks';
import { cn } from '../../utils/cn';

/** Human labels for the status enum. */
const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  completed: 'Completed',
  cancelled: 'Cancelled',
  overdue: 'Overdue',
};

const STATUS_STYLES: Record<TaskStatus, string> = {
  not_started: 'bg-gray-100 text-gray-700',
  in_progress: 'bg-blue-100 text-blue-800',
  blocked: 'bg-amber-100 text-amber-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-100 text-gray-500',
  overdue: 'bg-red-100 text-red-800',
};

/** Small pill rendering a task's status. */
export function TaskStatusBadge({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        STATUS_STYLES[status],
        className
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  low: 'bg-slate-100 text-slate-700',
  medium: 'bg-amber-100 text-amber-800',
  high: 'bg-red-100 text-red-800',
};

/** Small pill rendering a task's priority (renders nothing when absent). */
export function TaskPriorityBadge({
  priority,
  className,
}: {
  priority: TaskPriority | null;
  className?: string;
}) {
  if (!priority) return null;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        PRIORITY_STYLES[priority],
        className
      )}
    >
      {PRIORITY_LABELS[priority]} priority
    </span>
  );
}
