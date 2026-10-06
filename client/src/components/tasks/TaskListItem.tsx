import { CalendarClock } from 'lucide-react';
import type { Task } from '../../services/tasks';
import { TaskPriorityBadge, TaskStatusBadge } from './TaskBadges';
import { formatTaskDue } from './format';
import { cn } from '../../utils/cn';

interface TaskListItemProps {
  task: Task;
  timeZone: string;
  onSelect: (task: Task) => void;
  selected?: boolean;
}

/** A single, clickable task row shared by the dashboard and the tasks page. */
export function TaskListItem({ task, timeZone, onSelect, selected = false }: TaskListItemProps) {
  const due = formatTaskDue(task, timeZone);

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(task)}
        className={cn(
          'flex w-full items-start gap-3 px-1 py-3 text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          selected && 'bg-brand-50'
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-900">{task.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
            {due ? (
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                {due}
              </span>
            ) : null}
            {task.category ? <span className="truncate">· {task.category}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <TaskStatusBadge status={task.status} />
          <TaskPriorityBadge priority={task.priority} />
        </div>
      </button>
    </li>
  );
}
