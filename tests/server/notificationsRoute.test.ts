import request from 'supertest';
import { createApp } from '../../server/src/app';
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
} from '../../server/src/services/notifications/repository';

/**
 * Phase 14 — `/api/notifications` route contract. Auth is injected and the
 * repository is mocked; nothing touches Supabase. The `supabaseAdmin` module is
 * mocked with a mutable getter so the "unconfigured → 503" path is exercisable.
 */

jest.mock('../../server/src/middleware/authenticate', () => ({
  authenticate: (
    req: { user?: { id: string; email: string | null } },
    _res: unknown,
    next: () => void
  ) => {
    req.user = { id: 'user-1', email: 'ada@example.com' };
    next();
  },
}));

let mockAdminValue: unknown = { fake: true };
jest.mock('../../server/src/services/supabase', () => ({
  get supabaseAdmin() {
    return mockAdminValue;
  },
}));

jest.mock('../../server/src/services/notifications/repository', () => ({
  listNotifications: jest.fn(),
  countUnread: jest.fn(),
  markRead: jest.fn(),
  markAllRead: jest.fn(),
}));

const mockList = listNotifications as jest.Mock;
const mockCount = countUnread as jest.Mock;
const mockMarkRead = markRead as jest.Mock;
const mockMarkAllRead = markAllRead as jest.Mock;

const app = createApp();

const RECORD = {
  id: 'n-1',
  user_id: 'user-1',
  type: 'reminder',
  title: 'Reminder: Write report',
  body: 'Due today',
  channel: 'in_app',
  status: 'unread' as const,
  task_id: 'task-1',
  notion_url: null,
  metadata: { reminderId: 'rem-1' },
  created_at: '2026-10-06T00:00:00.000Z',
  read_at: null,
  updated_at: '2026-10-06T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminValue = { fake: true };
  mockList.mockResolvedValue({ notifications: [RECORD], nextCursor: '2026-10-06T00:00:00.000Z' });
  mockCount.mockResolvedValue(4);
  mockMarkRead.mockResolvedValue({ ...RECORD, status: 'read', read_at: '2026-10-06T01:00:00.000Z' });
  mockMarkAllRead.mockResolvedValue(3);
});

describe('GET /api/notifications', () => {
  it('lists the caller notifications without leaking user_id or metadata', async () => {
    const response = await request(app).get('/api/notifications');

    expect(response.status).toBe(200);
    expect(response.body.nextCursor).toBe('2026-10-06T00:00:00.000Z');
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0]).toMatchObject({
      id: 'n-1',
      type: 'reminder',
      title: 'Reminder: Write report',
      status: 'unread',
      task_id: 'task-1',
    });
    expect(response.body.notifications[0]).not.toHaveProperty('user_id');
    expect(response.body.notifications[0]).not.toHaveProperty('metadata');
    expect(mockList).toHaveBeenCalledWith('user-1', {});
  });

  it('passes filters through', async () => {
    await request(app).get('/api/notifications?status=read&type=system&limit=5');

    expect(mockList).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ status: 'read', type: 'system', limit: 5 })
    );
  });

  it('returns 400 for an invalid query', async () => {
    const response = await request(app).get('/api/notifications?status=bogus');

    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns 503 when Supabase is unconfigured', async () => {
    mockAdminValue = null;

    const response = await request(app).get('/api/notifications');

    expect(response.status).toBe(503);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('returns the unread count', async () => {
    const response = await request(app).get('/api/notifications/unread-count');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 4 });
    expect(mockCount).toHaveBeenCalledWith('user-1');
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('marks an owned notification read', async () => {
    const response = await request(app).post('/api/notifications/n-1/read');

    expect(response.status).toBe(200);
    expect(response.body.notification).toMatchObject({ id: 'n-1', status: 'read' });
    expect(mockMarkRead).toHaveBeenCalledWith('user-1', 'n-1');
  });

  it('returns 404 when the notification is not owned/found', async () => {
    mockMarkRead.mockResolvedValue(null);

    const response = await request(app).post('/api/notifications/n-9/read');

    expect(response.status).toBe(404);
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks all notifications read and returns the count', async () => {
    const response = await request(app).post('/api/notifications/read-all');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 3 });
    expect(mockMarkAllRead).toHaveBeenCalledWith('user-1');
  });
});
