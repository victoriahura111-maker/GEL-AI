import request from 'supertest';
import { createApp } from '../../server/src/app';
import { createTask } from '../../server/src/services/tasks/createTask';
import { applyTaskUpdate, deleteTask } from '../../server/src/services/tasks/updateTask';
import { updateReminder, cancelReminder } from '../../server/src/services/reminders/repository';
import { handleFollowUpResponse } from '../../server/src/services/followup';
import { NotionApiError } from '../../server/src/services/notion/client';
import { appendMessage, getOrCreateConversation } from '../../server/src/services/conversations';

// Inject an authenticated user without touching Supabase auth.
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

// Persistence is mocked so the route test never touches a database.
jest.mock('../../server/src/services/conversations', () => ({
  getConversation: jest.fn(),
  getOrCreateConversation: jest.fn(),
  appendMessage: jest.fn(),
  listMessages: jest.fn(),
  listConversations: jest.fn(),
}));

// The orchestrator is mocked; the route/controller contract is what is under
// test here. `CreateTaskError` and friends are kept from the real module.
jest.mock('../../server/src/services/tasks/createTask', () => {
  const actual = jest.requireActual('../../server/src/services/tasks/createTask');
  return { ...actual, createTask: jest.fn() };
});

// Phase 11 orchestrators + reminder edits are mocked; the route contract is what
// is under test here.
jest.mock('../../server/src/services/tasks/updateTask', () => {
  const actual = jest.requireActual('../../server/src/services/tasks/updateTask');
  return { ...actual, applyTaskUpdate: jest.fn(), deleteTask: jest.fn() };
});

jest.mock('../../server/src/services/reminders/repository', () => {
  const actual = jest.requireActual('../../server/src/services/reminders/repository');
  return { ...actual, updateReminder: jest.fn(), cancelReminder: jest.fn() };
});

// Phase 15 — the follow-up handler is mocked; the route contract is under test.
jest.mock('../../server/src/services/followup', () => ({
  handleFollowUpResponse: jest.fn(),
}));

const mockCreateTask = createTask as jest.Mock;
const mockApplyTaskUpdate = applyTaskUpdate as jest.Mock;
const mockDeleteTask = deleteTask as jest.Mock;
const mockUpdateReminder = updateReminder as jest.Mock;
const mockCancelReminder = cancelReminder as jest.Mock;
const mockHandleFollowUp = handleFollowUpResponse as jest.Mock;
const mockGetOrCreateConversation = getOrCreateConversation as jest.Mock;
const mockAppendMessage = appendMessage as jest.Mock;

const CONVERSATION = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'user-1',
  title: null,
  last_message_at: null,
  created_at: '2026-10-02T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
};

const TASK = {
  title: 'Write report',
  dueDate: '2026-10-03',
  dueTime: '17:00',
  priority: 'high',
  category: 'Work Tasks',
};

function postAction(body: Record<string, unknown>) {
  return request(createApp()).post('/api/assistant/actions').send(body);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrCreateConversation.mockResolvedValue(CONVERSATION);
  mockAppendMessage.mockResolvedValue({ id: 'msg-1' });
  mockApplyTaskUpdate.mockResolvedValue({
    status: 'updated',
    task: { id: 'task-1', title: 'Write report' },
    notion: { id: 'page-1', url: 'https://www.notion.so/page-1' },
    warnings: [],
  });
  mockDeleteTask.mockResolvedValue({
    status: 'deleted',
    task: { id: 'task-1', title: 'Write report' },
    warnings: [],
  });
  mockUpdateReminder.mockResolvedValue({ id: 'rem-1', status: 'pending' });
  mockCancelReminder.mockResolvedValue({ id: 'rem-1', status: 'cancelled' });
  mockHandleFollowUp.mockResolvedValue({
    status: 'ok',
    task: { id: 'task-1', title: 'Write report' },
    message: "Got it. I've updated the task to In Progress.",
    notionUrl: 'https://www.notion.so/page-1',
  });
});

