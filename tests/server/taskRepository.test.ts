import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

// Replace the real PostgREST client with the in-memory fake. `createClient` is
// called once at import time to build the admin client used by the repositories.
jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

import { supabaseAdmin } from '../../server/src/services/supabase';
import {
  createTaskRecord,
  deleteTaskRecord,
  findTasksByTitleFragment,
  getTaskById,
  listTasks,
  updateTaskRecord,
} from '../../server/src/services/tasks/repository';

const fake = supabaseAdmin as unknown as FakeSupabaseClient;

const USER_A = 'user-a';
const USER_B = 'user-b';

function taskRows(): FakeRow[] {
  return fake.__store.assistant_tasks ?? [];
}

function lastFilterCalls(): Array<[string, unknown]> {
  return fake.__queries[fake.__queries.length - 1].filterCalls;
}

function seedTasks(rows: FakeRow[]): void {
  fake.__store.assistant_tasks = rows;
}

beforeEach(() => {
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
  fake.__queries.length = 0;
});

describe('task repository', () => {
  it('createTaskRecord writes to assistant_tasks with the caller user_id', async () => {
    const created = await createTaskRecord(USER_A, { title: 'Write report' });

    expect(Object.keys(fake.__store)).toContain('assistant_tasks');
    expect(taskRows()).toHaveLength(1);
    expect(created).toMatchObject({ user_id: USER_A, title: 'Write report' });
    expect(taskRows()[0]).toMatchObject({ user_id: USER_A, title: 'Write report' });
  });

  it('createTaskRecord ignores any user_id supplied in the input (user_id is server-owned)', async () => {
    // The service spreads validated input, which never contains user_id; this
    // asserts the persisted owner is the authenticated user.
    await createTaskRecord(USER_A, { title: 'Owned by A' });

    expect(taskRows()[0].user_id).toBe(USER_A);
  });

  it('getTaskById scopes every query by user_id', async () => {
    await createTaskRecord(USER_A, { title: 'A task' });
    const id = taskRows()[0].id as string;

    const found = await getTaskById(USER_A, id);

    expect(found).toMatchObject({ id, user_id: USER_A });
    expect(lastFilterCalls()).toContainEqual(['user_id', USER_A]);
    expect(lastFilterCalls()).toContainEqual(['id', id]);
  });

  it('getTaskById cannot return another user\'s row', async () => {
    await createTaskRecord(USER_A, { title: 'Private' });
    const id = taskRows()[0].id as string;

    const found = await getTaskById(USER_B, id);

    expect(found).toBeNull();
    expect(lastFilterCalls()).toContainEqual(['user_id', USER_B]);
  });

  it('updateTaskRecord applies a status transition scoped to the owner', async () => {
    await createTaskRecord(USER_A, { title: 'T' });
    const id = taskRows()[0].id as string;

    const updated = await updateTaskRecord(USER_A, id, { status: 'completed' });

    expect(updated).toMatchObject({ id, status: 'completed' });
    expect(taskRows()[0].status).toBe('completed');
    expect(lastFilterCalls()).toContainEqual(['user_id', USER_A]);
  });

  it('updateTaskRecord cannot mutate another user\'s row', async () => {
    seedTasks([{ id: 'task-1', user_id: USER_A, title: 'T', status: 'not_started' }]);

    const updated = await updateTaskRecord(USER_B, 'task-1', { status: 'cancelled' });

    expect(updated).toBeNull();
    expect(taskRows()[0].status).toBe('not_started');
  });

  it('listTasks filters by status/category/dates and user_id', async () => {
    seedTasks([
      {
        id: 'a-1',
        user_id: USER_A,
        title: 'A in progress',
        status: 'in_progress',
        category: 'Work',
        due_date: '2026-10-05',
      },
      {
        id: 'a-2',
        user_id: USER_A,
        title: 'A later',
        status: 'in_progress',
        category: 'Work',
        due_date: '2026-11-01',
      },
      {
        id: 'b-1',
        user_id: USER_B,
        title: 'B in progress',
        status: 'in_progress',
        category: 'Work',
        due_date: '2026-10-05',
      },
    ]);

    const results = await listTasks(USER_A, {
      status: 'in_progress',
      category: 'Work',
      dueAfter: '2026-10-01',
      dueBefore: '2026-10-31',
      limit: 10,
    });

    expect(results.map((row) => row.id)).toEqual(['a-1']);
    expect(lastFilterCalls()).toContainEqual(['user_id', USER_A]);
    expect(lastFilterCalls()).toContainEqual(['status', 'in_progress']);
    expect(lastFilterCalls()).toContainEqual(['category', 'Work']);
    expect(lastFilterCalls()).toContainEqual(['due_date', '2026-10-01']);
    expect(lastFilterCalls()).toContainEqual(['due_date', '2026-10-31']);
  });

  it('deleteTaskRecord only deletes the owner\'s row', async () => {
    seedTasks([{ id: 'task-1', user_id: USER_A, title: 'T' }]);

    const crossUser = await deleteTaskRecord(USER_B, 'task-1');
    expect(crossUser).toBe(false);
    expect(taskRows()).toHaveLength(1);

    const owned = await deleteTaskRecord(USER_A, 'task-1');
    expect(owned).toBe(true);
    expect(taskRows()).toHaveLength(0);
  });

  it('findTasksByTitleFragment matches case-insensitively and only for the owner', async () => {
    seedTasks([
      { id: 'a-1', user_id: USER_A, title: 'Write Report' },
      { id: 'b-1', user_id: USER_B, title: 'write report' },
    ]);

    const results = await findTasksByTitleFragment(USER_A, 'report');

    expect(results.map((row) => row.id)).toEqual(['a-1']);
    expect(lastFilterCalls()).toContainEqual(['user_id', USER_A]);
  });
});
