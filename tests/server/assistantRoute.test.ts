import request from 'supertest';
import { createApp } from '../../server/src/app';
import { createChatCompletion } from '../../server/src/services/ai/provider';
import { AiServiceError } from '../../server/src/services/ai/errors';
import {
  appendMessage,
  getOrCreateConversation,
  listMessages,
} from '../../server/src/services/conversations';
import { selectDatabase } from '../../server/src/services/notion/databaseSelection';
import { resolveTask } from '../../server/src/services/tasks/resolveTask';

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

// Pretend the profile lookup succeeds and returns a non-UTC timezone.
jest.mock('../../server/src/services/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: { timezone: 'Africa/Lagos' }, error: null }),
    })),
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

// No real AI provider call in tests.
jest.mock('../../server/src/services/ai/provider', () => ({
  createChatCompletion: jest.fn(),
}));

// Database selection is mocked so card enrichment is deterministic and no
// Supabase mapping table is touched.
jest.mock('../../server/src/services/notion/databaseSelection', () => ({
  selectDatabase: jest.fn(),
}));

// Phase 11: task resolution is mocked so no mirror/DB is touched.
jest.mock('../../server/src/services/tasks/resolveTask', () => ({
  resolveTask: jest.fn(),
}));

const mockCreateChatCompletion = createChatCompletion as jest.Mock;
const mockGetOrCreateConversation = getOrCreateConversation as jest.Mock;
const mockAppendMessage = appendMessage as jest.Mock;
const mockListMessages = listMessages as jest.Mock;
const mockSelectDatabase = selectDatabase as jest.Mock;
const mockResolveTask = resolveTask as jest.Mock;

const CONVERSATION = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'user-1',
  title: null,
  last_message_at: null,
  created_at: '2026-10-02T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
};

const createTaskJson = JSON.stringify({
  intent: 'create_task',
  reply: 'I have prepared this task.',
  confidence: 0.9,
  task: {
    title: 'Write report',
    due_date: '2026-10-03',
    due_time: '17:00',
    priority: 'high',
    category: 'Work Tasks',
    description: null,
  },
});

const clarifyJson = JSON.stringify({
  intent: 'clarify',
  reply: 'What date and time should I remind you?',
  confidence: 0.55,
  message: 'What date and time should I remind you?',
  missing_information: ['datetime'],
});

function postAssistant(body: Record<string, unknown>, query = '') {
  return request(createApp()).post(`/api/assistant/messages${query}`).send(body);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrCreateConversation.mockResolvedValue(CONVERSATION);
  mockAppendMessage.mockResolvedValue({ id: 'msg-1' });
  mockListMessages.mockResolvedValue([]);
  mockSelectDatabase.mockResolvedValue({
    status: 'selected',
    databaseId: 'db-work',
    title: 'Work Tasks',
    purpose: 'work',
    source: 'purpose',
  });
});