describe('POST /api/assistant/actions — create_task', () => {
  it('creates the task on confirm and returns 200 with the Notion URL + persisted card', async () => {
    mockCreateTask.mockResolvedValue({
      status: 'created',
      task: { id: 'task-1', title: 'Write report' },
      notion: { id: 'page-1', url: 'https://www.notion.so/page-1' },
      database: { id: 'db-1', title: 'Work Tasks' },
    });

    const response = await postAction({ action: 'create_task', task: TASK });

    expect(response.status).toBe(200);
    expect(response.body.conversationId).toBe(CONVERSATION.id);
    expect(response.body.notionUrl).toBe('https://www.notion.so/page-1');
    expect(response.body.task).toMatchObject({ id: 'task-1' });
    expect(response.body.message.content).toMatch(/Task created/);
    expect(response.body.message.content).toMatch(/Work Tasks/);
    expect(response.body.message.cards[0]).toMatchObject({
      type: 'task',
      notionUrl: 'https://www.notion.so/page-1',
    });

    expect(mockCreateTask).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ title: 'Write report', dueDate: '2026-10-03' }),
      expect.objectContaining({ databaseId: null })
    );

    // The assistant confirmation message is persisted with the card.
    expect(mockAppendMessage).toHaveBeenCalledWith(
      'user-1',
      CONVERSATION.id,
      expect.objectContaining({ role: 'assistant', cards: expect.any(Array) })
    );
  });

  it('passes an explicit databaseId and reminder through to the orchestrator', async () => {
    mockCreateTask.mockResolvedValue({
      status: 'created',
      task: { id: 'task-1', title: 'Write report' },
      notion: { id: 'page-1', url: 'https://www.notion.so/page-1' },
      database: { id: 'db-9', title: 'Chosen' },
    });

    await postAction({
      action: 'create_task',
      task: TASK,
      databaseId: 'db-9',
      reminder: { datetime: '2026-10-03T16:00:00.000Z' },
      conversationId: CONVERSATION.id,
    });

    expect(mockCreateTask).toHaveBeenCalledWith(
      'user-1',
      expect.anything(),
      expect.objectContaining({
        databaseId: 'db-9',
        reminder: expect.objectContaining({ datetime: '2026-10-03T16:00:00.000Z' }),
      })
    );
    expect(mockGetOrCreateConversation).toHaveBeenCalledWith('user-1', CONVERSATION.id);
  });

  it('returns needsDatabase with candidate databases when the choice is ambiguous', async () => {
    mockCreateTask.mockResolvedValue({
      status: 'needs_database',
      candidates: [
        { databaseId: 'db-a', title: 'Work Tasks', purpose: 'work', isDefault: false },
        { databaseId: 'db-b', title: 'Personal', purpose: 'personal', isDefault: false },
      ],
    });

    const response = await postAction({ action: 'create_task', task: TASK });

    expect(response.status).toBe(200);
    expect(response.body.needsDatabase).toBe(true);
    expect(response.body.candidates).toHaveLength(2);
    expect(response.body.message.cards[0]).toMatchObject({
      type: 'confirmation',
      prompt: expect.stringMatching(/which database/i),
    });
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
  });

  it('returns needsDatabase (empty candidates) when no databases are mapped', async () => {
    mockCreateTask.mockResolvedValue({ status: 'no_databases', candidates: [] });

    const response = await postAction({ action: 'create_task', task: TASK });

    expect(response.status).toBe(200);
    expect(response.body.needsDatabase).toBe(true);
    expect(response.body.candidates).toEqual([]);
  });

  it('returns 400 for an invalid action body and never calls the orchestrator', async () => {
    const missingTask = await postAction({ action: 'create_task' });
    expect(missingTask.status).toBe(400);

    const unknownAction = await postAction({ action: 'delete_everything' });
    expect(unknownAction.status).toBe(400);

    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('returns a safe error (no token / raw payload) when Notion rejects', async () => {
    mockCreateTask.mockRejectedValue(
      new NotionApiError('Reconnect Notion to continue.', 'unauthorized', 401)
    );

    const response = await postAction({ action: 'create_task', task: TASK });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/reconnect/i);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|bearer/i);
  });
});

