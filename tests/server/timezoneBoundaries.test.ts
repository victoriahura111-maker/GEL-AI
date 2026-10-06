import { buildIntentSystemPrompt } from '../../server/src/services/ai/prompts';
import {
  computeScheduledFor,
  convertLocalToUtc,
} from '../../server/src/services/reminders/schedule';
import { summarizeTasks } from '../../server/src/services/tasks/query';
import type { TaskRecord } from '../../server/src/services/tasks/repository';

/**
 * Phase 18 — date interpretation + timezone boundaries.
 *
 * Proves that relative dates resolve correctly by (a) carrying the current date
 * and the user's IANA timezone into the intent prompt, (b) converting the SAME
 * wall-clock value to different UTC instants across zones (including a
 * negative-offset zone), and (c) bucketing tasks on the right day per zone.
 * All instants are pinned, so nothing depends on the real clock.
 */

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    user_id: 'user-1',
    notion_page_id: null,
    notion_database_id: null,
    notion_url: null,
    title: 'Task',
    description: null,
    category: null,
    priority: null,
    status: 'not_started',
    due_date: null,
    due_time: null,
    timezone: null,
    source_of_change: null,
    sync_status: null,
    last_synced_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('intent prompt carries the current date and user timezone', () => {
  it('embeds both the ISO now and the IANA timezone for a negative-offset zone', () => {
    const nowIso = '2026-10-06T04:00:00.000Z';
    const prompt = buildIntentSystemPrompt({ timezone: 'America/New_York', nowIso });

    expect(prompt).toContain(nowIso);
    expect(prompt).toContain('America/New_York');
    expect(prompt.toLowerCase()).toContain('resolve all relative dates');
  });
});

describe('cross-timezone wall-clock conversion', () => {
  it('converts the same wall clock to different UTC instants per zone', () => {
    const utc = convertLocalToUtc('2026-10-06', '09:00', 'UTC');
    const lagos = convertLocalToUtc('2026-10-06', '09:00', 'Africa/Lagos'); // UTC+1
    const newYork = convertLocalToUtc('2026-10-06', '09:00', 'America/New_York'); // EDT UTC-4

    expect(utc.toISOString()).toBe('2026-10-06T09:00:00.000Z');
    expect(lagos.toISOString()).toBe('2026-10-06T08:00:00.000Z');
    expect(newYork.toISOString()).toBe('2026-10-06T13:00:00.000Z');
  });
});

describe('reminder scheduling across timezones', () => {
  it('resolves a naive "at" time per zone', () => {
    const base = { mode: 'at' as const, datetime: '2026-10-06T09:00', allowPast: true };

    expect(computeScheduledFor({ ...base, timezone: 'UTC' }).scheduledFor).toBe(
      '2026-10-06T09:00:00.000Z'
    );
    expect(computeScheduledFor({ ...base, timezone: 'Africa/Lagos' }).scheduledFor).toBe(
      '2026-10-06T08:00:00.000Z'
    );
    expect(computeScheduledFor({ ...base, timezone: 'America/New_York' }).scheduledFor).toBe(
      '2026-10-06T13:00:00.000Z'
    );
  });

  it('resolves a "before" offset against an end-of-day deadline per zone', () => {
    const deadline = { dueDate: '2026-10-07' }; // no due time -> 23:59 local

    expect(
      computeScheduledFor({ mode: 'before', before: '1 day', deadline, timezone: 'UTC' })
        .scheduledFor
    ).toBe('2026-10-06T23:59:00.000Z');
    expect(
      computeScheduledFor({ mode: 'before', before: '1 day', deadline, timezone: 'Africa/Lagos' })
        .scheduledFor
    ).toBe('2026-10-06T22:59:00.000Z');
    expect(
      computeScheduledFor({
        mode: 'before',
        before: '1 day',
        deadline,
        timezone: 'America/New_York',
      }).scheduledFor
    ).toBe('2026-10-07T03:59:00.000Z');
  });
});

describe('task query — day boundaries across zones', () => {
  it('buckets the same task on the correct day in a positive, zero and negative zone', () => {
    // now = 2026-10-07T02:00Z. In Los Angeles (UTC-7) it is still 19:00 on the 6th,
    // so a task due on the 7th is "upcoming"; in Lagos/UTC it is already the 7th.
    const now = new Date('2026-10-07T02:00:00.000Z');
    const task = makeTask({ due_date: '2026-10-07' });

    expect(summarizeTasks([task], 'UTC', now).counts.today).toBe(1);
    expect(summarizeTasks([task], 'Africa/Lagos', now).counts.today).toBe(1);

    const la = summarizeTasks([task], 'America/Los_Angeles', now);
    expect(la.counts.today).toBe(0);
    expect(la.counts.upcoming).toBe(1);
  });
});
