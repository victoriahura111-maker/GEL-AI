import request from 'supertest';
import { createApp } from '../../server/src/app';

// The authenticate middleware would 503/401 based on Supabase; mock it so the
// controllers are exercised directly with a fixed caller.
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

// Mutable Supabase admin mock so one test can simulate "unconfigured" (503).
let mockSupabaseAdmin: unknown = {};
jest.mock('../../server/src/services/supabase', () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin;
  },
}));

// Mock the tasks service barrel (controller's import target) but keep the real
// TaskQueryError class so the 400 mapping behaves exactly like production.
jest.mock('../../server/src/services/tasks', () => {
  const query = jest.requireActual('../../server/src/services/tasks/query');
  return {
    getTaskById: jest.fn(),
    getTaskSummary: jest.fn(),
    getTasksGrouped: jest.fn(),
    listTasksForUser: jest.fn(),
    TaskQueryError: query.TaskQueryError,
  };
});

// Database-name enrichment joins the caller's Notion mappings; mock it.
jest.mock('../../server/src/services/notion', () => ({ listMappings: jest.fn() }));

import {
  getTaskById,
  getTaskSummary,
  getTasksGrouped,
  listTasksForUser,
  TaskQueryError,
} from '../../server/src/services/tasks';
import { listMappings } from '../../server/src/services/notion';

const mockListTasksForUser = listTasksForUser as jest.Mock;
const mockGetTaskSummary = getTaskSummary as jest.Mock;
const mockGetTasksGrouped = getTasksGrouped as jest.Mock;
const mockGetTaskById = getTaskById as jest.Mock;
const mockListMappings = listMappings as jest.Mock;

const TASK = {
  id: 'a1b2c3d4-e5f6-4a7b-8c9d-e1f2a3b4c5d6',
  user_id: 'user-1',
  notion_database_id: 'db-1',
  notion_url: 'https://notion.so/task',
  title: 'Write report',
  status: 'not_started',
  due_date: '2026-10-06',
  due_time: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabaseAdmin = {};
  mockListMappings.mockResolvedValue([]);
});

describe('task routes', () => {
  describe('GET /api/tasks', () => {
    it('returns the caller-scoped task list', async () => {
      mockListTasksForUser.mockResolvedValue([TASK]);

      const response = await request(createApp()).get('/api/tasks');

      expect(response.status).toBe(200);
      expect(response.body.tasks).toHaveLength(1);
      expect(mockListTasksForUser).toHaveBeenCalledWith('user-1', expect.anything());
    });

    it('passes the query filters through to the service', async () => {
      mockListTasksForUser.mockResolvedValue([]);

      await request(createApp()).get('/api/tasks').query({ status: 'completed', limit: 10 });

      expect(mockListTasksForUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ status: 'completed', limit: '10' })
      );
    });

    it('attaches the resolved Notion database name', async () => {
      mockListTasksForUser.mockResolvedValue([TASK]);
      mockListMappings.mockResolvedValue([
        { notionDatabaseId: 'db-1', databaseTitle: 'Work Tasks' },
      ]);

      const response = await request(createApp()).get('/api/tasks');

      expect(response.body.tasks[0].notion_database_name).toBe('Work Tasks');
    });

    it('maps invalid filters to 400', async () => {
      mockListTasksForUser.mockRejectedValue(new TaskQueryError('bad filters'));

      const response = await request(createApp()).get('/api/tasks').query({ status: 'nope' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid query parameters');
    });
  });

  describe('GET /api/tasks/summary', () => {
    it('returns the summary shape', async () => {
      mockGetTaskSummary.mockResolvedValue({
        counts: {
          today: 1,
          upcoming: 2,
          overdue: 3,
          inProgress: 4,
          awaitingUpdate: 5,
          completed: 6,
        },
        generatedAt: '2026-10-06T10:00:00.000Z',
        timezone: 'Africa/Lagos',
      });

      const response = await request(createApp()).get('/api/tasks/summary');

      expect(response.status).toBe(200);
      expect(response.body.counts).toEqual({
        today: 1,
        upcoming: 2,
        overdue: 3,
        inProgress: 4,
        awaitingUpdate: 5,
        completed: 6,
      });
      expect(response.body.timezone).toBe('Africa/Lagos');
    });
  });

  describe('GET /api/tasks/grouped', () => {
    it('returns the bucketed lists', async () => {
      mockGetTasksGrouped.mockResolvedValue({
        buckets: {
          today: [TASK],
          upcoming: [],
          overdue: [],
          inProgress: [],
          awaitingUpdate: [],
          completed: [],
        },
        generatedAt: '2026-10-06T10:00:00.000Z',
        timezone: 'UTC',
      });

      const response = await request(createApp()).get('/api/tasks/grouped');

      expect(response.status).toBe(200);
      expect(response.body.buckets.today).toHaveLength(1);
      expect(response.body.buckets.completed).toEqual([]);
    });
  });

  describe('GET /api/tasks/:id', () => {
    it('returns the owned task', async () => {
      mockGetTaskById.mockResolvedValue(TASK);

      const response = await request(createApp()).get(`/api/tasks/${TASK.id}`);

      expect(response.status).toBe(200);
      expect(response.body.task.id).toBe(TASK.id);
      expect(mockGetTaskById).toHaveBeenCalledWith('user-1', TASK.id);
    });

    it('returns 404 when the task is missing (or owned by another user)', async () => {
      mockGetTaskById.mockResolvedValue(null);

      const response = await request(createApp()).get(`/api/tasks/${TASK.id}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });
  });

  it('returns 503 for every route when Supabase is unconfigured', async () => {
    mockSupabaseAdmin = null;

    const listResponse = await request(createApp()).get('/api/tasks');
    const summaryResponse = await request(createApp()).get('/api/tasks/summary');

    expect(listResponse.status).toBe(503);
    expect(summaryResponse.status).toBe(503);
    expect(mockListTasksForUser).not.toHaveBeenCalled();
  });
});