describe('POST /api/assistant/actions — cancel', () => {
  it('acknowledges a cancel benignly and performs no task creation', async () => {
    const response = await postAction({ action: 'cancel' });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toMatch(/no problem/i);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/assistant/actions — update family', () => {
  it('applies an update_task, persists a confirmation, and returns the notion URL', async () => {
    const response = await postAction({
      action: 'update_task',
      taskId: 'task-1',
      changes: { priority: 'high' },
    });

    expect(response.status).toBe(200);
    expect(mockApplyTaskUpdate).toHaveBeenCalledWith('user-1', 'task-1', { priority: 'high' });
    expect(response.body.message.content).toMatch(/updated/i);
    expect(response.body.notionUrl).toBe('https://www.notion.so/page-1');
    expect(response.body.message.cards[0]).toMatchObject({
      type: 'task',
      notionUrl: 'https://www.notion.so/page-1',
    });
    expect(mockAppendMessage).toHaveBeenCalledWith(
      'user-1',
      CONVERSATION.id,
      expect.objectContaining({ role: 'assistant', cards: expect.any(Array) })
    );
  });

  it('completes a task', async () => {
    const response = await postAction({ action: 'complete_task', taskId: 'task-1' });

    expect(response.status).toBe(200);
    expect(mockApplyTaskUpdate).toHaveBeenCalledWith('user-1', 'task-1', { status: 'completed' });
    expect(response.body.message.content).toMatch(/completed/i);
  });

  it('cancels a task', async () => {
    const response = await postAction({ action: 'cancel_task', taskId: 'task-1' });

    expect(response.status).toBe(200);
    expect(mockApplyTaskUpdate).toHaveBeenCalledWith('user-1', 'task-1', { status: 'cancelled' });
    expect(response.body.message.content).toMatch(/cancelled/i);
  });

  it('moves a task to another database', async () => {
    const response = await postAction({
      action: 'move_task',
      taskId: 'task-1',
      databaseId: 'db-2',
    });

    expect(response.status).toBe(200);
    expect(mockApplyTaskUpdate).toHaveBeenCalledWith('user-1', 'task-1', { databaseId: 'db-2' });
    expect(response.body.message.content).toMatch(/moved/i);
  });

  it('returns 404 when the task is not found (ownership enforced)', async () => {
    mockApplyTaskUpdate.mockResolvedValue({ status: 'not_found' });

    const response = await postAction({ action: 'update_task', taskId: 'foreign', changes: {} });

    expect(response.status).toBe(404);
    expect(response.body.error).toBeTruthy();
  });

  it('returns a safe error (no token) when Notion rejects', async () => {
    mockApplyTaskUpdate.mockRejectedValue(
      new NotionApiError('Reconnect Notion to continue.', 'unauthorized', 401)
    );

    const response = await postAction({ action: 'complete_task', taskId: 'task-1' });

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|bearer|token/i);
  });

  it('returns 400 for invalid update payloads', async () => {
    const missingChanges = await postAction({ action: 'update_task', taskId: 'task-1' });
    expect(missingChanges.status).toBe(400);

    const missingTaskId = await postAction({ action: 'complete_task' });
    expect(missingTaskId.status).toBe(400);

    const missingDatabase = await postAction({ action: 'move_task', taskId: 'task-1' });
    expect(missingDatabase.status).toBe(400);

    expect(mockApplyTaskUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/assistant/actions — delete_task', () => {
  it('deletes the task and persists a confirmation', async () => {
    const response = await postAction({ action: 'delete_task', taskId: 'task-1' });

    expect(response.status).toBe(200);
    expect(mockDeleteTask).toHaveBeenCalledWith('user-1', 'task-1');
    expect(response.body.message.content).toMatch(/deleted/i);
    expect(mockAppendMessage).toHaveBeenCalled();
  });

  it('returns 404 when the task is not found', async () => {
    mockDeleteTask.mockResolvedValue({ status: 'not_found' });

    const response = await postAction({ action: 'delete_task', taskId: 'foreign' });

    expect(response.status).toBe(404);
  });
});

describe('POST /api/assistant/actions — reminders', () => {
  it('updates a reminder', async () => {
    const response = await postAction({
      action: 'update_reminder',
      reminderId: 'rem-1',
      scheduledFor: '2026-10-03T16:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(mockUpdateReminder).toHaveBeenCalledWith('user-1', 'rem-1', {
      scheduledFor: '2026-10-03T16:00:00.000Z',
    });
    expect(response.body.message.content).toMatch(/updated the reminder/i);
  });

  it('returns 404 when the reminder is not found', async () => {
    mockUpdateReminder.mockResolvedValue(null);

    const response = await postAction({ action: 'update_reminder', reminderId: 'missing' });

    expect(response.status).toBe(404);
  });

  it('cancels a reminder', async () => {
    const response = await postAction({ action: 'cancel_reminder', reminderId: 'rem-1' });

    expect(response.status).toBe(200);
    expect(mockCancelReminder).toHaveBeenCalledWith('user-1', 'rem-1');
    expect(response.body.message.content).toMatch(/cancelled the reminder/i);
  });

  it('returns 404 when the reminder to cancel is not found', async () => {
    mockCancelReminder.mockResolvedValue(null);

    const response = await postAction({ action: 'cancel_reminder', reminderId: 'missing' });

    expect(response.status).toBe(404);
  });
});

describe('POST /api/assistant/actions — follow-up responses', () => {
  it('answers a follow-up directly and persists a confirmation', async () => {
    const response = await postAction({
      action: 'follow_up_response',
      taskId: 'task-1',
      response: 'in_progress',
    });

    expect(response.status).toBe(200);
    expect(mockHandleFollowUp).toHaveBeenCalledWith('user-1', {
      taskId: 'task-1',
      response: 'in_progress',
      reason: undefined,
    });
    expect(response.body.message.content).toMatch(/In Progress/i);
    expect(mockAppendMessage).toHaveBeenCalledWith(
      'user-1',
      CONVERSATION.id,
      expect.objectContaining({ role: 'assistant' })
    );
  });

  it('stores a blocking reason via follow_up_reason', async () => {
    const response = await postAction({
      action: 'follow_up_reason',
      taskId: 'task-1',
      reason: 'waiting on review',
    });

    expect(response.status).toBe(200);
    expect(mockHandleFollowUp).toHaveBeenCalledWith('user-1', {
      taskId: 'task-1',
      response: 'blocked',
      reason: 'waiting on review',
    });
  });

  it('moves a deadline via follow_up_new_deadline', async () => {
    const response = await postAction({
      action: 'follow_up_new_deadline',
      taskId: 'task-1',
      deadline: '2026-10-12',
    });

    expect(response.status).toBe(200);
    expect(mockHandleFollowUp).toHaveBeenCalledWith('user-1', {
      taskId: 'task-1',
      response: 'move_deadline',
      newDeadline: '2026-10-12',
      timezone: null,
    });
  });

  it('returns 400 when follow_up_new_deadline has no deadline', async () => {
    const response = await postAction({ action: 'follow_up_new_deadline', taskId: 'task-1' });
    expect(response.status).toBe(400);
    expect(mockHandleFollowUp).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid follow-up payload', async () => {
    const badResponse = await postAction({
      action: 'follow_up_response',
      taskId: 'task-1',
      response: 'teleport',
    });
    expect(badResponse.status).toBe(400);

    const missingReason = await postAction({ action: 'follow_up_reason', taskId: 'task-1' });
    expect(missingReason.status).toBe(400);

    expect(mockHandleFollowUp).not.toHaveBeenCalled();
  });

  it('returns 404 when the task is not found (ownership enforced)', async () => {
    mockHandleFollowUp.mockResolvedValue({ status: 'not_found' });

    const response = await postAction({
      action: 'follow_up_response',
      taskId: 'foreign',
      response: 'completed',
    });

    expect(response.status).toBe(404);
  });

  it('surfaces a needs_deadline reply as a normal 200 question', async () => {
    mockHandleFollowUp.mockResolvedValue({
      status: 'needs_deadline',
      message: 'Sure — what date would you like to move it to?',
    });

    const response = await postAction({
      action: 'follow_up_response',
      taskId: 'task-1',
      response: 'move_deadline',
    });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toMatch(/what date/i);
  });

  it('returns a safe error when the follow-up handler rejects', async () => {
    mockHandleFollowUp.mockRejectedValue(new Error('boom'));

    const response = await postAction({
      action: 'follow_up_response',
      taskId: 'task-1',
      response: 'completed',
    });

    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|bearer|token/i);
  });
});

/**
 * Phase 18 — Notion failure mapping on the confirm endpoint. Each upstream shape
 * becomes the documented, user-safe status; the token never surfaces. These
 * complement the single 401 case above.
 */
describe('POST /api/assistant/actions — Notion failure mapping', () => {
  it('maps not_connected to 409 with connect guidance', async () => {
    mockCreateTask.mockRejectedValue(
      new NotionApiError('Connect Notion first.', 'not_connected', null)
    );

    const response = await postAction({ action: 'create_task', task: TASK });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/connect notion/i);
  });

  it('maps forbidden to 409 reconnect guidance on the update family', async () => {
    mockApplyTaskUpdate.mockRejectedValue(
      new NotionApiError('Reconnect Notion to continue.', 'forbidden', 403)
    );

    const response = await postAction({ action: 'cancel_task', taskId: 'task-1' });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/reconnect/i);
  });

  it('maps not_found to 404', async () => {
    mockCreateTask.mockRejectedValue(
      new NotionApiError('That Notion resource could not be found.', 'not_found', 404)
    );

    const response = await postAction({ action: 'create_task', task: TASK });

    expect(response.status).toBe(404);
  });

  it('maps rate_limited to 429', async () => {
    mockCreateTask.mockRejectedValue(
      new NotionApiError(
        'Notion is rate limiting requests. Please try again shortly.',
        'rate_limited',
        429
      )
    );

    const response = await postAction({ action: 'create_task', task: TASK });

    expect(response.status).toBe(429);
    expect(response.body.error).toMatch(/rate limiting/i);
  });

  it.each([
    ['network_error', 'Could not reach Notion. Please try again.'],
    ['invalid_response', 'Notion returned an unreadable response.'],
    ['api_error', 'Notion could not complete the request.'],
  ] as const)('maps %s to a safe 502', async (code, message) => {
    mockCreateTask.mockRejectedValue(new NotionApiError(message, code, null));

    const response = await postAction({ action: 'create_task', task: TASK });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe(message);
    expect(JSON.stringify(response.body)).not.toMatch(/bearer|token|stack/i);
  });
});
