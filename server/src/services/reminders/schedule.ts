import { resolveTimeZone } from '../tasks/query';

/**
 * Phase 13 — reminder schedule computation (pure, dependency-free).
 *
 * Turns a user's reminder intent into an absolute UTC instant (`scheduled_for`).
 * Two modes exist:
 *
 *  - `at`     — an absolute date-time. A value with an explicit offset (`Z` or
 *               `+HH:mm`) is honoured as-is; a *naive* value (e.g.
 *               `2026-10-06T09:00`) is interpreted as wall-clock time in the
 *               user's timezone and converted to UTC.
 *  - `before` — a relative offset (e.g. `'1 day'`, `'2 hours'`, `'30 minutes'`,
 *               `'1 week'`) subtracted from the task's deadline. When the task
 *               has no `due_time`, the deadline is treated as **end of day
 *               (23:59)** in the user's timezone. This is a deliberate,
 *               documented choice: a date-only deadline means "sometime that
 *               day", so subtracting from the end of that day is the least
 *               surprising interpretation.
 *
 * Timezone handling reuses the Phase 12 approach (`Intl.DateTimeFormat`): no
 * date library is used. An empty or invalid IANA timezone silently falls back
 * to `UTC` (never throws) so a bad profile value cannot break scheduling.
 */

export type ReminderMode = 'at' | 'before';

/** A task deadline expressed as wall-clock values. */
export interface TaskDeadline {
  /** `YYYY-MM-DD`. */
  dueDate: string;
  /** `HH:mm` (24h). When absent the deadline is the end of the day. */
  dueTime?: string | null;
}

export interface ComputeScheduledForInput {
  mode: ReminderMode;
  /** Absolute or naive date-time, used when `mode === 'at'`. */
  datetime?: string | null;
  /** Offset expression, used when `mode === 'before'`. */
  before?: string | null;
  /** The task deadline, required when `mode === 'before'`. */
  deadline?: TaskDeadline | null;
  timezone?: string | null;
  /** Clock used for the past-datetime guard. Defaults to the real now. */
  now?: Date;
  /**
   * When `true`, a computed instant in the past is permitted. The explicit
   * reminder API leaves this `false` (a past schedule is a `400`); the
   * `create_task` flow passes `true` so a model-supplied time that has just
   * passed is still recorded and fired on the next worker tick.
   */
  allowPast?: boolean;
}

export interface ComputedSchedule {
  /** ISO-8601 UTC instant. */
  scheduledFor: string;
  /** Resolved IANA timezone (never empty; `UTC` when the input was invalid). */
  timezone: string;
}

export type ReminderScheduleErrorCode =
  | 'missing_datetime'
  | 'invalid_datetime'
  | 'datetime_in_past'
  | 'missing_deadline'
  | 'invalid_offset';

/** Typed error raised by the schedule helpers (mapped to HTTP 400 upstream). */
export class ReminderScheduleError extends Error {
  readonly code: ReminderScheduleErrorCode;

  constructor(code: ReminderScheduleErrorCode, message: string) {
    super(`[reminders] ${message}`);
    this.name = 'ReminderScheduleError';
    this.code = code;
  }
}

// --- Offset grammar ----------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Accepted units for the `before` offset grammar (singular + plural + short). */
const OFFSET_UNITS: Record<string, number> = {
  minute: MINUTE,
  minutes: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  hour: HOUR,
  hours: HOUR,
  hr: HOUR,
  hrs: HOUR,
  day: DAY,
  days: DAY,
  week: WEEK,
  weeks: WEEK,
};

/** `<integer> <unit>` with an optional space, e.g. `1 day`, `2hours`, `30 min`. */
const OFFSET_PATTERN = /^(\d+)\s*([a-z]+)$/i;

/**
 * Parses an offset expression (`'1 day'`, `'2 hours'`, `'30 minutes'`,
 * `'1 week'`, `'15 mins'`) into milliseconds. Throws
 * {@link ReminderScheduleError} (`invalid_offset`) for anything else.
 */
