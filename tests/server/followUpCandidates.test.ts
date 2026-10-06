import { evaluateFollowUpCandidates } from '../../server/src/services/followup/candidates';
import type { TaskRecord } from '../../server/src/services/tasks/repository';

/**
 * Phase 15 — follow-up candidate selection. Pure, deterministic, no Supabase.
 * The timezone-sensitive assertions prove the wall-clock deadline is resolved
 * with the existing `Intl` approach rather than server-local time.
 */

const OPTIONS = { leadHours: 24, minIntervalHours: 20, maxPerTask: 3 };

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    user_id: 'user-1',
    notion_page_id: null,
    notion_database_id: null,
    notion_url: null,
    title: 'Write report',
    description: null,
    category: null,
    priority: 'high',
    status: 'not_started',
    due_date: '2026-10-06',
    due_time: '12:00',
    timezone: 'UTC',
    source_of_change: null,
    sync_status: null,
    last_synced_at: null,
    follow_up_count: 0,
    last_follow_up_at: null,
    awaiting_follow_up: false,
    blocking_reason: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('evaluateFollowUpCandidates', () => {
  const NOW = new Date('2026-10-06T09:00:00.000Z');

  it('selects a task due within the lead window as due_soon', () => {
    const tasks = [makeTask({ due_date: '2026-10-06', due_time: '20:00' })];
    const result = evaluateFollowUpCandidates(tasks, NOW, OPTIONS);

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('due_soon');
    expect(result[0].task.id).toBe('task-1');
    expect(result[0].hoursUntilDue).toBeCloseTo(11, 0);
  });

  it('selects an already-past deadline as overdue', () => {
    const tasks = [makeTask({ due_date: '2026-10-05', due_time: '12:00' })];
    const result = evaluateFollowUpCandidates(tasks, NOW, OPTIONS);

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('overdue');
    expect(result[0].hoursUntilDue).toBeLessThan(0);
  });

  it('ignores tasks whose deadline is beyond the lead window', () => {
    const tasks = [makeTask({ due_date: '2026-10-20', due_time: '12:00' })];
    expect(evaluateFollowUpCandidates(tasks, NOW, OPTIONS)).toEqual([]);
  });

  it('excludes completed and cancelled tasks', () => {
    const tasks = [
      makeTask({ id: 'a', status: 'completed', due_date: '2026-10-05' }),
      makeTask({ id: 'b', status: 'cancelled', due_date: '2026-10-05' }),
      makeTask({ id: 'c', status: 'blocked', due_date: '2026-10-05' }),
    ];
    const result = evaluateFollowUpCandidates(tasks, NOW, OPTIONS);
    expect(result.map((candidate) => candidate.task.id)).toEqual(['c']);
  });

  it('respects the per-task follow-up cap', () => {
    const tasks = [makeTask({ follow_up_count: 3, due_date: '2026-10-05' })];
    expect(evaluateFollowUpCandidates(tasks, NOW, OPTIONS)).toEqual([]);

    const under = [makeTask({ follow_up_count: 2, due_date: '2026-10-05' })];
    expect(evaluateFollowUpCandidates(under, NOW, OPTIONS)).toHaveLength(1);
  });

  it('respects the minimum interval since the last follow-up', () => {
    const tooSoon = [makeTask({ last_follow_up_at: '2026-10-06T07:00:00.000Z', due_date: '2026-10-05' })];
    expect(evaluateFollowUpCandidates(tooSoon, NOW, OPTIONS)).toEqual([]);

    const longAgo = [makeTask({ last_follow_up_at: '2026-10-04T00:00:00.000Z', due_date: '2026-10-05' })];
    expect(evaluateFollowUpCandidates(longAgo, NOW, OPTIONS)).toHaveLength(1);
  });

  it('resolves the deadline in the task timezone (not server-local)', () => {
    // 2026-10-07 (date only) = end of day. In UTC that is 23:59Z on the 7th,
    // ~39h away → excluded. In New York (UTC-4 in October) it is 03:59Z on the
    // 8th → even further away → also excluded. Use the 6th instead to show the
    // difference across the lead boundary.
    const utcTask = makeTask({ due_date: '2026-10-07', due_time: null, timezone: 'UTC' });
    const nyTask = makeTask({ id: 'ny', due_date: '2026-10-07', due_time: null, timezone: 'America/New_York' });

    // now = 2026-10-07T00:00:00Z → UTC deadline 23:59Z is 23.98h away (due_soon);
    // New York deadline is 03:59Z the next day, ~27.98h away (excluded).
    const now = new Date('2026-10-07T00:00:00.000Z');

    const utcResult = evaluateFollowUpCandidates([utcTask], now, OPTIONS);
    const nyResult = evaluateFollowUpCandidates([nyTask], now, OPTIONS);

    expect(utcResult).toHaveLength(1);
    expect(utcResult[0].kind).toBe('due_soon');
    expect(nyResult).toEqual([]);
  });

  it('sorts candidates by soonest deadline first', () => {
    const tasks = [
      makeTask({ id: 'later', due_date: '2026-10-06', due_time: '22:00' }),
      makeTask({ id: 'overdue', due_date: '2026-10-01', due_time: '12:00' }),
      makeTask({ id: 'sooner', due_date: '2026-10-06', due_time: '12:00' }),
    ];
    const result = evaluateFollowUpCandidates(tasks, NOW, OPTIONS);
    expect(result.map((candidate) => candidate.task.id)).toEqual(['overdue', 'sooner', 'later']);
  });
});
