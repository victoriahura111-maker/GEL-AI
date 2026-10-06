import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Bell, Loader, RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Input } from '../components/Input';
import { useAuth } from '../context/AuthContext';
import { formatTimestamp } from '../components/tasks';
import { cn } from '../utils/cn';
import { cancelReminder, listReminders, rescheduleReminder } from '../services/reminders';
import type { Reminder, ReminderStatus } from '../services/reminders';

/**
 * Phase 13 — reminders dashboard.
 *
 * Lists the caller's reminders grouped into upcoming and past, formatted in the
 * user's timezone, with Cancel / Reschedule actions wired to `/api/reminders`.
 */

const STATUS_LABELS: Record<ReminderStatus, string> = {
  pending: 'Pending',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_STYLES: Record<ReminderStatus, string> = {
  pending: 'bg-blue-100 text-blue-800',
  sent: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-500',
};

function ReminderStatusBadge({ status }: { status: ReminderStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        STATUS_STYLES[status]
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

interface ReminderRowProps {
  reminder: Reminder;
  timeZone: string;
  busy: boolean;
  editing: boolean;
  rescheduleValue: string;
  onStartReschedule: (id: string) => void;
  onChangeReschedule: (value: string) => void;
  onCancelReschedule: () => void;
  onSaveReschedule: (id: string) => void;
  onCancel: (id: string) => void;
}

function ReminderRow({
  reminder,
  timeZone,
  busy,
  editing,
  rescheduleValue,
  onStartReschedule,
  onChangeReschedule,
  onCancelReschedule,
  onSaveReschedule,
  onCancel,
}: ReminderRowProps) {
  const title = reminder.task?.title ?? 'Task';
  const scheduled = formatTimestamp(reminder.scheduled_for, timeZone) ?? reminder.scheduled_for;

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-gray-900">{title}</span>
          <ReminderStatusBadge status={reminder.status} />
          {reminder.recurrence ? (
            <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
              Repeats {reminder.recurrence}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-gray-500">{scheduled}</p>
        {reminder.status === 'failed' && reminder.failure_reason ? (
          <p className="mt-1 text-xs text-red-600">{reminder.failure_reason}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
        {reminder.status === 'pending' ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => onStartReschedule(reminder.id)}
            >
              Reschedule
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onCancel(reminder.id)}
            >
              Cancel
            </Button>
          </div>
        ) : null}

        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              type="datetime-local"
              aria-label="New reminder time"
              value={rescheduleValue}
              onChange={(event) => onChangeReschedule(event.target.value)}
              className="w-52"
            />
            <Button size="sm" disabled={busy || !rescheduleValue} onClick={() => onSaveReschedule(reminder.id)}>
              Save
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onCancelReschedule}>
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function RemindersPage() {
  const { profile } = useAuth();
  const timeZone = profile?.timezone || 'UTC';

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [rescheduleValue, setRescheduleValue] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        const result = await listReminders({ limit: 100 });
        if (!cancelled) setReminders(result);
      } catch {
        if (!cancelled) setError('Could not load your reminders. Please try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const upcomingList: Reminder[] = [];
    const pastList: Reminder[] = [];
    for (const reminder of reminders) {
      const at = new Date(reminder.scheduled_for).getTime();
      if (Number.isFinite(at) && at < now) pastList.push(reminder);
      else upcomingList.push(reminder);
    }
    return { upcoming: upcomingList, past: pastList };
  }, [reminders]);

  function replaceReminder(updated: Reminder) {
    setReminders((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  async function handleCancel(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      const updated = await cancelReminder(id);
      replaceReminder(updated);
    } catch {
      setActionError('Could not cancel that reminder. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  function handleStartReschedule(id: string) {
    setRescheduleId(id);
    setRescheduleValue('');
    setActionError(null);
  }

  function handleCancelReschedule() {
    setRescheduleId(null);
    setRescheduleValue('');
  }

  async function handleSaveReschedule(id: string) {
    if (!rescheduleValue) return;
    setBusyId(id);
    setActionError(null);
    try {
      const updated = await rescheduleReminder(id, {
        datetime: rescheduleValue,
        timezone: timeZone,
      });
      replaceReminder(updated);
      handleCancelReschedule();
    } catch {
      setActionError('Could not reschedule that reminder. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  function renderList(items: Reminder[]) {
    return (
      <ul className="divide-y divide-gray-100">
        {items.map((reminder) => (
          <ReminderRow
            key={reminder.id}
            reminder={reminder}
            timeZone={timeZone}
            busy={busyId === reminder.id}
            editing={rescheduleId === reminder.id}
            rescheduleValue={rescheduleValue}
            onStartReschedule={handleStartReschedule}
            onChangeReschedule={setRescheduleValue}
            onCancelReschedule={handleCancelReschedule}
            onSaveReschedule={handleSaveReschedule}
            onCancel={handleCancel}
          />
        ))}
      </ul>
    );
  }

  if (loading) {
    return (
      <section>
        <PageHeader title="Reminders" description="Time-based nudges for the things that matter." />
        <Card className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-gray-500">
          <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading reminders…
        </Card>
      </section>
    );
  }

  if (error) {
    return (
      <section>
        <PageHeader title="Reminders" description="Time-based nudges for the things that matter." />
        <Card className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <AlertCircle className="h-7 w-7 text-red-500" aria-hidden="true" />
          <p className="text-sm text-gray-600">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => setReloadToken((token) => token + 1)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Retry
          </Button>
        </Card>
      </section>
    );
  }

  if (reminders.length === 0) {
    return (
      <section>
        <PageHeader title="Reminders" description="Time-based nudges for the things that matter." />
        <EmptyState
          icon={Bell}
          title="No reminders scheduled"
          description="Reminders will appear here when you or your assistant schedule them."
        />
      </section>
    );
  }

  return (
    <section>
      <PageHeader title="Reminders" description="Time-based nudges for the things that matter." />

      {actionError ? (
        <div className="mb-4 flex items-center gap-2 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          {actionError}
        </div>
      ) : null}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Upcoming</CardTitle>
          </CardHeader>
          <CardContent className="py-0">
            {upcoming.length > 0 ? (
              renderList(upcoming)
            ) : (
              <p className="py-6 text-sm text-gray-500">No upcoming reminders.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Past</CardTitle>
          </CardHeader>
          <CardContent className="py-0">
            {past.length > 0 ? (
              renderList(past)
            ) : (
              <p className="py-6 text-sm text-gray-500">No past reminders.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
