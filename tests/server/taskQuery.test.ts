import type { TaskRecord } from '../../server/src/services/tasks/repository';

// The query service reads tasks through the repository; mock it so the async
// functions are exercised offline against a controlled task list.
jest.mock('../../server/src/services/tasks/repository', () => ({
  listTasks: jest.fn(),
}));

import { listTasks } from '../../server/src/services/tasks/repository';
import {
  classifyTask,
  getTaskSummary,
  getTasksGrouped,
  groupTasks,
  listTasksForUser,
  summarizeTasks,
  TaskQueryError,
} from '../../server/src/services/tasks/query';

const mockListTasks = listTasks as jest.Mock;

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

/** A fixed "now" where UTC is 10:00 on 2026-10-06. */
const NOW = new Date('2026-10-06T10:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('task query — bucket derivation', () => {
  it('counts a task due today in the "today" bucket', () => {
    const summary = summarizeTasks([makeTask({ due_date: '2026-10-06' })], 'UTC', NOW);
    expect(summary.counts.today).toBe(1);
    expect(summary.counts.upcoming).toBe(0);
    expect(summary.counts.overdue).toBe(0);
  });

  it('counts a task due tomorrow as upcoming and within the awaiting window', () => {
    const summary = summarizeTasks([makeTask({ due_date: '2026-10-07' })], 'UTC', NOW);
    expect(summary.counts.upcoming).toBe(1);
    expect(summary.counts.today).toBe(0);
    expect(summary.counts.awaitingUpdate).toBe(1);
  });

  it('counts a past-due task as overdue and awaiting an update', () => {
    const summary = summarizeTasks([makeTask({ due_date: '2026-10-05' })], 'UTC', NOW);
    expect(summary.counts.overdue).toBe(1);
    expect(summary.counts.today).toBe(0);
    expect(summary.counts.upcoming).toBe(0);
    expect(summary.counts.awaitingUpdate).toBe(1);
  });

  it('counts a task with status "overdue" regardless of its date', () => {
    // Future due date, but the stored status is authoritative.
    const summary = summarizeTasks(
      [makeTask({ status: 'overdue', due_date: '2026-12-01' })],
      'UTC',
      NOW
    );
    expect(summary.counts.overdue).toBe(1);
    expect(summary.counts.upcoming).toBe(0);
    expect(summary.counts.today).toBe(0);
  });

  it('counts in_progress tasks in both the status bucket and a date bucket', () => {
    const summary = summarizeTasks(
      [makeTask({ status: 'in_progress', due_date: '2026-10-06' })],
      'UTC',
      NOW
    );
    expect(summary.counts.inProgress).toBe(1);
    expect(summary.counts.today).toBe(1);
  });

  it('excludes completed and cancelled tasks from every open bucket', () => {
    const summary = summarizeTasks(
      [
        makeTask({ id: 'c', status: 'completed', due_date: '2026-10-06' }),
        makeTask({ id: 'x', status: 'cancelled', due_date: '2026-10-06' }),
      ],
      'UTC',
      NOW
    );
    expect(summary.counts.completed).toBe(1);
    expect(summary.counts.today).toBe(0);
    expect(summary.counts.upcoming).toBe(0);
    expect(summary.counts.overdue).toBe(0);
    expect(summary.counts.inProgress).toBe(0);
    expect(summary.counts.awaitingUpdate).toBe(0);
  });

  it('treats a today task with an elapsed due time as overdue (and still due today)', () => {
    const summary = summarizeTasks(
      [makeTask({ due_date: '2026-10-06', due_time: '09:00' })],
      'UTC',
      NOW
    );
    // Per the documented derivation "today" is any task due on the local date,
    // so an overdue-today task appears in both buckets.
    expect(summary.counts.overdue).toBe(1);
    expect(summary.counts.today).toBe(1);
  });

  it('keeps a today task with a future due time in the today bucket', () => {
    const summary = summarizeTasks(
      [makeTask({ due_date: '2026-10-06', due_time: '18:00' })],
      'UTC',
      NOW
    );
    expect(summary.counts.today).toBe(1);
    expect(summary.counts.overdue).toBe(0);
  });

  describe('awaiting-update window (48h)', () => {
    it('includes a task due within the window', () => {
      const clock = summarizeTasks(
        [makeTask({ due_date: '2026-10-08', due_time: '09:00' })],
        'UTC',
        NOW
      ).counts;
      expect(clock.awaitingUpdate).toBe(1);
    });

    it('excludes a task beyond the window', () => {
      const clock = summarizeTasks(
        [makeTask({ due_date: '2026-10-09' })],
        'UTC',
        NOW
      ).counts;
      expect(clock.awaitingUpdate).toBe(0);
      expect(clock.upcoming).toBe(1);
    });

    it('excludes a completed task due within the window', () => {
      const clock = summarizeTasks(
        [makeTask({ status: 'completed', due_date: '2026-10-07' })],
        'UTC',
        NOW
      ).counts;
      expect(clock.awaitingUpdate).toBe(0);
    });
  });

  describe('timezone boundaries', () => {
    // 23:30 UTC is 00:30 the *next day* in Africa/Lagos (UTC+1).
    const EDGE = new Date('2026-10-06T23:30:00.000Z');
    const task = makeTask({ due_date: '2026-10-07' });

    it('buckets the task as "today" in Africa/Lagos', () => {
      const summary = summarizeTasks([task], 'Africa/Lagos', EDGE);
      expect(summary.counts.today).toBe(1);
      expect(summary.counts.upcoming).toBe(0);
    });

    it('buckets the same task as "upcoming" in UTC', () => {
      const summary = summarizeTasks([task], 'UTC', EDGE);
      expect(summary.counts.today).toBe(0);
      expect(summary.counts.upcoming).toBe(1);
    });

    it('falls back to UTC for an invalid timezone', () => {
      const summary = summarizeTasks([task], 'Not/AZone', EDGE);
      expect(summary.timezone).toBe('UTC');
      expect(summary.counts.upcoming).toBe(1);
    });
  });

  it('reports the effective timezone and a generatedAt timestamp', () => {
    const summary = summarizeTasks([], 'Africa/Lagos', NOW);
    expect(summary.timezone).toBe('Africa/Lagos');
    expect(summary.generatedAt).toBe(NOW.toISOString());
    expect(summary.counts).toEqual({
      today: 0,
      upcoming: 0,
      overdue: 0,
      inProgress: 0,
      awaitingUpdate: 0,
      completed: 0,
    });
  });
});

