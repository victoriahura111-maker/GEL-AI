import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Clock,
  ListTodo,
  Loader,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { useAuth } from '../context/AuthContext';
import { getGroupedTasks, getTaskSummary } from '../services/tasks';
import type { GroupedTasks, Task, TaskSummary } from '../services/tasks';
import { TaskDetailPanel, TaskSection, TaskStatCard } from '../components/tasks';
import type { TaskStatTone } from '../components/tasks';

type BucketName =
  | 'today'
  | 'upcoming'
  | 'overdue'
  | 'inProgress'
  | 'awaitingUpdate'
  | 'completed';

interface StatConfig {
  key: BucketName;
  label: string;
  icon: LucideIcon;
  tone: TaskStatTone;
}

const STATS: StatConfig[] = [
  { key: 'today', label: "Today's Tasks", icon: CalendarDays, tone: 'info' },
  { key: 'upcoming', label: 'Upcoming', icon: CalendarClock, tone: 'default' },
  { key: 'overdue', label: 'Overdue', icon: TriangleAlert, tone: 'danger' },
  { key: 'inProgress', label: 'In Progress', icon: Clock, tone: 'warn' },
  { key: 'awaitingUpdate', label: 'Awaiting Update', icon: ListTodo, tone: 'warn' },
  { key: 'completed', label: 'Completed', icon: CheckCircle2, tone: 'success' },
];

interface SectionConfig {
  key: BucketName;
  title: string;
  emptyMessage: string;
}

const SECTIONS: SectionConfig[] = [
  { key: 'today', title: 'Today', emptyMessage: 'Nothing due today.' },
  { key: 'overdue', title: 'Overdue', emptyMessage: 'Nothing overdue — nice work.' },
  { key: 'upcoming', title: 'Upcoming', emptyMessage: 'No upcoming tasks scheduled.' },
  { key: 'inProgress', title: 'In Progress', emptyMessage: 'No tasks in progress.' },
  {
    key: 'awaitingUpdate',
    title: 'Awaiting Update',
    emptyMessage: 'No tasks need an update right now.',
  },
  { key: 'completed', title: 'Completed', emptyMessage: 'No completed tasks yet.' },
];

/** Placeholder tiles shown while the summary is loading. */
function StatSkeletons() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      {Array.from({ length: 6 }).map((_, index) => (
        <Card key={index} className="flex items-center gap-3 px-4 py-4">
          <div className="h-10 w-10 animate-pulse rounded-lg bg-gray-100" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-16 animate-pulse rounded bg-gray-100" />
            <div className="h-5 w-8 animate-pulse rounded bg-gray-100" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const { profile } = useAuth();
  const timeZone = profile?.timezone || 'UTC';

  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [grouped, setGrouped] = useState<GroupedTasks | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selected, setSelected] = useState<Task | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Wrapped in an async function so even a synchronous throw while building
    // the requests becomes a rejected promise (never tears down the shell).
    const load = async () => {
      try {
        const [nextSummary, nextGrouped] = await Promise.all([getTaskSummary(), getGroupedTasks()]);
        if (cancelled) return;
        setSummary(nextSummary);
        setGrouped(nextGrouped);
      } catch {
        if (!cancelled) setError('Could not load your dashboard. Please try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  function scrollToBucket(key: BucketName) {
    if (typeof document === 'undefined') return;
    document.getElementById(`bucket-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <section>
      <PageHeader
        title="Dashboard"
        description="Your at-a-glance overview of tasks, organized by what needs attention now."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setReloadToken((token) => token + 1)}
            disabled={loading}
          >
            {loading ? (
              <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            Refresh
          </Button>
        }
      />

      {error ? (
        <Card className="mb-6 flex flex-col items-center gap-3 px-6 py-10 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
            <AlertCircle className="h-6 w-6" aria-hidden="true" />
          </div>
          <p role="alert" className="text-sm text-gray-700">
            {error}
          </p>
          <Button variant="secondary" onClick={() => setReloadToken((token) => token + 1)}>
            Retry
          </Button>
        </Card>
      ) : (
        <>
          {loading && !summary ? (
            <StatSkeletons />
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              {STATS.map((stat) => (
                <TaskStatCard
                  key={stat.key}
                  label={stat.label}
                  count={summary?.counts[stat.key] ?? 0}
                  icon={stat.icon}
                  tone={stat.tone}
                  onClick={() => scrollToBucket(stat.key)}
                />
              ))}
            </div>
          )}

          {loading && !grouped ? (
            <Card className="mt-6 flex items-center justify-center gap-2 px-6 py-16 text-sm text-gray-500">
              <Loader className="h-5 w-5 animate-spin" aria-hidden="true" />
              <span>Loading your tasks…</span>
            </Card>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
              {SECTIONS.map((section) => {
                const tasks = grouped?.buckets[section.key] ?? [];
                return (
                  <TaskSection
                    key={section.key}
                    id={`bucket-${section.key}`}
                    title={section.title}
                    tasks={tasks}
                    timeZone={timeZone}
                    onSelect={setSelected}
                    selectedId={selected?.id ?? null}
                    emptyMessage={section.emptyMessage}
                    aside={
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                        {summary?.counts[section.key] ?? tasks.length}
                      </span>
                    }
                  />
                );
              })}
            </div>
          )}
        </>
      )}

      {selected ? (
        <TaskDetailPanel task={selected} timeZone={timeZone} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}
