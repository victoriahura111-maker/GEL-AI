import request from 'supertest';
import { createApp } from '../../server/src/app';
import {
  cancelReminder,
  createReminder,
  getReminderById,
  listRemindersForUser,
  rescheduleReminder,
} from '../../server/src/services/reminders/repository';
import { getTaskById, listTasks } from '../../server/src/services/tasks/repository';

/**
 * Phase 13 — `/api/reminders` route contract. Auth is injected and the
 * repositories are mocked; nothing touches Supabase.
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

jest.mock('../../server/src/services/reminders/repository', () => ({
  listRemindersForUser: jest.fn(),
  getReminderById: jest.fn(),
  createReminder: jest.fn(),
  cancelReminder: jest.fn(),
  rescheduleReminder: jest.fn(),
}));

jest.mock('../../server/src/services/tasks/repository', () => ({
  getTaskById: jest.fn(),
  listTasks: jest.fn(),
}));

const mockListForUser = listRemindersForUser as jest.Mock;
const mockGetReminder = getReminderById as jest.Mock;
const mockCreate = createReminder as jest.Mock;
const mockCancel = cancelReminder as jest.Mock;
const mockReschedule = rescheduleReminder as jest.Mock;
const mockGetTask = getTaskById as jest.Mock;
const mockListTasks = listTasks as jest.Mock;

const app = createApp();

const REMINDER = {
  id: 'rem-1',
  task_id: 'task-1',
  user_id: 'user-1',
  scheduled_for: '2026-10-07T08:00:00.000Z',
  timezone: 'UTC',
  channel: 'in_app',
  status: 'pending' as const,
  recurrence: null,
  sent_at: null,
  failure_reason: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

const TASK = {
  id: 'task-1',
  user_id: 'user-1',
  title: 'Write report',
  due_date: '2026-12-05',
  due_time: '17:00',
  status: 'not_started',
  notion_url: 'https://www.notion.so/page-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockListForUser.mockResolvedValue([REMINDER]);
  mockGetReminder.mockResolvedValue(REMINDER);
  mockListTasks.mockResolvedValue([TASK]);
  mockGetTask.mockResolvedValue(TASK);
  mockCreate.mockResolvedValue(REMINDER);
  mockCancel.mockResolvedValue({ ...REMINDER, status: 'cancelled' });
  mockReschedule.mockResolvedValue({ ...REMINDER, scheduled_for: '2026-12-04T17:00:00.000Z' });
});

describe('GET /api/reminders', () => {
  it('lists the caller reminders with the default recent+upcoming window and task enrichment', async () => {
    const response = await request(app).get('/api/reminders');

    expect(response.status).toBe(200);
    expect(response.body.reminders).toHaveLength(1);
    expect(response.body.reminders[0]).toMatchObject({
      id: 'rem-1',
      task: { id: 'task-1', title: 'Write report' },
    });
    expect(mockListForUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) })
    );
  });

  it('passes a status filter through', async () => {
    await request(app).get('/api/reminders?status=pending');

    expect(mockListForUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ status: 'pending' })
    );
  });

  it('returns 400 for an invalid query', async () => {
    const response = await request(app).get('/api/reminders?status=bogus');
    expect(response.status).toBe(400);
    expect(mockListForUser).not.toHaveBeenCalled();
  });
});

describe('POST /api/reminders/:id/cancel', () => {
  it('cancels an owned reminder', async () => {
    const response = await request(app).post('/api/reminders/rem-1/cancel');

    expect(response.status).toBe(200);
    expect(response.body.reminder.status).toBe('cancelled');
    expect(mockCancel).toHaveBeenCalledWith('user-1', 'rem-1');
  });

  it('returns 404 when the reminder is not owned/found', async () => {
    mockCancel.mockResolvedValue(null);
    const response = await request(app).post('/api/reminders/rem-9/cancel');

    expect(response.status).toBe(404);
  });
});

describe('POST /api/reminders/:id/reschedule', () => {
  it('reschedules to an absolute time', async () => {
    mockReschedule.mockResolvedValue({
      ...REMINDER,
      scheduled_for: '2999-01-01T10:00:00.000Z',
    });

    const response = await request(app)
      .post('/api/reminders/rem-1/reschedule')
      .send({ scheduledFor: '2999-01-01T10:00:00.000Z' });

    expect(response.status).toBe(200);
    expect(response.body.reminder.scheduled_for).toBe('2999-01-01T10:00:00.000Z');
    expect(mockReschedule).toHaveBeenCalledWith('rem-1', '2999-01-01T10:00:00.000Z', 'UTC');
  });

  it('reschedules in before-mode resolved against the task deadline', async () => {
    const response = await request(app)
      .post('/api/reminders/rem-1/reschedule')
      .send({ before: '1 day', timezone: 'UTC' });

    expect(response.status).toBe(200);
    expect(mockReschedule).toHaveBeenCalledWith('rem-1', '2026-12-04T17:00:00.000Z', 'UTC');
    expect(mockGetReminder).toHaveBeenCalledWith('user-1', 'rem-1');
    expect(mockGetTask).toHaveBeenCalledWith('user-1', 'task-1');
  });

  it('returns 404 when the reminder is not found', async () => {
    mockGetReminder.mockResolvedValue(null);
    const response = await request(app)
      .post('/api/reminders/rem-9/reschedule')
      .send({ datetime: '2999-01-01T10:00' });

    expect(response.status).toBe(404);
  });

  it('returns 400 for an invalid payload', async () => {
    const empty = await request(app).post('/api/reminders/rem-1/reschedule').send({});
    expect(empty.status).toBe(400);

    const badOffset = await request(app)
      .post('/api/reminders/rem-1/reschedule')
      .send({ before: 'sometime' });
    expect(badOffset.status).toBe(400);
  });

  it('returns 400 for a date-time in the past', async () => {
    const response = await request(app)
      .post('/api/reminders/rem-1/reschedule')
      .send({ datetime: '2000-01-01T10:00:00.000Z' });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/reminders', () => {
  it('creates a reminder for an owned task via an absolute time', async () => {
    const response = await request(app)
      .post('/api/reminders')
      .send({ taskId: 'task-1', datetime: '2999-01-01T10:00', timezone: 'UTC' });

    expect(response.status).toBe(201);
    expect(mockGetTask).toHaveBeenCalledWith('user-1', 'task-1');
    expect(mockCreate).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        taskId: 'task-1',
        scheduledFor: '2999-01-01T10:00:00.000Z',
        channel: 'in_app',
      })
    );
    expect(response.body.reminder.task).toMatchObject({ id: 'task-1' });
  });

  it('creates a reminder via a relative offset', async () => {
    await request(app)
      .post('/api/reminders')
      .send({ taskId: 'task-1', before: '2 hours', timezone: 'UTC' });

    expect(mockCreate).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ scheduledFor: '2026-12-05T15:00:00.000Z' })
    );
  });

  it('returns 404 when the task is not owned/found', async () => {
    mockGetTask.mockResolvedValue(null);
    const response = await request(app)
      .post('/api/reminders')
      .send({ taskId: 'foreign', datetime: '2999-01-01T10:00' });

    expect(response.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid payload', async () => {
    const missing = await request(app).post('/api/reminders').send({ taskId: 'task-1' });
    expect(missing.status).toBe(400);

    const badOffset = await request(app)
      .post('/api/reminders')
      .send({ taskId: 'task-1', before: 'whenever' });
    expect(badOffset.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