export function parseOffset(value: string | null | undefined): number {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) {
    throw new ReminderScheduleError('invalid_offset', 'A reminder offset is required.');
  }

  const match = OFFSET_PATTERN.exec(raw);
  if (!match) {
    throw new ReminderScheduleError(
      'invalid_offset',
      `Could not parse the reminder offset "${value}".`
    );
  }

  const amount = Number(match[1]);
  const unitMs = OFFSET_UNITS[match[2]];
  if (!Number.isFinite(amount) || amount <= 0 || unitMs === undefined) {
    throw new ReminderScheduleError(
      'invalid_offset',
      `Could not parse the reminder offset "${value}".`
    );
  }

  return amount * unitMs;
}

// --- Local wall-clock -> UTC -------------------------------------------------

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat | null>();

/** Returns (and caches) a seconds-precision formatter for `timeZone`. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTER_CACHE.get(timeZone);
  if (cached !== undefined && cached !== null) return cached;

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
  FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

/** Milliseconds the given timezone is offset from UTC at `instant`. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
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

/** Normalises `HH:mm` / `HH:mm:ss` into a `HH:mm:ss` string. */
function normaliseTime(time: string): string {
  const trimmed = time.trim();
  return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
}

/**
 * Converts a wall-clock `date` (`YYYY-MM-DD`) + `time` (`HH:mm[:ss]`) in
 * `timeZone` into a UTC instant.
 *
 * The conversion is a two-pass offset correction: the first pass resolves the
 * offset at the naive UTC guess, the second re-resolves it at the corrected
 * instant. This keeps the result correct across DST boundaries where the offset
 * changes at (or near) the target wall-clock time.
 */
