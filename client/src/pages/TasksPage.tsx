import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckSquare, Loader, RefreshCw, Search } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Input } from '../components/Input';
import { Label } from '../components/Label';
import { useAuth } from '../context/AuthContext';
import { listTasks } from '../services/tasks';
import type { Task, TaskListFilters, TaskStatus } from '../services/tasks';
import { fetchSyncStatus } from '../services/sync';
import type { SyncStatus } from '../services/sync';
import { TaskDetailPanel, TaskListItem, localDateString } from '../components/tasks';

type DueWindow = 'all' | 'overdue' | 'today' | 'upcoming';

const STATUS_OPTIONS: Array<{ value: TaskStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'overdue', label: 'Overdue' },
];

const DUE_WINDOW_OPTIONS: Array<{ value: DueWindow; label: string }> = [
  { value: 'all', label: 'Any time' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'upcoming', label: 'Upcoming' },
];

/** Shifts a `YYYY-MM-DD` string by whole days (UTC arithmetic, date-only). */
function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

const SELECT_STYLES =
  'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-60';

export function TasksPage() {
  const { profile } = useAuth();
  const timeZone = profile?.timezone || 'UTC';

  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [dueWindow, setDueWindow] = useState<DueWindow>('all');
  const [category, setCategory] = useState('');
  const [categoryDraft, setCategoryDraft] = useState('');
  const [search, setSearch] = useState('');

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selected, setSelected] = useState<Task | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

  // Phase 16 — compact sync health (best-effort; never blocks the page).
  useEffect(() => {
    let cancelled = false;
    fetchSyncStatus()
      .then((result) => {
        if (!cancelled) setSyncStatus(result);
      })
      .catch(() => {
        // Ignore: the tasks list is independent of Notion sync status.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refetch whenever a server-side filter (or the timezone) changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const filters: TaskListFilters = { limit: 100 };
    if (status) filters.status = status;
    if (category.trim()) filters.category = category.trim();

    const today = localDateString(timeZone);
    if (dueWindow === 'overdue') {
      filters.dueBefore = shiftDate(today, -1);
    } else if (dueWindow === 'today') {
      filters.dueAfter = today;
      filters.dueBefore = today;
    } else if (dueWindow === 'upcoming') {
      filters.dueAfter = shiftDate(today, 1);
    }

    // Wrapped in an async function so even a synchronous throw while building
    // the request becomes a rejected promise (never tears down the shell).
    const load = async () => {
      try {
        const result = await listTasks(filters);
        if (!cancelled) setTasks(result);
      } catch {
        if (!cancelled) setError('Could not load your tasks. Please try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [status, dueWindow, category, timeZone, reloadToken]);

  // Title search runs client-side over the fetched page.
  const visibleTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return tasks;
    return tasks.filter((task) => task.title.toLowerCase().includes(query));
  }, [tasks, search]);

  const hasFilters = Boolean(status) || dueWindow !== 'all' || Boolean(category.trim());

  function clearFilters() {
    setStatus('');
    setDueWindow('all');
    setCategory('');
    setCategoryDraft('');
  }

  return (
    <section>
      <PageHeader
        title="Tasks"
        description="Capture, organize, and track everything you need to get done."
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

      {syncStatus ? (
        <p className="mb-4 text-sm text-gray-500">
          {syncStatus.lastSyncedAt
            ? `Notion synced ${new Date(syncStatus.lastSyncedAt).toLocaleString()}`
            : 'Notion not synced yet.'}
          {syncStatus.counts.error > 0
            ? ` · ${syncStatus.counts.error} sync error${
                syncStatus.counts.error === 1 ? '' : 's'
              }`
            : ''}
        </p>
      ) : null}

      <Card className="mb-6">
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="task-search">Search</Label>
              <div className="relative mt-1">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                  aria-hidden="true"
                />
                <Input
                  id="task-search"
                  type="search"
                  value={search}
                  placeholder="Search by title"
                  onChange={(event) => setSearch(event.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="task-status-filter">Status</Label>
              <select
                id="task-status-filter"
                aria-label="Filter by status"
                className={`mt-1 ${SELECT_STYLES}`}
                value={status}
                onChange={(event) => setStatus(event.target.value as TaskStatus | '')}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value || 'all'} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="task-due-filter">Due window</Label>
              <select
                id="task-due-filter"
                aria-label="Filter by due window"
                className={`mt-1 ${SELECT_STYLES}`}
                value={dueWindow}
                onChange={(event) => setDueWindow(event.target.value as DueWindow)}
              >
                {DUE_WINDOW_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="task-category-filter">Category</Label>
              <div className="mt-1 flex gap-2">
                <Input
                  id="task-category-filter"
                  value={categoryDraft}
                  placeholder="e.g. Work"
                  onChange={(event) => setCategoryDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      setCategory(categoryDraft);
                    }
                  }}
                />
                <Button variant="secondary" onClick={() => setCategory(categoryDraft)}>
                  Apply
                </Button>
              </div>
            </div>
          </div>

          {hasFilters ? (
            <div className="mt-3">
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
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
      ) : loading && tasks.length === 0 ? (
        <Card className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-gray-500">
          <Loader className="h-5 w-5 animate-spin" aria-hidden="true" />
          <span>Loading your tasks…</span>
        </Card>
      ) : visibleTasks.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title={tasks.length === 0 ? 'No tasks yet' : 'No matching tasks'}
          description={
            tasks.length === 0
              ? 'Tasks you create — or that your assistant creates for you — will show up here.'
              : 'Try adjusting your filters or search terms.'
          }
        />
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle>All tasks</CardTitle>
            <span className="text-sm text-gray-500">
              {visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'}
            </span>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-gray-100">
              {visibleTasks.map((task) => (
                <TaskListItem
                  key={task.id}
                  task={task}
                  timeZone={timeZone}
                  onSelect={setSelected}
                  selected={selected?.id === task.id}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {selected ? (
        <TaskDetailPanel task={selected} timeZone={timeZone} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}
