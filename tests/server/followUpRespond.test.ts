import { getTaskById } from '../../server/src/services/tasks/repository';
import { applyTaskUpdate } from '../../server/src/services/tasks/updateTask';
import { updateFollowUpFields } from '../../server/src/services/followup/repository';
import { writeAuditLog } from '../../server/src/services/audit/auditLog';
import { handleFollowUpResponse } from '../../server/src/services/followup/respond';
import type { TaskRecord } from '../../server/src/services/tasks/repository';

/**
 * Phase 15 — follow-up response handling. Task lookups, the update
 * orchestrator, the follow-up writer and the audit writer are mocked.
 */

jest.mock('../../server/src/services/tasks/repository', () => ({
  getTaskById: jest.fn(),
}));
jest.mock('../../server/src/services/tasks/updateTask', () => ({
  applyTaskUpdate: jest.fn(),
}));
jest.mock('../../server/src/services/followup/repository', () => ({
  updateFollowUpFields: jest.fn(),
}));
jest.mock('../../server/src/services/audit/auditLog', () => ({
  writeAuditLog: jest.fn(),
}));

const mockGetTask = getTaskById as jest.Mock;
const mockApplyUpdate = applyTaskUpdate as jest.Mock;
const mockUpdate = updateFollowUpFields as jest.Mock;
const mockAudit = writeAuditLog as jest.Mock;

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
    source_of_change: null,
    sync_status: null,
    last_synced_at: null,
    follow_up_count: 1,
    last_follow_up_at: '2026-10-05T00:00:00.000Z',
    awaiting_follow_up: true,
    blocking_reason: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTask.mockResolvedValue(makeTask());
  mockUpdate.mockResolvedValue(null);
  mockAudit.mockResolvedValue(null);
  mockApplyUpdate.mockResolvedValue({
    status: 'updated',
    task: makeTask(),
    notion: { id: 'page-1', url: 'https://www.notion.so/page-1' },
    warnings: [],
  });
});

describe('handleFollowUpResponse', () => {
  it('completes a task, clears awaiting_follow_up, and audits', async () => {
    const result = await handleFollowUpResponse('user-1', { taskId: 'task-1', response: 'completed' });

    expect(result.status).toBe('ok');
    expect(mockApplyUpdate).toHaveBeenCalledWith('user-1', 'task-1', { status: 'completed' });
    expect(mockUpdate).toHaveBeenCalledWith('user-1', 'task-1', { awaiting_follow_up: false });
    expect(mockAudit).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ action: 'follow_up_response', toolName: 'follow_up_response' })
    );
  });

  it('moves a task to in_progress for both continue verbs', async () => {
    await handleFollowUpResponse('user-1', { taskId: 'task-1', response: 'in_progress' });
    expect(mockApplyUpdate).toHaveBeenCalledWith('user-1', 'task-1', { status: 'in_progress' });

    mockApplyUpdate.mockClear();
    const result = await handleFollowUpResponse('user-1', { taskId: 'task-1', response: 'continue_working' });
    expect(mockApplyUpdate).toHaveBeenCalledWith('user-1', 'task-1', { status: 'in_progress' });
    expect(result.status).toBe('ok');
  });

  it('blocks a task and stores the supplied reason', async () => {
    const result = await handleFollowUpResponse('user-1', {
      taskId: 'task-1',
      response: 'blocked',
      reason: 'waiting on review',
    });

    expect(mockApplyUpdate).toHaveBeenCalledWith('user-1', 'task-1', { status: 'blocked' });
    expect(mockUpdate).toHaveBeenCalledWith('user-1', 'task-1', {
      awaiting_follow_up: false,
      blocking_reason: 'waiting on review',
    });
    expect(result.status === 'ok' && result.message).toMatch(/waiting on review/);
  });

  it('asks "What is blocking you?" when no reason was supplied', async () => {
    const result = await handleFollowUpResponse('user-1', { taskId: 'task-1', response: 'blocked' });
    expect(mockUpdate).toHaveBeenCalledWith('user-1', 'task-1', {
      awaiting_follow_up: false,
      blocking_reason: null,
    });
    expect(result.status === 'ok' && result.message).toMatch(/what is blocking you\?/i);
  });

  it('moves the deadline for need_more_time (date-only clears the time)', async () => {
    const result = await handleFollowUpResponse('user-1', {
      taskId: 'task-1',
      response: 'need_more_time',
      newDeadline: '2026-10-12',
    });

    expect(result.status).toBe('ok');
    expect(mockApplyUpdate).toHaveBeenCalledWith('user-1', 'task-1', {
      dueDate: '2026-10-12',
      dueTime: null,
      timezone: 'UTC',
    });
    expect(mockUpdate).toHaveBeenCalledWith('user-1', 'task-1', { awaiting_follow_up: false });
    expect(result.status === 'ok' && result.message).toMatch(/2026-10-12/);
  });

  it('moves the deadline for move_deadline with a time', async () => {
    await handleFollowUpResponse('user-1', {
      taskId: 'task-1',
      response: 'move_deadline',
      newDeadline: '2026-10-12T17:30',
    });

    expect(mockApplyUpdate).toHaveBeenCalledWith('user-1', 'task-1', {
      dueDate: '2026-10-12',
      dueTime: '17:30',
      timezone: 'UTC',
    });
  });

  it('asks for a deadline when none was supplied', async () => {
    const result = await handleFollowUpResponse('user-1', { taskId: 'task-1', response: 'move_deadline' });
    expect(result.status).toBe('needs_deadline');
    expect(mockApplyUpdate).not.toHaveBeenCalled();
  });

  it('rejects an unparseable deadline', async () => {
    const result = await handleFollowUpResponse('user-1', {
      taskId: 'task-1',
      response: 'move_deadline',
      newDeadline: 'sometime soon',
    });
    expect(result.status).toBe('invalid_deadline');
    expect(mockApplyUpdate).not.toHaveBeenCalled();
  });

  it('returns not_found when the task is missing (ownership enforced)', async () => {
    mockGetTask.mockResolvedValue(null);
    const result = await handleFollowUpResponse('user-1', { taskId: 'foreign', response: 'completed' });
    expect(result.status).toBe('not_found');
    expect(mockApplyUpdate).not.toHaveBeenCalled();
  });
});