export function convertLocalToUtc(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${normaliseTime(time)}Z`);
  if (Number.isNaN(guess.getTime())) {
    throw new ReminderScheduleError('invalid_datetime', `Invalid date/time "${date} ${time}".`);
  }

  const firstOffset = zoneOffsetMs(guess, timeZone);
  const firstPass = new Date(guess.getTime() - firstOffset);
  const secondOffset = zoneOffsetMs(firstPass, timeZone);
  return new Date(guess.getTime() - secondOffset);
}

// --- Date-time parsing -------------------------------------------------------

/** Matches a trailing `Z` or `+HH:mm` / `-HH:mm` / `+HHmm` offset. */
const ABSOLUTE_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

/** Matches a naive `YYYY-MM-DD[T ]HH:mm[:ss]` wall-clock value. */
const NAIVE_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a reminder `datetime` into a UTC instant.
 *
 * Values carrying an explicit offset (`...Z`, `...+02:00`) are absolute and used
 * verbatim. Naive values are interpreted as wall-clock time in `timeZone`. A
 * date-only value is interpreted at `00:00` local time.
 */
export function parseDateTime(value: string, timeZone: string): Date {
  const raw = (value ?? '').trim();
  if (!raw) {
    throw new ReminderScheduleError('invalid_datetime', 'A reminder date-time is required.');
  }

  if (ABSOLUTE_SUFFIX.test(raw)) {
    const absolute = new Date(raw);
    if (Number.isNaN(absolute.getTime())) {
      throw new ReminderScheduleError('invalid_datetime', `Invalid date-time "${value}".`);
    }
    return absolute;
  }

  if (DATE_ONLY.test(raw)) {
    return convertLocalToUtc(raw, '00:00', timeZone);
  }

  const match = NAIVE_DATETIME.exec(raw);
  if (!match) {
    throw new ReminderScheduleError('invalid_datetime', `Invalid date-time "${value}".`);
  }

  const time = match[3] ? `${match[2]}:${match[3]}` : match[2];
  return convertLocalToUtc(match[1], time, timeZone);
}

/**
 * Formats a UTC instant into wall-clock `{ date: 'YYYY-MM-DD', time: 'HH:mm' }`
 * in `timeZone`, using the same `Intl` approach as {@link convertLocalToUtc}.
 * An invalid timezone falls back to `UTC` (never throws). Used by the Phase 15
 * follow-up response handler to persist a new deadline.
 */
export function toWallClockParts(instant: Date, timeZone: string): { date: string; time: string } {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = formatterFor(timeZone);
  } catch {
    formatter = formatterFor('UTC');
  }

  const parts = formatter.formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  let hour = pick('hour');
  // Some ICU versions emit '24' for midnight with hourCycle 'h23'.
  if (hour === '24') hour = '00';

  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    time: `${hour}:${pick('minute')}`,
  };
}

/** The wall-clock time used for a date-only deadline (documented: end of day). */
export const END_OF_DAY_TIME = '23:59';

/**
 * Resolves a task deadline to a UTC instant in `timeZone`. A missing `due_time`
 * is treated as {@link END_OF_DAY_TIME} (23:59) on the due date.
 */
export function resolveDeadlineInstant(deadline: TaskDeadline, timeZone: string): Date {
  const dueDate = (deadline?.dueDate ?? '').trim();
  if (!DATE_ONLY.test(dueDate)) {
    throw new ReminderScheduleError(
      'missing_deadline',
      'The task needs a due date to schedule a relative reminder.'
    );
  }

  const dueTime = (deadline.dueTime ?? '').trim() || END_OF_DAY_TIME;
  return convertLocalToUtc(dueDate, dueTime, timeZone);
}

// --- Recurrence --------------------------------------------------------------

/** Supported recurrence keywords and their fixed durations. */
const RECURRENCE_MS: Record<string, number> = {
  daily: DAY,
  weekly: WEEK,
};

/**
 * Advances a `scheduled_for` instant by one recurrence step, skipping forward
 * until the result is strictly after `now` (guards against replaying a backlog
 * after downtime). Returns `null` for an unsupported recurrence or a bad input.
 *
 * Recurrence is a fixed duration (`daily` = 24h, `weekly` = 7d) applied to the
 * stored instant — deliberately simple and DST-agnostic, matching the table's
 * free-form `recurrence` column.
 */
export function advanceRecurrence(
  scheduledForIso: string,
  recurrence: string | null | undefined,
  now: Date = new Date()
): string | null {
  const step = RECURRENCE_MS[(recurrence ?? '').trim().toLowerCase()];
  if (!step) return null;

  const base = new Date(scheduledForIso);
  if (Number.isNaN(base.getTime())) return null;

  let next = new Date(base.getTime() + step);
  let guard = 0;
  while (next.getTime() <= now.getTime() && guard < 1000) {
    next = new Date(next.getTime() + step);
    guard += 1;
  }

  return next.toISOString();
}

// --- Entry point -------------------------------------------------------------

/**
 * Computes the absolute UTC `scheduled_for` for a reminder.
 *
 * @throws {ReminderScheduleError} `missing_datetime` / `invalid_datetime` /
 * `datetime_in_past` for `at`; `invalid_offset` / `missing_deadline` for
 * `before`. An invalid timezone never throws — it falls back to `UTC`.
 */
export function computeScheduledFor(input: ComputeScheduledForInput): ComputedSchedule {
  const timezone = resolveTimeZone(input.timezone);
  const now = input.now ?? new Date();

  if (input.mode === 'at') {
    if (!input.datetime) {
      throw new ReminderScheduleError('missing_datetime', 'A reminder date-time is required.');
    }

    const instant = parseDateTime(input.datetime, timezone);
    if (!input.allowPast && instant.getTime() <= now.getTime()) {
      throw new ReminderScheduleError(
        'datetime_in_past',
        'The reminder time must be in the future.'
      );
    }

    return { scheduledFor: instant.toISOString(), timezone };
  }

  const offsetMs = parseOffset(input.before);
  if (!input.deadline?.dueDate) {
    throw new ReminderScheduleError(
      'missing_deadline',
      'The task needs a due date to schedule a relative reminder.'
    );
  }

  const deadlineInstant = resolveDeadlineInstant(input.deadline, timezone);
  const scheduled = new Date(deadlineInstant.getTime() - offsetMs);

  return { scheduledFor: scheduled.toISOString(), timezone };
}
