import {
  advanceRecurrence,
  computeScheduledFor,
  convertLocalToUtc,
  parseDateTime,
  parseOffset,
  ReminderScheduleError,
  resolveDeadlineInstant,
} from '../../server/src/services/reminders/schedule';

/**
 * Phase 13 — pure schedule computation. No network, no database, no timers.
 */

const NOW = new Date('2026-10-06T00:00:00.000Z');

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected the call to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(ReminderScheduleError);
    expect((error as ReminderScheduleError).code).toBe(code);
  }
}

describe('parseOffset', () => {
  it('parses minutes, hours, days and weeks', () => {
    expect(parseOffset('30 minutes')).toBe(30 * 60_000);
    expect(parseOffset('15 mins')).toBe(15 * 60_000);
    expect(parseOffset('2 hours')).toBe(2 * 3_600_000);
    expect(parseOffset('1 hr')).toBe(3_600_000);
    expect(parseOffset('1 day')).toBe(86_400_000);
    expect(parseOffset('3 days')).toBe(3 * 86_400_000);
    expect(parseOffset('1 week')).toBe(604_800_000);
    expect(parseOffset('2 weeks')).toBe(1_209_600_000);
    // Tolerates a missing space and mixed case.
    expect(parseOffset('2HOURS')).toBe(2 * 3_600_000);
  });

  it('rejects an unparseable offset', () => {
    expectCode(() => parseOffset('soon'), 'invalid_offset');
    expectCode(() => parseOffset('1 fortnight'), 'invalid_offset');
    expectCode(() => parseOffset('1.5 hours'), 'invalid_offset');
    expectCode(() => parseOffset(''), 'invalid_offset');
  });
});

