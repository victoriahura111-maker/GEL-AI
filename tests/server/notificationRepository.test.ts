import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

import { supabaseAdmin } from '../../server/src/services/supabase';
import {
  countUnread,
  createNotification,
  listNotifications,
  markAllRead,
  markRead,
} from '../../server/src/services/notifications/repository';

/**
 * Phase 14 — `assistant_notifications` repository against the in-memory
 * Supabase fake. Asserts user-scoping, the unread count, the read mutations, and
 * list filters/pagination. No network or live database.
 */

const fake = supabaseAdmin as unknown as FakeSupabaseClient;

function rows(): FakeRow[] {
  return fake.__store.assistant_notifications ?? [];
}

function seed(seeded: FakeRow[]): void {
  fake.__store.assistant_notifications = seeded;
}

function notification(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'n-1',
    user_id: 'user-1',
    type: 'reminder',
    title: 'Reminder',
    body: 'Body',
    channel: 'in_app',
    status: 'unread',
    task_id: null,
    notion_url: null,
    metadata: null,
    created_at: '2026-01-01T00:00:00.000Z',
    read_at: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
  fake.__queries.length = 0;
});

describe('createNotification', () => {
  it('inserts an unread in_app row owned by the user', async () => {
    const created = await createNotification('user-1', {
      type: 'reminder',
      title: 'Reminder: Write report',
      body: 'Due today',
      taskId: 'task-1',
    });

    expect(created).toMatchObject({
      user_id: 'user-1',
      type: 'reminder',
      title: 'Reminder: Write report',
      body: 'Due today',
      channel: 'in_app',
      status: 'unread',
      task_id: 'task-1',
      metadata: null,
    });
    expect(rows()).toHaveLength(1);
  });
});

describe('countUnread', () => {
  it('counts only the caller\'s unread rows', async () => {
    seed([
      notification({ id: 'a', user_id: 'user-1', status: 'unread' }),
      notification({ id: 'b', user_id: 'user-1', status: 'unread' }),
      notification({ id: 'c', user_id: 'user-1', status: 'read' }),
      notification({ id: 'd', user_id: 'user-2', status: 'unread' }),
    ]);

    expect(await countUnread('user-1')).toBe(2);
  });
});

describe('listNotifications', () => {
  it('scopes by user, filters, and paginates with a cursor', async () => {
    seed([
      notification({ id: 'old', created_at: '2026-01-01T00:00:00.000Z', type: 'system' }),
      notification({ id: 'mid', created_at: '2026-02-01T00:00:00.000Z', type: 'reminder' }),
      notification({ id: 'new', created_at: '2026-03-01T00:00:00.000Z', type: 'reminder' }),
      notification({ id: 'foreign', user_id: 'user-2', created_at: '2026-04-01T00:00:00.000Z' }),
    ]);

    const firstPage = await listNotifications('user-1', { limit: 2 });

    expect(firstPage.notifications.map((n) => n.id)).toEqual(['new', 'mid']);
    expect(firstPage.nextCursor).toBe('2026-02-01T00:00:00.000Z');

    const secondPage = await listNotifications('user-1', {
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(secondPage.notifications.map((n) => n.id)).toEqual(['old']);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('filters by status and type', async () => {
    seed([
      notification({ id: 'a', type: 'reminder', status: 'unread' }),
      notification({ id: 'b', type: 'follow_up', status: 'unread' }),
      notification({ id: 'c', type: 'reminder', status: 'read' }),
    ]);

    const unreadReminders = await listNotifications('user-1', {
      status: 'unread',
      type: 'reminder',
    });

    expect(unreadReminders.notifications.map((n) => n.id)).toEqual(['a']);
  });

  it('never returns another user\'s notifications', async () => {
    seed([notification({ id: 'foreign', user_id: 'user-2' })]);

    const result = await listNotifications('user-1');

    expect(result.notifications).toEqual([]);
  });
});

describe('markRead', () => {
  it('marks an owned row read and returns it', async () => {
    seed([notification({ id: 'n-1', user_id: 'user-1', status: 'unread' })]);

    const updated = await markRead('user-1', 'n-1');

    expect(updated?.status).toBe('read');
    expect(typeof updated?.read_at).toBe('string');
  });

  it('returns null for a row owned by another user (indistinguishable from missing)', async () => {
    seed([notification({ id: 'n-1', user_id: 'user-2', status: 'unread' })]);

    expect(await markRead('user-1', 'n-1')).toBeNull();
    expect(rows()[0].status).toBe('unread');
  });
});

describe('markAllRead', () => {
  it('marks every unread row of the caller read and returns the count', async () => {
    seed([
      notification({ id: 'a', user_id: 'user-1', status: 'unread' }),
      notification({ id: 'b', user_id: 'user-1', status: 'unread' }),
      notification({ id: 'c', user_id: 'user-1', status: 'read' }),
      notification({ id: 'd', user_id: 'user-2', status: 'unread' }),
    ]);

    expect(await markAllRead('user-1')).toBe(2);

    const byId = new Map(rows().map((row) => [row.id as string, row]));
    expect(byId.get('a')?.status).toBe('read');
    expect(byId.get('b')?.status).toBe('read');
    // Another user's row is untouched.
    expect(byId.get('d')?.status).toBe('unread');
  });
});