describe('POST /api/assistant/messages', () => {
  it('returns 200 with an assistant message, a task card, and the conversationId', async () => {
    mockCreateChatCompletion.mockResolvedValue(createTaskJson);

    const response = await postAssistant({
      content: 'Create a task to write my report tomorrow at 5pm',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(response.status).toBe(200);
    expect(response.body.conversationId).toBe(CONVERSATION.id);
    expect(response.body.message.role).toBe('assistant');
    expect(response.body.message.content).toBe('I have prepared this task.');
    expect(response.body.message.cards).toHaveLength(1);
    expect(response.body.message.cards[0]).toMatchObject({
      type: 'task',
      title: 'Write report',
      priority: 'high',
      task: expect.objectContaining({ title: 'Write report', category: 'Work Tasks' }),
      // Phase 10: the resolved Notion database is attached to the preview card.
      database: { id: 'db-work', title: 'Work Tasks' },
    });
  });

  it('persists the user message and the assistant reply (cards as jsonb)', async () => {
    mockCreateChatCompletion.mockResolvedValue(createTaskJson);

    await postAssistant({ content: 'Create a task for my report', messages: [] });

    expect(mockGetOrCreateConversation).toHaveBeenCalledWith('user-1', undefined);
    expect(mockAppendMessage).toHaveBeenNthCalledWith(1, 'user-1', CONVERSATION.id, {
      role: 'user',
      content: 'Create a task for my report',
    });
    expect(mockAppendMessage).toHaveBeenNthCalledWith(2, 'user-1', CONVERSATION.id, {
      role: 'assistant',
      content: 'I have prepared this task.',
      cards: expect.any(Array),
    });
  });

  it('reuses the conversationId supplied as a query parameter', async () => {
    mockCreateChatCompletion.mockResolvedValue(clarifyJson);

    await postAssistant(
      { content: 'And now?', messages: [] },
      `?conversationId=${CONVERSATION.id}`
    );

    expect(mockGetOrCreateConversation).toHaveBeenCalledWith('user-1', CONVERSATION.id);
    expect(mockListMessages).not.toHaveBeenCalled();
  });

  it('uses stored messages as history when the client omits messages', async () => {
    mockCreateChatCompletion.mockResolvedValue(clarifyJson);
    mockListMessages.mockResolvedValue([
      {
        id: 'stored-1',
        conversation_id: CONVERSATION.id,
        user_id: 'user-1',
        role: 'user',
        content: 'Earlier question',
        cards: null,
        created_at: '2026-10-02T09:00:00.000Z',
      },
    ]);

    const response = await postAssistant({ content: 'And now?' });

    expect(response.status).toBe(200);
    expect(mockListMessages).toHaveBeenCalledWith(
      'user-1',
      CONVERSATION.id,
      expect.any(Number)
    );

    const providerRequest = mockCreateChatCompletion.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    // Phase 17: untrusted history and the new user turn are sanitized and
    // wrapped in DATA-ONLY delimiters before reaching the provider.
    expect(
      providerRequest.messages.some((message) => message.content.includes('Earlier question'))
    ).toBe(true);
    expect(
      providerRequest.messages.some((message) => message.content.includes('UNTRUSTED_DATA'))
    ).toBe(true);
    const lastMessage = providerRequest.messages[providerRequest.messages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain('And now?');
  });

  it('returns 200 with a clarifying question and no card when a date is missing', async () => {
    mockCreateChatCompletion.mockResolvedValue(clarifyJson);

    const response = await postAssistant({ content: 'Remind me to finish my report' });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toMatch(/remind/i);
    expect(response.body.message.cards).toBeUndefined();
  });

  it('returns 400 for empty or invalid content', async () => {
    const empty = await postAssistant({ content: '' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('Invalid request body');

    const wrongType = await postAssistant({ content: 42 });
    expect(wrongType.status).toBe(400);
  });

  it('returns 502 with a safe message when the provider fails', async () => {
    mockCreateChatCompletion.mockRejectedValue(
      new AiServiceError('upstream boom with secret details', 'provider_error')
    );

    const response = await postAssistant({ content: 'Create a task' });

    expect(response.status).toBe(502);
    expect(typeof response.body.error).toBe('string');
    // The raw provider error must never leak to the caller.
    expect(response.body.error).not.toMatch(/boom|secret/i);
  });

  it('returns 503 when the AI is not configured', async () => {
    mockCreateChatCompletion.mockRejectedValue(
      new AiServiceError('The AI assistant is not configured.', 'not_configured')
    );

    const response = await postAssistant({ content: 'Hello' });

    expect(response.status).toBe(503);
    expect(response.body.error).toBeTruthy();
  });

  it('still answers the assistant when conversation persistence fails', async () => {
    mockCreateChatCompletion.mockResolvedValue(createTaskJson);
    mockGetOrCreateConversation.mockRejectedValue(new Error('database down'));

    const response = await postAssistant({ content: 'Create a task' });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toBe('I have prepared this task.');
    // No conversation could be resolved, so none is returned.
    expect(response.body.conversationId).toBeUndefined();
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('asks which database when the choice is ambiguous (confirmation card with candidates)', async () => {
    mockCreateChatCompletion.mockResolvedValue(createTaskJson);
    mockSelectDatabase.mockResolvedValue({
      status: 'needs_choice',
      candidates: [
        { databaseId: 'db-a', title: 'Work Tasks', purpose: 'work', isDefault: false },
        { databaseId: 'db-b', title: 'Personal', purpose: 'personal', isDefault: false },
      ],
    });

    const response = await postAssistant({ content: 'Create a task' });

    expect(response.status).toBe(200);
    expect(response.body.message.cards).toHaveLength(1);
    expect(response.body.message.cards[0]).toMatchObject({
      type: 'confirmation',
      prompt: 'Which database should I use for this task?',
    });
    expect(response.body.message.cards[0].candidates).toHaveLength(2);
  });

  it('keeps the task preview (no database) when selection fails (best-effort)', async () => {
    mockCreateChatCompletion.mockResolvedValue(createTaskJson);
    mockSelectDatabase.mockRejectedValue(new Error('supabase down'));

    const response = await postAssistant({ content: 'Create a task' });

    expect(response.status).toBe(200);
    expect(response.body.message.cards[0]).toMatchObject({ type: 'task' });
    expect(response.body.message.cards[0].database).toBeUndefined();
  });
});

/**
 * Phase 18 — missing information. A `clarify` intent is conversational only: it
 * must produce a question, emit NO card, and never trigger a database lookup,
 * task resolution or any write.
 */
const multiMissingJson = JSON.stringify({
  intent: 'clarify',
  reply: 'I need a title and a due date before I can create that.',
  confidence: 0.5,
  message: 'What is the task, and when is it due?',
  missing_information: ['title', 'due_date'],
});

describe('POST /api/assistant/messages — missing information', () => {
  it('asks for every missing field with no card and no side effects', async () => {
    mockCreateChatCompletion.mockResolvedValue(multiMissingJson);

    const response = await postAssistant({ content: 'Add a task' });

    expect(response.status).toBe(200);
    expect(response.body.message.cards).toBeUndefined();
    expect(response.body.message.content).toMatch(/title and a due date/i);
    // A clarify intent never resolves a database or a task.
    expect(mockSelectDatabase).not.toHaveBeenCalled();
    expect(mockResolveTask).not.toHaveBeenCalled();
  });

  it('never emits a reminder card when the datetime is missing', async () => {
    mockCreateChatCompletion.mockResolvedValue(clarifyJson);

    const response = await postAssistant({ content: 'Remind me about the report' });

    expect(response.status).toBe(200);
    expect(response.body.message.cards).toBeUndefined();
    expect(mockSelectDatabase).not.toHaveBeenCalled();
  });
});

/** Minimal TaskRecord shape used by the (mocked) resolver's candidates. */
function taskRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    user_id: 'user-1',
    notion_page_id: 'page-1',
    notion_database_id: 'db-1',
    notion_url: null,
    title: 'Write report',
    description: null,
    category: 'Work',
    priority: 'medium',
    status: 'in_progress',
    due_date: '2026-10-03',
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

const updateIntentJson = JSON.stringify({
  intent: 'update_task',
  reply: 'Sure, I can change the priority.',
  confidence: 0.9,
  task_identifier: 'report',
  changes: { priority: 'high' },
});

const completeIntentJson = JSON.stringify({
  intent: 'complete_task',
  reply: 'Marking that as done.',
  confidence: 0.9,
  task_identifier: 'report',
});

describe('POST /api/assistant/messages — task update flows', () => {
  it('returns a task_update card when the task resolves', async () => {
    mockCreateChatCompletion.mockResolvedValue(updateIntentJson);
    mockResolveTask.mockResolvedValue({ status: 'found', task: taskRecord() });

    const response = await postAssistant({ content: 'Change the priority to high.' });

    expect(response.status).toBe(200);
    expect(mockResolveTask).toHaveBeenCalledWith('user-1', 'report');
    expect(response.body.message.cards).toHaveLength(1);
    expect(response.body.message.cards[0]).toMatchObject({
      type: 'task_update',
      taskId: 'task-1',
      targetTask: 'Write report',
      action: 'update_task',
      changes: { priority: 'high' },
      actions: ['confirm', 'cancel'],
    });
  });

  it('proposes completion with the complete_task action', async () => {
    mockCreateChatCompletion.mockResolvedValue(completeIntentJson);
    mockResolveTask.mockResolvedValue({ status: 'found', task: taskRecord() });

    const response = await postAssistant({ content: 'Mark it completed.' });

    expect(response.body.message.cards[0]).toMatchObject({
      type: 'task_update',
      action: 'complete_task',
      changes: { status: 'completed' },
    });
  });

  it('returns a task_select card with candidates when ambiguous', async () => {
    mockCreateChatCompletion.mockResolvedValue(updateIntentJson);
    mockResolveTask.mockResolvedValue({
      status: 'ambiguous',
      candidates: [
        taskRecord({ id: 't-a', title: 'Report alpha' }),
        taskRecord({ id: 't-b', title: 'Report beta' }),
      ],
    });

    const response = await postAssistant({ content: 'Change the priority to high.' });

    expect(response.status).toBe(200);
    expect(response.body.message.cards).toHaveLength(1);
    expect(response.body.message.cards[0]).toMatchObject({
      type: 'task_select',
      action: 'update_task',
      changes: { priority: 'high' },
    });
    expect(response.body.message.cards[0].candidates).toEqual([
      expect.objectContaining({ taskId: 't-a', title: 'Report alpha' }),
      expect.objectContaining({ taskId: 't-b', title: 'Report beta' }),
    ]);
  });

  it('asks for clarification (no card) when the task is not found', async () => {
    mockCreateChatCompletion.mockResolvedValue(updateIntentJson);
    mockResolveTask.mockResolvedValue({ status: 'not_found' });

    const response = await postAssistant({ content: 'Change the priority to high.' });

    expect(response.status).toBe(200);
    expect(response.body.message.cards).toBeUndefined();
    expect(response.body.message.content).toMatch(/couldn't find/i);
  });
});