describe('convertLocalToUtc', () => {
  it('converts a wall-clock value in a fixed-offset timezone', () => {
    expect(convertLocalToUtc('2026-10-06', '09:00', 'Africa/Lagos').toISOString()).toBe(
      '2026-10-06T08:00:00.000Z'
    );
  });

  it('is correct either side of a DST transition (America/New_York, 2026-11-01)', () => {
    // DST ends 2026-11-01 at 02:00 local: before = EDT (-04:00), after = EST (-05:00).
    expect(convertLocalToUtc('2026-11-01', '01:00', 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:00:00.000Z'
    );
    expect(convertLocalToUtc('2026-11-01', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-11-01T14:00:00.000Z'
    );
  });
});

describe('parseDateTime', () => {
  it('honours an explicit UTC offset verbatim', () => {
    expect(parseDateTime('2026-10-06T09:00:00Z', 'Africa/Lagos').toISOString()).toBe(
      '2026-10-06T09:00:00.000Z'
    );
  });

  it('interprets a naive value in the supplied timezone', () => {
    expect(parseDateTime('2026-10-06T09:00', 'Africa/Lagos').toISOString()).toBe(
      '2026-10-06T08:00:00.000Z'
    );
  });

  it('accepts a space separator and a date-only value', () => {
    expect(parseDateTime('2026-10-06 09:00', 'UTC').toISOString()).toBe(
      '2026-10-06T09:00:00.000Z'
    );
    expect(parseDateTime('2026-10-06', 'UTC').toISOString()).toBe('2026-10-06T00:00:00.000Z');
  });

  it('rejects an unparseable date-time', () => {
    expectCode(() => parseDateTime('tomorrow', 'UTC'), 'invalid_datetime');
  });
});

describe('resolveDeadlineInstant', () => {
  it('uses the provided due time', () => {
    expect(
      resolveDeadlineInstant({ dueDate: '2026-10-06', dueTime: '17:00' }, 'UTC').toISOString()
    ).toBe('2026-10-06T17:00:00.000Z');
  });

  it('treats a missing due time as end of day (23:59) in the timezone', () => {
    expect(resolveDeadlineInstant({ dueDate: '2026-10-06' }, 'UTC').toISOString()).toBe(
      '2026-10-06T23:59:00.000Z'
    );
    expect(
      resolveDeadlineInstant({ dueDate: '2026-10-06' }, 'Africa/Lagos').toISOString()
    ).toBe('2026-10-06T22:59:00.000Z');
  });
});

describe('computeScheduledFor — at', () => {
  it('converts a naive date-time in the user timezone to UTC', () => {
    const result = computeScheduledFor({
      mode: 'at',
      datetime: '2026-10-06T09:00',
      timezone: 'Africa/Lagos',
      now: NOW,
    });
    expect(result).toEqual({
      scheduledFor: '2026-10-06T08:00:00.000Z',
      timezone: 'Africa/Lagos',
    });
  });

  it('honours an absolute date-time regardless of timezone', () => {
    const result = computeScheduledFor({
      mode: 'at',
      datetime: '2026-10-06T09:00:00.000Z',
      timezone: 'Africa/Lagos',
      now: NOW,
    });
    expect(result.scheduledFor).toBe('2026-10-06T09:00:00.000Z');
  });

  it('falls back to UTC for an invalid timezone', () => {
    const result = computeScheduledFor({
      mode: 'at',
      datetime: '2026-10-06T09:00',
      timezone: 'Not/AZone',
      now: NOW,
    });
    expect(result.timezone).toBe('UTC');
    expect(result.scheduledFor).toBe('2026-10-06T09:00:00.000Z');
  });

  it('rejects a date-time in the past', () => {
    expectCode(
      () =>
        computeScheduledFor({
          mode: 'at',
          datetime: '2026-10-05T09:00',
          timezone: 'UTC',
          now: NOW,
        }),
      'datetime_in_past'
    );
  });

  it('allows a past date-time when allowPast is set (create_task flow)', () => {
    const result = computeScheduledFor({
      mode: 'at',
      datetime: '2026-10-05T09:00',
      timezone: 'UTC',
      now: NOW,
      allowPast: true,
    });
    expect(result.scheduledFor).toBe('2026-10-05T09:00:00.000Z');
  });

  it('rejects a missing date-time', () => {
    expectCode(
      () => computeScheduledFor({ mode: 'at', datetime: null, timezone: 'UTC', now: NOW }),
      'missing_datetime'
    );
  });
});

describe('computeScheduledFor — before', () => {
  const timezone = 'UTC';

  it('subtracts minutes, hours, days and weeks from a deadline with a due time', () => {
    const deadline = { dueDate: '2026-10-06', dueTime: '17:00' };

    expect(
      computeScheduledFor({ mode: 'before', before: '30 minutes', deadline, timezone, now: NOW })
        .scheduledFor
    ).toBe('2026-10-06T16:30:00.000Z');
    expect(
      computeScheduledFor({ mode: 'before', before: '2 hours', deadline, timezone, now: NOW })
        .scheduledFor
    ).toBe('2026-10-06T15:00:00.000Z');
    expect(
      computeScheduledFor({ mode: 'before', before: '1 day', deadline, timezone, now: NOW })
        .scheduledFor
    ).toBe('2026-10-05T17:00:00.000Z');
    expect(
      computeScheduledFor({ mode: 'before', before: '1 week', deadline, timezone, now: NOW })
        .scheduledFor
    ).toBe('2026-09-29T17:00:00.000Z');
  });

  it('uses end of day (23:59) when the task has no due time', () => {
    const result = computeScheduledFor({
      mode: 'before',
      before: '1 day',
      deadline: { dueDate: '2026-10-06' },
      timezone,
      now: NOW,
    });
    expect(result.scheduledFor).toBe('2026-10-05T23:59:00.000Z');
  });

  it('resolves the deadline in the user timezone', () => {
    const result = computeScheduledFor({
      mode: 'before',
      before: '1 day',
      deadline: { dueDate: '2026-10-06', dueTime: '09:00' },
      timezone: 'Africa/Lagos',
      now: NOW,
    });
    expect(result).toEqual({
      scheduledFor: '2026-10-05T08:00:00.000Z',
      timezone: 'Africa/Lagos',
    });
  });

  it('rejects a missing deadline', () => {
    expectCode(
      () => computeScheduledFor({ mode: 'before', before: '1 day', deadline: null, timezone, now: NOW }),
      'missing_deadline'
    );
  });

  it('rejects an unparseable offset', () => {
    expectCode(
      () =>
        computeScheduledFor({
          mode: 'before',
          before: 'whenever',
          deadline: { dueDate: '2026-10-06' },
          timezone,
          now: NOW,
        }),
      'invalid_offset'
    );
  });
});

describe('advanceRecurrence', () => {
  it('advances a daily reminder by 24 hours', () => {
    expect(
      advanceRecurrence('2026-10-06T08:00:00.000Z', 'daily', new Date('2026-10-06T09:00:00.000Z'))
    ).toBe('2026-10-07T08:00:00.000Z');
  });

  it('advances a weekly reminder by 7 days', () => {
    expect(
      advanceRecurrence('2026-10-06T08:00:00.000Z', 'weekly', new Date('2026-10-06T09:00:00.000Z'))
    ).toBe('2026-10-13T08:00:00.000Z');
  });

  it('skips a backlog so the next occurrence is in the future', () => {
    expect(
      advanceRecurrence('2026-10-06T08:00:00.000Z', 'daily', new Date('2026-10-10T00:00:00.000Z'))
    ).toBe('2026-10-10T08:00:00.000Z');
  });

  it('returns null for an unsupported recurrence', () => {
    expect(advanceRecurrence('2026-10-06T08:00:00.000Z', 'monthly', NOW)).toBeNull();
    expect(advanceRecurrence('2026-10-06T08:00:00.000Z', null, NOW)).toBeNull();
  });
});
