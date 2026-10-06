import { selectFollowUpCandidates } from '../../server/src/services/followup/candidates';
import { updateFollowUpFields } from '../../server/src/services/followup/repository';
import { dispatchNotification } from '../../server/src/services/notifications';
import { writeAuditLog } from '../../server/src/services/audit/auditLog';
import {
  processFollowUps,
  buildFollowUpCard,
  buildFollowUpNotification,
} from '../../server/src/services/followup/engine';
import type { FollowUpCandidate } from '../../server/src/services/followup/candidates';
import type { TaskRecord } from '../../server/src/services/tasks/repository';

/**
 * Phase 15 — follow-up engine tick. Candidate selection, the notification
 * dispatcher, the repository writer and the audit writer are mocked; no
 * Supabase, no network, no timers.
 */

jest.mock('../../server/src/services/followup/candidates', () => ({
  selectFollowUpCandidates: jest.fn(),
}));
jest.mock('../../server/src/services/followup/repository', () => ({
  updateFollowUpFields: jest.fn(),
}));
jest.mock('../../server/src/services/notifications', () => ({
  dispatchNotification: jest.fn(),
}));
jest.mock('../../server/src/services/audit/auditLog', () => ({
  writeAuditLog: jest.fn(),
}));

const mockSelect = selectFollowUpCandidates as jest.Mock;
const mockUpdate = updateFollowUpFields as jest.Mock;
const mockDispatch = dispatchNotification as jest.Mock;
const mockAudit = writeAuditLog as jest.Mock;

const NOW = new Date('2026-10-06T09:00:00.000Z');

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
    due_time: '20:00',
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

function makeCandidate(kind: 'due_soon' | 'overdue', overrides: Partial<TaskRecord> = {}): FollowUpCandidate {
  const hoursUntilDue = kind === 'overdue' ? -30 : 11;
  return {
    task: makeTask(overrides),
    kind,
    dueAt: new Date(NOW.getTime() + hoursUntilDue * 3600000),
    hoursUntilDue,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdate.mockResolvedValue(null);
  mockAudit.mockResolvedValue(null);
  mockDispatch.mockResolvedValue({
    results: [{ channel: 'in_app', status: 'sent' }],
    delivered: 1,
    failed: 0,
    skipped: 0,
    unknown: 0,
  });
});

describe('buildFollowUpCard', () => {
  it('builds a due_soon card with progress actions', () => {
    const card = buildFollowUpCard(makeCandidate('due_soon'));
    expect(card).toMatchObject({
      type: 'follow_up',
      kind: 'due_soon',
      taskId: 'task-1',
      actions: ['completed', 'in_progress', 'blocked', 'need_more_time'],
    });
    expect(card.prompt).toMatch(/is due .*How is it going\?/);
  });

  it('builds an overdue card with reschedule actions', () => {
    const card = buildFollowUpCard(makeCandidate('overdue'));
    expect(card).toMatchObject({
      type: 'follow_up',
      kind: 'overdue',
      actions: ['mark_completed', 'continue_working', 'move_deadline'],
    });
    expect(card.prompt).toMatch(/was due .*Would you like to:/);
    expect(card.dueLabel).toBe('yesterday');
  });

  it('carries the card into the notification payload', () => {
    const notification = buildFollowUpNotification(makeCandidate('due_soon'));
    expect(notification.type).toBe('follow_up');
    expect(notification.cards).toHaveLength(1);
    expect(notification.cards?.[0]).toMatchObject({ type: 'follow_up', kind: 'due_soon' });
  });
});

describe('processFollowUps', () => {
  it('dispatches a follow-up, records counters, and audits', async () => {
    mockSelect.mockResolvedValue([makeCandidate('due_soon')]);

    const result = await processFollowUps(NOW, 50);

    expect(result).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        type: 'follow_up',
        taskId: 'task-1',
        cards: [expect.objectContaining({ type: 'follow_up' })],
      }),
      { channels: ['in_app'] }
    );
    expect(mockUpdate).toHaveBeenCalledWith('user-1', 'task-1', {
      last_follow_up_at: NOW.toISOString(),
      follow_up_count: 1,
      awaiting_follow_up: true,
    });
    expect(mockAudit).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ action: 'follow_up_sent', toolName: 'follow_up_engine' })
    );
  });

  it('increments the existing follow_up_count', async () => {
    mockSelect.mockResolvedValue([makeCandidate('overdue', { follow_up_count: 1 })]);
    await processFollowUps(NOW);
    expect(mockUpdate).toHaveBeenCalledWith(
      'user-1',
      'task-1',
      expect.objectContaining({ follow_up_count: 2 })
    );
  });

  it('isolates a per-item dispatch failure and continues the tick', async () => {
    mockSelect.mockResolvedValue([
      makeCandidate('due_soon', { id: 'task-1' }),
      makeCandidate('overdue', { id: 'task-2', user_id: 'user-1' }),
    ]);
    mockDispatch
      .mockResolvedValueOnce({ results: [], delivered: 0, failed: 1, skipped: 0, unknown: 0 })
      .mockResolvedValueOnce({ results: [{ channel: 'in_app', status: 'sent' }], delivered: 1, failed: 0, skipped: 0, unknown: 0 });

    const result = await processFollowUps(NOW);

    expect(result).toMatchObject({ processed: 2, sent: 1, failed: 1 });
    expect(mockAudit).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ action: 'follow_up_failed' })
    );
  });

  it('treats a state-write failure as a failure (does not count as sent)', async () => {
    mockSelect.mockResolvedValue([makeCandidate('due_soon')]);
    mockUpdate.mockRejectedValue(new Error('db down'));

    const result = await processFollowUps(NOW);

    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(mockAudit).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ action: 'follow_up_failed' })
    );
  });

  it('never throws when candidate selection fails', async () => {
    mockSelect.mockRejectedValue(new Error('database down'));
    await expect(processFollowUps(NOW)).resolves.toMatchObject({ processed: 0, sent: 0 });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('respects the hard per-tick cap', async () => {
    mockSelect.mockResolvedValue([
      makeCandidate('due_soon', { id: 'a' }),
      makeCandidate('due_soon', { id: 'b' }),
      makeCandidate('due_soon', { id: 'c' }),
    ]);

    const result = await processFollowUps(NOW, 2);

    expect(result.processed).toBe(2);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });
});
