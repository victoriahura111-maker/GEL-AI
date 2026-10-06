import {
  claimReminder,
  createReminder,
  listDueReminders,
  markReminderFailed,
  markReminderSent,
} from '../../server/src/services/reminders/repository';
import { getTaskById } from '../../server/src/services/tasks/repository';
import { getNotificationService } from '../../server/src/services/notifications';
import { writeAuditLog } from '../../server/src/services/audit/auditLog';
import { processDueReminders } from '../../server/src/services/reminders/engine';
import type { ReminderRecord } from '../../server/src/services/reminders/repository';
import type { TaskRecord } from '../../server/src/services/tasks/repository';

/**
 * Phase 13 — reminder engine tick. Repositories, the notification service and the
 * audit writer are mocked; no Supabase, no timers.
 */

jest.mock('../../server/src/services/reminders/repository', () => ({
  listDueReminders: jest.fn(),
  claimReminder: jest.fn(),
  markReminderSent: jest.fn(),
  markReminderFailed: jest.fn(),
  createReminder: jest.fn(),
}));

jest.mock('../../server/src/services/tasks/repository', () => ({
  getTaskById: jest.fn(),
}));

jest.mock('../../server/src/services/notifications', () => ({
  getNotificationService: jest.fn(),
}));

jest.mock('../../server/src/services/audit/auditLog', () => ({
  writeAuditLog: jest.fn(),
}));

const mockListDue = listDueReminders as jest.Mock;
const mockClaim = claimReminder as jest.Mock;
const mockMarkSent = markReminderSent as jest.Mock;
const mockMarkFailed = markReminderFailed as jest.Mock;
const mockCreateReminder = createReminder as jest.Mock;
const mockGetTask = getTaskById as jest.Mock;
const mockGetService = getNotificationService as jest.Mock;
const mockAudit = writeAuditLog as jest.Mock;

const NOW = new Date('2026-10-06T09:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const sendMock = jest.fn();

function makeReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: 'rem-1',
    task_id: 'task-1',
    user_id: 'user-1',
    scheduled_for: '2026-10-06T08:00:00.000Z',
    timezone: 'UTC',
    channel: 'in_app',
    status: 'pending',
    recurrence: null,
    sent_at: null,
    failure_reason: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    user_id: 'user-1',
    notion_page_id: 'page-1',
    notion_database_id: 'db-1',
    notion_url: 'https://www.notion.so/page-1',
    title: 'Write report',
    description: null,
    category: null,
    priority: 'high',
    status: 'not_started',
    due_date: '2026-10-06',
    due_time: '17:00',
    timezone: 'UTC',
    source_of_change: 'assistant',
    sync_status: 'synced',
    last_synced_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sendMock.mockResolvedValue(undefined);
  mockGetService.mockReturnValue({ send: sendMock });
  mockMarkSent.mockResolvedValue(null);
  mockMarkFailed.mockResolvedValue(null);
  mockCreateReminder.mockResolvedValue(null);
  mockAudit.mockResolvedValue(null);
});

describe('processDueReminders', () => {
  it('claims, dispatches, marks sent, and audits a due reminder', async () => {
    const reminder = makeReminder();
    mockListDue.mockResolvedValue([reminder]);
    mockClaim.mockResolvedValue({ ...reminder, status: 'sent' });
    mockGetTask.mockResolvedValue(makeTask());

    const result = await processDueReminders(NOW, 50);

    expect(result).toMatchObject({ processed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(mockClaim).toHaveBeenCalledWith('rem-1');
    expect(mockGetService).toHaveBeenCalledWith('in_app');
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        type: 'reminder',
        taskId: 'task-1',
        notionUrl: 'https://www.notion.so/page-1',
        title: expect.stringMatching(/Write report/),
        body: expect.stringMatching(/2026-10-06 at 17:00/),
      })
    );
    expect(mockMarkSent).toHaveBeenCalledWith('rem-1', NOW_ISO);
    expect(mockAudit).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ action: 'reminder_sent', toolName: 'reminder_engine' })
    );
  });

  it('marks a reminder failed with the reason when dispatch rejects', async () => {
    const reminder = makeReminder();
    mockListDue.mockResolvedValue([reminder]);
    mockClaim.mockResolvedValue(reminder);
    mockGetTask.mockResolvedValue(makeTask());
    sendMock.mockRejectedValue(new Error('channel down'));

    const result = await processDueReminders(NOW);

    expect(result).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(mockMarkFailed).toHaveBeenCalledWith('rem-1', 'channel down');
    expect(mockMarkSent).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ action: 'reminder_failed' })
    );
  });

  it('marks a reminder failed when the related task is missing', async () => {
    const reminder = makeReminder();
    mockListDue.mockResolvedValue([reminder]);
    mockClaim.mockResolvedValue(reminder);
    mockGetTask.mockResolvedValue(null);

    const result = await processDueReminders(NOW);

    expect(result).toMatchObject({ failed: 1, sent: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith('rem-1', expect.stringMatching(/not found/i));
  });

  it('skips a reminder another tick already claimed (idempotency)', async () => {
    const reminder = makeReminder();
    mockListDue.mockResolvedValue([reminder]);
    mockClaim.mockResolvedValue(null);

    const result = await processDueReminders(NOW);

    expect(result).toMatchObject({ processed: 1, skipped: 1, sent: 0, failed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('creates the next occurrence for a recurring reminder', async () => {
    const reminder = makeReminder({ recurrence: 'daily' });
    mockListDue.mockResolvedValue([reminder]);
    mockClaim.mockResolvedValue(reminder);
    mockGetTask.mockResolvedValue(makeTask());

    const result = await processDueReminders(NOW);

    expect(result).toMatchObject({ sent: 1, recurrencesScheduled: 1 });
    expect(mockCreateReminder).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        taskId: 'task-1',
        scheduledFor: '2026-10-07T08:00:00.000Z',
        recurrence: 'daily',
        channel: 'in_app',
      })
    );
  });

  it('stops recurrence when the task is completed or cancelled', async () => {
    const reminder = makeReminder({ recurrence: 'daily' });
    mockListDue.mockResolvedValue([reminder]);
    mockClaim.mockResolvedValue(reminder);
    mockGetTask.mockResolvedValue(makeTask({ status: 'completed' }));

    const result = await processDueReminders(NOW);

    expect(result).toMatchObject({ failed: 1, sent: 0, recurrencesScheduled: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(mockCreateReminder).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith('rem-1', expect.stringMatching(/completed/i));
  });

  it('never throws out of the tick when loading due reminders fails', async () => {
    mockListDue.mockRejectedValue(new Error('database down'));

    await expect(processDueReminders(NOW)).resolves.toMatchObject({ processed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('never throws out of the tick when claiming fails', async () => {
    const reminder = makeReminder();
    mockListDue.mockResolvedValue([reminder]);
    mockClaim.mockRejectedValue(new Error('claim failed'));

    await expect(processDueReminders(NOW)).resolves.toMatchObject({ processed: 1, failed: 1 });
  });
});
