import type { ReactNode } from 'react';
import type { Task } from '../../services/tasks';
import { Card, CardContent, CardHeader, CardTitle } from '../Card';
import { TaskListItem } from './TaskListItem';

interface TaskSectionProps {
  title: string;
  tasks: Task[];
  timeZone: string;
  onSelect: (task: Task) => void;
  selectedId?: string | null;
  emptyMessage: string;
  /** Optional heading adornment (e.g. a count badge). */
  aside?: ReactNode;
  id?: string;
}

/** A titled card containing a bounded list of tasks with a per-section empty state. */
export function TaskSection({
  title,
  tasks,
  timeZone,
  onSelect,
  selectedId,
  emptyMessage,
  aside,
  id,
}: TaskSectionProps) {
  return (
    <Card id={id}>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>{title}</CardTitle>
        {aside}
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p className="text-sm text-gray-500">{emptyMessage}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {tasks.map((task) => (
              <TaskListItem
                key={task.id}
                task={task}
                timeZone={timeZone}
                onSelect={onSelect}
                selected={selectedId === task.id}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
