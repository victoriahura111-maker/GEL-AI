import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../../server/src/app';
import type { FakeSupabaseClient } from './supabaseFake';

/**
 * Phase 17 — cross-user isolation.
 *
 * Two users exist (`user-a` the caller, `user-b` the victim). The `authenticate`
 * middleware is swapped for a header-driven stub so the caller's identity can be
 * switched per request. `supabaseAdmin` is replaced with the in-memory fake so
 * the *real* repositories run and their `user_id` scoping is genuinely
 * exercised: a query that forgot to scope would visibly return `user-b`'s rows.
 *
 * Notion-dependent endpoints rely on the fact that `user-a` has no connection,
 * so they resolve (409/empty) without any network call.
 */

jest.mock('../../server/src/middleware/authenticate', () => ({
  authenticate: (
    req: { headers: Record<string, unknown>; user?: unknown },
    _res: unknown,
    next: () => void
  ) => {
    const header = req.headers['x-test-user'];
    (req as { user?: unknown }).user = {
      id: typeof header === 'string' ? header : 'user-a',
      email: 'caller@example.com',
    };
    next();
  },
}));

jest.mock('../../server/src/services/supabase', () => {
  const { createSupabaseFake } = jest.requireActual('./supabaseFake');
  return { supabaseAdmin: createSupabaseFake() };
});

import { supabaseAdmin } from '../../server/src/services/supabase';

const store = (supabaseAdmin as unknown as FakeSupabaseClient).__store;

const TASK_B = 'task-b-1';
const REMINDER_B = 'reminder-b-1';
const NOTIFICATION_B = 'notification-b-1';
const CONVERSATION_B = '22222222-2222-4222-8222-222222222222';
const DB_RAW = '11112222333344445555666677778888';
const DB_ID = '11112222-3333-4444-5555-666677778888';
const B_SENTINEL = 'B-SECRET-SENTINEL';

function seedUserB(): void {
  for (const key of Object.keys(store)) delete store[key];
  const now = '2026-01-01T00:00:00.000Z';

  store['assistant_tasks'] = [
    {
      id: TASK_B,
      user_id: 'user-b',
      notion_page_id: null,
      notion_database_id: DB_ID,
      notion_url: null,
      title: B_SENTINEL,
      description: null,
      category: null,
      priority: 'high',
      status: 'not_started',
      due_date: null,
      due_time: null,
      timezone: null,
      source_of_change: null,
      sync_status: null,
      last_synced_at: null,
      created_at: now,
      updated_at: now,
    },
  ];

  store['assistant_reminders'] = [
    {
      id: REMINDER_B,
      user_id: 'user-b',
      task_id: TASK_B,
      scheduled_for: now,
      timezone: null,
      channel: 'in_app',
      status: 'pending',
      recurrence: null,
      sent_at: null,
      failure_reason: null,
      created_at: now,
      updated_at: now,
    },
  ];

  store['assistant_notifications'] = [
    {
      id: NOTIFICATION_B,
      user_id: 'user-b',
      type: 'task_due',
      title: B_SENTINEL,
      body: null,
      channel: 'in_app',
      status: 'unread',
      task_id: TASK_B,
      notion_url: null,
      metadata: null,
      created_at: now,
      read_at: null,
      updated_at: now,
    },
  ];

  store['assistant_conversations'] = [
    {
      id: CONVERSATION_B,
      user_id: 'user-b',
      title: B_SENTINEL,
      last_message_at: null,
      created_at: now,
      updated_at: now,
    },
  ];

  store['assistant_messages'] = [
    {
      id: 'message-b-1',
      conversation_id: CONVERSATION_B,
      user_id: 'user-b',
      role: 'user',
      content: B_SENTINEL,
      cards: null,
      created_at: now,
    },
  ];

  store['notion_connections'] = [
    {
      id: 'connection-b-1',
      user_id: 'user-b',
      access_token_encrypted: 'v1:aa:bb:cc',
      bot_id: null,
      workspace_id: 'ws-b',
      workspace_name: B_SENTINEL,
      workspace_icon: null,
      owner: null,
      created_at: now,
      updated_at: now,
    },
  ];

  store['notion_database_mappings'] = [
    {
      id: 'mapping-b-1',
      user_id: 'user-b',
      notion_database_id: DB_ID,
      database_title: B_SENTINEL,
      purpose: 'work',
      is_default: true,
      created_at: now,
      updated_at: now,
    },
  ];
}

const app = createApp();

