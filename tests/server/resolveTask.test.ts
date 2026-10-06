import { supabaseAdmin } from '../../server/src/services/supabase';
import { resolveTask } from '../../server/src/services/tasks/resolveTask';
import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

// The task mirror runs on the in-memory PostgREST fake; nothing touches a live
// database.
jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

const fake = supabaseAdmin as unknown as FakeSupabaseClient;

let counter = 0;

/** Builds a complete task row with sensible defaults. */
function makeTask(overrides: Partial<FakeRow> = {}): FakeRow {
  counter += 1;
  const created = `2026-09-${String((counter % 27) + 1).padStart(2, '0')}T10:00:00.000Z`;
  return {
    id: `task-${counter}`,
    user_id: 'user-1',
    notion_page_id: null,
    notion_database_id: null,
    notion_url: null,
    title: 'Untitled',
    description: null,
    category: null,
    priority: null,
    status: 'not_started',
    due_date: null,
    due_time: null,
    timezone: null,
    source_of_change: 'assistant',
    sync_status: 'synced',
    last_synced_at: null,
    created_at: created,
    updated_at: created,
    ...overrides,
  };
}

function seed(rows: FakeRow[]): void {
  fake.__store.assistant_tasks = rows;
}

beforeEach(() => {
  jest.clearAllMocks();
  counter = 0;
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
});

describe('resolveTask — ranking', () => {
  it('prefers an exact title match over prefix and substring matches', async () => {
    seed([
      makeTask({ id: 'substring', title: 'Weekly report' }),
      makeTask({ id: 'prefix', title: 'Report draft' }),
      makeTask({ id: 'exact', title: 'Report' }),
    ]);

    const result = await resolveTask('user-1', 'report');

    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.task.id).toBe('exact');
  });

  it('prefers a prefix match over a substring match', async () => {
    seed([
      makeTask({ id: 'substring', title: 'Weekly report' }),
      makeTask({ id: 'prefix', title: 'Report draft' }),
    ]);

    const result = await resolveTask('user-1', 'report');

    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.task.id).toBe('prefix');
  });

  it('matches against the category as well as the title', async () => {
    seed([makeTask({ id: 'categorised', title: 'Groceries', category: 'Earnings report' })]);

    const result = await resolveTask('user-1', 'report');

    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.task.id).toBe('categorised');
  });

  it('prefers an open task over a completed one at the same rank', async () => {
    seed([
      makeTask({ id: 'done', title: 'Report', status: 'completed' }),
      makeTask({ id: 'open', title: 'Report', status: 'in_progress' }),
    ]);

    const result = await resolveTask('user-1', 'report');

    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.task.id).toBe('open');
  });

  it('returns the nearest due date when rank and status tie', async () => {
    seed([
      makeTask({ id: 'later', title: 'Report', due_date: '2026-12-01' }),
      makeTask({ id: 'sooner', title: 'Report', due_date: '2026-10-05' }),
    ]);

    const result = await resolveTask('user-1', 'report');

    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.task.id).toBe('sooner');
  });
});

describe('resolveTask — ambiguity and absence', () => {
  it('returns ambiguous with the equal-rank candidates', async () => {
    seed([
      makeTask({ id: 'a', title: 'Report alpha' }),
      makeTask({ id: 'b', title: 'Report beta' }),
    ]);

    const result = await resolveTask('user-1', 'report');

    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((task) => task.id).sort()).toEqual(['a', 'b']);
    }
  });

  it('returns not_found when nothing matches', async () => {
    seed([makeTask({ title: 'Unrelated' })]);

    const result = await resolveTask('user-1', 'report');

    expect(result).toEqual({ status: 'not_found' });
  });

  it('never returns another user’s task', async () => {
    seed([makeTask({ id: 'theirs', user_id: 'user-2', title: 'Report' })]);

    const result = await resolveTask('user-1', 'report');

    expect(result).toEqual({ status: 'not_found' });
  });

  it('falls back to the most recently updated open task when no identifier is given', async () => {
    seed([
      makeTask({
        id: 'old',
        title: 'Old task',
        status: 'in_progress',
        updated_at: '2026-09-01T10:00:00.000Z',
      }),
      makeTask({
        id: 'recent',
        title: 'Recent task',
        status: 'in_progress',
        updated_at: '2026-09-20T10:00:00.000Z',
      }),
      makeTask({ id: 'closed', title: 'Closed', status: 'completed' }),
    ]);

    const result = await resolveTask('user-1', undefined);

    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.task.id).toBe('recent');
  });

  it('returns not_found when no identifier is given and there is no open task', async () => {
    seed([makeTask({ title: 'Done', status: 'completed' })]);

    const result = await resolveTask('user-1', '   ');

    expect(result).toEqual({ status: 'not_found' });
  });
});
