import request from 'supertest';
import { createApp } from '../../server/src/app';
import { createChatCompletion } from '../../server/src/services/ai/provider';
import { AiServiceError } from '../../server/src/services/ai/errors';
import { getOrCreateConversation, appendMessage } from '../../server/src/services/conversations';

/**
 * Phase 18 — AI failure matrix at the assistant route.
 *
 * The provider is mocked so each failure shape can be injected directly (or, for
 * unparseable output, produced by feeding the REAL extractor junk). Every case
 * must degrade to a safe, human message and must never leak the raw provider
 * payload, the API key or a stack trace.
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

jest.mock('../../server/src/services/conversations', () => ({
  getConversation: jest.fn(),
  getOrCreateConversation: jest.fn(),
  appendMessage: jest.fn(),
  listMessages: jest.fn(),
  listConversations: jest.fn(),
}));

jest.mock('../../server/src/services/ai/provider', () => ({
  createChatCompletion: jest.fn(),
}));

const mockChat = createChatCompletion as jest.Mock;
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

function postAssistant(content: string) {
  return request(createApp()).post('/api/assistant/messages').send({ content, messages: [] });
}

/** Assert a response body carries only a safe string and no internals. */
function expectNoLeak(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(/stack|at Object\.|node_modules|Bearer|sk-secret/i);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrCreateConversation.mockResolvedValue(CONVERSATION);
  mockAppendMessage.mockResolvedValue({ id: 'msg-1' });
});

describe('assistant AI failures', () => {
  it('maps a provider HTTP error to a safe 502 and hides the provider payload', async () => {
    mockChat.mockRejectedValue(
      new AiServiceError('upstream 500 sk-secret raw provider body', 'provider_error')
    );

    const response = await postAssistant('Create a task');

    expect(response.status).toBe(502);
    expect(response.body.error).toBe("I couldn't process that right now. Please try again.");
    expect(response.body.error).not.toMatch(/upstream|sk-secret|500/i);
    expectNoLeak(response.body);
  });

  it('maps a network failure to a safe 502', async () => {
    mockChat.mockRejectedValue(
      new AiServiceError('Could not reach the AI provider.', 'network_error')
    );

    const response = await postAssistant('Create a task');

    expect(response.status).toBe(502);
    expect(response.body.error).toBe("I couldn't process that right now. Please try again.");
    expectNoLeak(response.body);
  });

  it('maps unparseable model output (after the single retry) to a safe 502', async () => {
    mockChat.mockResolvedValue('THIS IS RAW_MODEL_OUTPUT_SENTINEL and not JSON');

    const response = await postAssistant('Hello there');

    expect(response.status).toBe(502);
    expect(response.body.error).toBe("I couldn't understand that request. Please try rephrasing it.");
    // The extractor retried exactly once before giving up.
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(response.body)).not.toContain('RAW_MODEL_OUTPUT_SENTINEL');
    expectNoLeak(response.body);
  });

  it('maps schema-invalid JSON (after the retry) to a safe 502', async () => {
    mockChat.mockResolvedValue(JSON.stringify({ intent: 'create_task' }));

    const response = await postAssistant('Add a task');

    expect(response.status).toBe(502);
    expect(response.body.error).toBe("I couldn't understand that request. Please try rephrasing it.");
    expect(mockChat).toHaveBeenCalledTimes(2);
    expectNoLeak(response.body);
  });

  it('maps an unconfigured AI to 503', async () => {
    mockChat.mockRejectedValue(
      new AiServiceError('The AI assistant is not configured.', 'not_configured')
    );

    const response = await postAssistant('Hello');

    expect(response.status).toBe(503);
    expect(response.body.error).toBeTruthy();
    expectNoLeak(response.body);
  });

  it('never includes a stack trace or raw output on any failure shape', async () => {
    for (const failure of [
      new AiServiceError('boom', 'provider_error'),
      new AiServiceError('down', 'network_error'),
    ]) {
      mockChat.mockRejectedValue(failure);
      const response = await postAssistant('anything');
      expect(response.body).not.toHaveProperty('stack');
      expectNoLeak(response.body);
    }
  });
});