/** Sends a request as `user-a` (the caller) unless overridden. */
function as(user: string, method: 'get' | 'post' | 'put' | 'delete', path: string): Test {
  const agent = request(app);
  return agent[method](path).set('x-test-user', user);
}

beforeEach(() => {
  seedUserB();
});

describe('cross-user isolation', () => {
  describe('tasks', () => {
    it('lists only the caller\u2019s tasks', async () => {
      const response = await as('user-a', 'get', '/api/tasks');

      expect(response.status).toBe(200);
      expect(response.body.tasks).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });

    it('returns 404 for another user\u2019s task', async () => {
      const response = await as('user-a', 'get', `/api/tasks/${TASK_B}`);

      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });
  });

  describe('reminders', () => {
    it('lists only the caller\u2019s reminders', async () => {
      const response = await as('user-a', 'get', '/api/reminders');

      expect(response.status).toBe(200);
      expect(response.body.reminders).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });

    it('cannot cancel another user\u2019s reminder (404) and leaves it untouched', async () => {
      const response = await as('user-a', 'post', `/api/reminders/${REMINDER_B}/cancel`);

      expect(response.status).toBe(404);
      const reminder = store['assistant_reminders'].find((row) => row.id === REMINDER_B);
      expect(reminder?.status).toBe('pending');
    });
  });

  describe('conversations', () => {
    it('lists only the caller\u2019s conversations', async () => {
      const response = await as('user-a', 'get', '/api/conversations');

      expect(response.status).toBe(200);
      expect(response.body.conversations).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });

    it('returns 404 for another user\u2019s conversation messages', async () => {
      const response = await as('user-a', 'get', `/api/conversations/${CONVERSATION_B}/messages`);

      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });
  });

  describe('notifications', () => {
    it('lists only the caller\u2019s notifications', async () => {
      const response = await as('user-a', 'get', '/api/notifications');

      expect(response.status).toBe(200);
      expect(response.body.notifications).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });

    it('reports zero unread for the caller', async () => {
      const response = await as('user-a', 'get', '/api/notifications/unread-count');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ count: 0 });
    });

    it('cannot mark another user\u2019s notification read (404)', async () => {
      const response = await as('user-a', 'post', `/api/notifications/${NOTIFICATION_B}/read`);

      expect(response.status).toBe(404);
      const notification = store['assistant_notifications'].find((row) => row.id === NOTIFICATION_B);
      expect(notification?.status).toBe('unread');
    });
  });

  describe('notion', () => {
    it('reports the caller as disconnected even though another user is connected', async () => {
      const response = await as('user-a', 'get', '/api/notion/connection');

      expect(response.status).toBe(200);
      expect(response.body.connected).toBe(false);
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });

    it('cannot disconnect another user\u2019s connection', async () => {
      const response = await as('user-a', 'delete', '/api/notion/connection');

      expect(response.status).toBe(200);
      expect(store['notion_connections'].some((row) => row.user_id === 'user-b')).toBe(true);
    });

    it('cannot list another user\u2019s notion databases (no connection → 409)', async () => {
      const response = await as('user-a', 'get', '/api/notion/databases');

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });

    it('cannot read another user\u2019s database schema (no connection → 409)', async () => {
      const response = await as('user-a', 'get', `/api/notion/databases/${DB_RAW}/schema`);

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });

    it('writes a caller-scoped mapping without touching another user\u2019s mapping', async () => {
      const response = await as('user-a', 'put', `/api/notion/databases/${DB_RAW}/mapping`).send({
        purpose: 'personal',
        isDefault: false,
      });

      expect(response.status).toBe(200);
      expect(response.body.mapping.purpose).toBe('personal');

      const userIds = store['notion_database_mappings'].map((row) => row.user_id);
      expect(userIds).toContain('user-a');
      const victim = store['notion_database_mappings'].find((row) => row.user_id === 'user-b');
      expect(victim?.database_title).toBe(B_SENTINEL);
      expect(victim?.purpose).toBe('work');
    });
  });

  describe('sync', () => {
    it('cannot run a sync for another user\u2019s connection (409)', async () => {
      const response = await as('user-a', 'post', '/api/sync');

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });

    it('returns only the caller\u2019s sync status', async () => {
      const response = await as('user-a', 'get', '/api/sync/status');

      expect(response.status).toBe(200);
      expect(response.body.counts).toEqual({ synced: 0, pending: 0, error: 0 });
      expect(JSON.stringify(response.body)).not.toContain(B_SENTINEL);
    });
  });
});
