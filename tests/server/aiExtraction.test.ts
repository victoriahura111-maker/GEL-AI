import { extractIntent } from '../../server/src/services/ai/extractor';
import { createChatCompletion } from '../../server/src/services/ai/provider';
import { IntentExtractionError } from '../../server/src/services/ai/errors';
import { intentToCards } from '../../server/src/services/ai/toCards';
import { buildIntentSystemPrompt } from '../../server/src/services/ai/prompts';

// The provider is the only place that talks HTTP. Mock it so no real AI call is
// ever made; the tests control the exact model output.
jest.mock('../../server/src/services/ai/provider', () => ({
  createChatCompletion: jest.fn(),
}));

const mockCreateChatCompletion = createChatCompletion as jest.Mock;

const nowIso = '2026-10-02T18:35:00.000Z';
const timezone = 'Africa/Lagos';

type ProviderRequest = {
  messages: Array<{ role: string; content: string }>;
  jsonMode?: boolean;
};

function firstProviderRequest(): ProviderRequest {
  return mockCreateChatCompletion.mock.calls[0][0] as ProviderRequest;
}

const createTaskJson = JSON.stringify({
  intent: 'create_task',
  reply: 'I have prepared this task.',
  confidence: 0.92,
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
  confidence: 0.6,
  message: 'What date and time should I remind you?',
  missing_information: ['datetime'],
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('extractIntent', () => {
  it('parses a valid create_task payload and maps it to a task card', async () => {
    mockCreateChatCompletion.mockResolvedValue(createTaskJson);

    const intent = await extractIntent({
      content: 'Create a task to write my report tomorrow at 5pm',
      timezone,
      nowIso,
    });

    expect(intent.intent).toBe('create_task');

    const cards = intentToCards(intent);
    expect(cards).toHaveLength(1);
    // Phase 10: the card carries the structured, confirm-ready payload. The
    // resolved Notion database ref is attached later by the controller (not by
    // `intentToCards`), so it must not appear here.
    expect(cards?.[0]).toMatchObject({
      type: 'task',
      title: 'Write report',
      priority: 'high',
      task: {
        title: 'Write report',
        dueDate: '2026-10-03',
        dueTime: '17:00',
        priority: 'high',
        category: 'Work Tasks',
        description: null,
      },
    });
    expect((cards?.[0] as { database?: unknown }).database).toBeUndefined();
    expect(cards?.[0].actions).toEqual(['create', 'edit', 'cancel']);
  });

  it('tolerates code-fenced JSON', async () => {
    mockCreateChatCompletion.mockResolvedValue('```json\n' + createTaskJson + '\n```');

    const intent = await extractIntent({ content: 'add a task', timezone, nowIso });

    expect(intent.intent).toBe('create_task');
    expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('produces a clarify intent carrying missing_information and emits no card', async () => {
    mockCreateChatCompletion.mockResolvedValue(clarifyJson);

    const intent = await extractIntent({
      content: 'Remind me to finish my report',
      timezone,
      nowIso,
    });

    expect(intent.intent).toBe('clarify');
    if (intent.intent === 'clarify') {
      expect(intent.missing_information).toEqual(['datetime']);
      expect(intent.message).toMatch(/remind/i);
    }
    expect(intentToCards(intent)).toBeUndefined();
  });

  it('retries once on invalid AI JSON and then throws a typed error', async () => {
    mockCreateChatCompletion.mockResolvedValue('this is not json');

    await expect(
      extractIntent({ content: 'hello', timezone, nowIso })
    ).rejects.toBeInstanceOf(IntentExtractionError);

    expect(mockCreateChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('retries once when valid JSON fails schema validation, then throws', async () => {
    mockCreateChatCompletion.mockResolvedValue(JSON.stringify({ intent: 'create_task' }));

    await expect(
      extractIntent({ content: 'hello', timezone, nowIso })
    ).rejects.toBeInstanceOf(IntentExtractionError);

    expect(mockCreateChatCompletion).toHaveBeenCalledTimes(2);
    const retryMessages = (mockCreateChatCompletion.mock.calls[1][0] as ProviderRequest).messages;
    expect(retryMessages.some((message) => /schema/i.test(message.content))).toBe(true);
  });

  it('instructs the model not to invent data and includes the current date and timezone', async () => {
    mockCreateChatCompletion.mockResolvedValue(createTaskJson);

    await extractIntent({ content: 'anything', timezone, nowIso });

    const request = firstProviderRequest();
    expect(request.jsonMode).toBe(true);

    const systemPrompt = request.messages.find((message) => message.role === 'system')?.content ?? '';
    expect(systemPrompt).toContain('NEVER invent');
    expect(systemPrompt).toContain(nowIso);
    expect(systemPrompt).toContain(timezone);
    expect(systemPrompt).toContain('create_task');
    expect(systemPrompt).toContain('clarify');
    expect(systemPrompt.toLowerCase()).toContain('missing_information');
  });
});

describe('buildIntentSystemPrompt', () => {
  it('includes the date/time, timezone, no-invention rule, injection warning, and intent list', () => {
    const prompt = buildIntentSystemPrompt({ timezone, nowIso });

    expect(prompt).toContain(nowIso);
    expect(prompt).toContain(timezone);
    expect(prompt).toContain('NEVER invent');
    expect(prompt).toContain('DATA');
    expect(prompt).toContain('create_task');
    expect(prompt).toContain('general');
  });
});