describe('task query — classifyTask + groupTasks', () => {
  it('flags a no-date task into no bucket', () => {
    const clock = {
      timeZone: 'UTC',
      date: '2026-10-06',
      time: '10:00',
      cutoffDate: '2026-10-08',
      cutoffTime: '10:00',
    };
    const flags = classifyTask(makeTask(), clock);
    expect(flags).toEqual({
      today: false,
      upcoming: false,
      overdue: false,
      inProgress: false,
      awaitingUpdate: false,
      completed: false,
    });
  });

  it('places tasks into the matching grouped buckets', () => {
    const grouped = groupTasks(
      [
        makeTask({ id: 'today', due_date: '2026-10-06' }),
        makeTask({ id: 'late', due_date: '2026-10-01' }),
        makeTask({ id: 'done', status: 'completed' }),
      ],
      'UTC',
      NOW
    );

    expect(grouped.buckets.today.map((task) => task.id)).toEqual(['today']);
    expect(grouped.buckets.overdue.map((task) => task.id)).toEqual(['late']);
    expect(grouped.buckets.completed.map((task) => task.id)).toEqual(['done']);
    expect(grouped.timezone).toBe('UTC');
  });

  it('bounds each bucket to 20 tasks', () => {
    const tasks = Array.from({ length: 25 }, (_, index) =>
      makeTask({ id: `t${index}`, due_date: '2026-10-06' })
    );
    const grouped = groupTasks(tasks, 'UTC', NOW);
    expect(grouped.buckets.today).toHaveLength(20);
  });
});

describe('task query — service wrappers', () => {
  it('getTaskSummary degrades to zeroed buckets when the repository is empty/unconfigured', async () => {
    mockListTasks.mockResolvedValue([]);
    const summary = await getTaskSummary('user-1', 'UTC', NOW);
    expect(summary.counts.today).toBe(0);
    expect(summary.timezone).toBe('UTC');
    expect(mockListTasks).toHaveBeenCalledWith('user-1', { limit: 100 });
  });

  it('getTasksGrouped returns empty bucket lists when there are no tasks', async () => {
    mockListTasks.mockResolvedValue([]);
    const grouped = await getTasksGrouped('user-1', 'Africa/Lagos', NOW);
    expect(grouped.buckets.today).toEqual([]);
    expect(grouped.buckets.completed).toEqual([]);
    expect(grouped.timezone).toBe('Africa/Lagos');
  });

  it('listTasksForUser validates and forwards filters', async () => {
    mockListTasks.mockResolvedValue([]);
    await listTasksForUser('user-1', { status: 'completed', limit: '10' });
    expect(mockListTasks).toHaveBeenCalledWith('user-1', { status: 'completed', limit: 10 });
  });

  it('listTasksForUser throws a TaskQueryError for invalid filters', async () => {
    await expect(listTasksForUser('user-1', { status: 'nope' })).rejects.toBeInstanceOf(
      TaskQueryError
    );
    expect(mockListTasks).not.toHaveBeenCalled();
  });
});
