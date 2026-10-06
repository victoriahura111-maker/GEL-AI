import type { Task } from '../../services/tasks';

/**
 * Date/time formatting for task wall-clock values.
 *
 * `due_date` (`YYYY-MM-DD`) and `due_time` (`HH:mm`) are stored as the user's
 * *wall clock* values. We reconstruct the instant they denote **in the user's
 * timezone** and format it back in that same timezone (using `Intl`), so the
 * displayed day/time always matches what the user typed — never the browser's
 * or server's notion of "today".
 */

const FALLBACK_TIMEZONE = 'UTC';

/** Milliseconds the given timezone is offset from UTC at `instant`. */
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
    pick('second')
  );

  return asUtc - instant.getTime();
}

/** Turns a `YYYY-MM-DD` + `HH:mm` wall-clock pair in `timeZone` into an instant. */
function wallClockToInstant(date: string, time: string, timeZone: string): Date | null {
  const guess = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(guess.getTime())) return null;

  // Correct the UTC guess by the zone offset at roughly that instant. One pass
  // is enough for all real-world zones (the offset never changes at a boundary
  // we are about to cross for the same wall-clock value in practice).
  const offset = timeZoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

/** The current `YYYY-MM-DD` in `timeZone`. */
export function localDateString(timeZone: string, now: Date = new Date()): string {
  const resolved = timeZone?.trim() || FALLBACK_TIMEZONE;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: resolved,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const pick = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Resolves the task's timezone, falling back to the caller's, then UTC. */
function resolveTimeZone(task: Pick<Task, 'timezone'>, fallback: string): string {
  const candidate = task.timezone?.trim() || fallback?.trim() || FALLBACK_TIMEZONE;
  try {
    // Throws for an invalid IANA name.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

interface FormatOptions {
  locale?: string;
  /** Include the time portion when the task has a `due_time`. */
  includeTime?: boolean;
}

/**
 * Formats a task's due value, e.g. `"Oct 6, 2026 · 5:00 PM"`, `"Oct 6, 2026"`,
 * or `null` when the task has no due date.
 */
export function formatTaskDue(
  task: Pick<Task, 'due_date' | 'due_time' | 'timezone'>,
  fallbackTimeZone: string,
  options: FormatOptions = {}
): string | null {
  if (!task.due_date) return null;

  const timeZone = resolveTimeZone(task, fallbackTimeZone);
  const includeTime = options.includeTime ?? true;
  const locale = options.locale;

  // Date-only values need no instant reconstruction.
  if (!task.due_time || !includeTime) {
    const instant = wallClockToInstant(task.due_date, '12:00', timeZone);
    if (!instant) return task.due_date;
    try {
      return new Intl.DateTimeFormat(locale, {
        timeZone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(instant);
    } catch {
      return task.due_date;
    }
  }

  const instant = wallClockToInstant(task.due_date, task.due_time, timeZone);
  if (!instant) return `${task.due_date} ${task.due_time}`;

  try {
    const datePart = new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(instant);
    const timePart = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(instant);
    return `${datePart} · ${timePart}`;
  } catch {
    return `${task.due_date} ${task.due_time}`;
  }
}

/** Formats an ISO timestamp (e.g. `created_at`) in `timeZone`. */
export function formatTimestamp(
  iso: string | null | undefined,
  timeZone: string,
  locale?: string
): string | null {
  if (!iso) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;

  const resolved = timeZone?.trim() || FALLBACK_TIMEZONE;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: resolved,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(instant);
  } catch {
    return instant.toISOString();
  }
}
