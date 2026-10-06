import request from 'supertest';
import { createApp } from '../../server/src/app';
import { supabaseAdmin } from '../../server/src/services/supabase';
import { createChatCompletion } from '../../server/src/services/ai/provider';
import { upsertConnection } from '../../server/src/services/notion/connectionRepository';
import { clearSchemaCache } from '../../server/src/services/notion/schema';
import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

/**
 * Phase 18 — end-to-end assistant flow (integration).
 *
 * Unlike `assistantRoute.test.ts` (which mocks the create/update orchestrators),
 * this suite wires the REAL assistant controller, intent extractor and task
 * orchestrators to the in-memory PostgREST fake and a routed `fetch` mock. It
 * proves the whole chain — message → intent → preview/selection card → explicit
 * confirm → Notion write + mirror + reminder + audit — works together with no
 * live database or network.
 *
 * The only seams are (a) the AI provider (no real model call) and (b) Notion's
 * HTTP surface (intercepted by `fetch`).
 */

jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

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

// The provider is the only place that talks to a model; control its output.
jest.mock('../../server/src/services/ai/provider', () => ({
  createChatCompletion: jest.fn(),
}));

const mockChat = createChatCompletion as jest.Mock;
const fake = supabaseAdmin as unknown as FakeSupabaseClient;

const TOKEN = 'secret-notion-token';
const DB_COMPACT = 'AB12CD34EF56AB78CD90EF12AB34CD56';
const DB_DASHED = 'ab12cd34-ef56-ab78-cd90-ef12ab34cd56';
const PAGE_A_COMPACT = '11111111222233334444555566667777';
const PAGE_A_DASHED = '11111111-2222-3333-4444-555566667777';
const PAGE_URL = 'https://www.notion.so/new-page';

const ORIGINAL_FETCH = globalThis.fetch;
const fetchMock = jest.fn();

const clarifyJson = JSON.stringify({
  intent: 'clarify',
  reply: 'What date and time should I remind you for?',
  confidence: 0.5,
  message: 'What date and time should I remind you for?',
  missing_information: ['datetime'],
});

const createTaskJson = JSON.stringify({
  intent: 'create_task',
  reply: 'I have prepared this task.',
  confidence: 0.9,
  task: {
    title: 'Write report',
    due_date: '2026-10-07',
    due_time: '17:00',
    priority: 'high',
    category: 'Work Tasks',
    description: null,
  },
  reminder: { enabled: true, datetime: '2026-10-07T16:00:00.000Z', timezone: 'UTC', before: null },
});

const updateTaskJson = JSON.stringify({
  intent: 'update_task',
  reply: 'I can bump the priority.',
  confidence: 0.9,
  task_identifier: 'report',
  changes: { priority: 'high' },
});

function rawDatabase(): Record<string, unknown> {
  return {
    object: 'database',
    id: DB_COMPACT,
    title: [{ plain_text: 'Work Tasks' }],
    properties: {
      Name: { id: 'title-1', type: 'title', title: {} },
      Notes: { id: 'rt-1', type: 'rich_text', rich_text: {} },
      'Due Date': { id: 'date-1', type: 'date', date: {} },
      Status: {
        id: 'status-1',
        type: 'status',
        status: {
          options: [
            { id: 's1', name: 'Not started', color: 'gray' },
            { id: 's2', name: 'In progress', color: 'blue' },
            { id: 's3', name: 'Done', color: 'green' },
            { id: 's4', name: 'Cancelled', color: 'red' },
          ],
        },
      },
      Priority: {
        id: 'select-1',
        type: 'select',
        select: { options: [{ id: 'p1', name: 'High', color: 'red' }] },
      },
      Category: {
        id: 'select-2',
        type: 'select',
        select: { options: [{ id: 'c1', name: 'Work', color: 'blue' }] },
      },
    },
  };
}

/** Routes the Notion calls the orchestrators make (schema GET, page write). */
function installFetch(): void {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET' && url.includes('/databases/')) {
      return { ok: true, status: 200, json: async () => rawDatabase() };
    }
    if (method === 'POST' && url.endsWith('/pages')) {
      return { ok: true, status: 200, json: async () => ({ id: PAGE_A_COMPACT, url: PAGE_URL }) };
    }
    if (method === 'PATCH' && url.includes('/pages/')) {
      return { ok: true, status: 200, json: async () => ({ id: PAGE_A_COMPACT, url: PAGE_URL }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function count(table: string): number {
  return (fake.__store[table] ?? []).length;
}

async function connect(): Promise<void> {
  await upsertConnection('user-1', {
    accessToken: TOKEN,
    botId: 'bot-1',
    workspaceId: 'ws-1',
    workspaceName: 'Ada Workspace',
    workspaceIcon: null,
    owner: null,
  });
}

function seedProfile(): void {
  fake.__store.user_profiles = [{ id: 'user-1', timezone: 'Africa/Lagos' }];
}

function seedWorkMapping(): void {
  fake.__store.notion_database_mappings = [
    {
      id: 'm-1',
      user_id: 'user-1',
      notion_database_id: DB_DASHED,
      database_title: 'Work Tasks',
      purpose: 'work',
      is_default: true,
    },
  ];
}

function taskRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 't-a',
    user_id: 'user-1',
    notion_page_id: PAGE_A_DASHED,
    notion_database_id: DB_DASHED,
    notion_url: PAGE_URL,
    title: 'Report alpha',
    description: null,
    category: null,
    priority: 'low',
    status: 'in_progress',
    due_date: '2026-10-09',
    due_time: null,
    timezone: 'UTC',
    source_of_change: 'assistant',
    sync_status: 'synced',
    last_synced_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  clearSchemaCache();
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
  fake.__queries.length = 0;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  installFetch();

  seedProfile();
  seedWorkMapping();
  await connect();
});

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('assistant end-to-end flow', () => {
  it('clarify → preview → explicit confirm creates the Notion page, mirror, reminder and audit', async () => {
    // (1) An under-specified request is answered with a clarifying question and
    //     performs no writes and no Notion call.
    mockChat.mockResolvedValue(clarifyJson);
    const clarification = await request(createApp())
      .post('/api/assistant/messages')
      .send({ content: 'Remind me to finish the report', messages: [] });

    expect(clarification.status).toBe(200);
    expect(clarification.body.message.content).toMatch(/date and time/i);
    expect(clarification.body.message.cards).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(count('assistant_tasks')).toBe(0);
    expect(count('assistant_reminders')).toBe(0);
    expect(count('assistant_audit_logs')).toBe(0);

    // (2) A fully-specified request produces a preview card enriched with the
    //     resolved database — still no writes and no Notion call.
    mockChat.mockResolvedValue(createTaskJson);
    const preview = await request(createApp())
      .post('/api/assistant/messages')
      .send({ content: 'Create it tomorrow at 5pm with a reminder', messages: [] });

    expect(preview.status).toBe(200);
    expect(preview.body.message.cards).toHaveLength(1);
    expect(preview.body.message.cards[0]).toMatchObject({
      type: 'task',
      title: 'Write report',
      task: { title: 'Write report', dueDate: '2026-10-07', priority: 'high' },
      database: { id: DB_DASHED, title: 'Work Tasks' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(count('assistant_tasks')).toBe(0);

    // (3) The user confirms: the real orchestrator creates the page, mirrors the
    //     task, records a pending reminder and appends an audit row.
    const confirm = await request(createApp())
      .post('/api/assistant/actions')
      .send({
        action: 'create_task',
        task: {
          title: 'Write report',
          dueDate: '2026-10-07',
          dueTime: '17:00',
          priority: 'high',
          category: 'Work Tasks',
          description: null,
        },
        reminder: { datetime: '2026-10-07T16:00:00.000Z' },
        databaseId: DB_DASHED,
      });

    expect(confirm.status).toBe(200);
    expect(confirm.body.notionUrl).toBe(PAGE_URL);
    expect(confirm.body.message.content).toMatch(/Task created/);
    expect(confirm.body.message.content).toContain('Work Tasks');

    expect(fake.__store.assistant_tasks).toHaveLength(1);
    expect(fake.__store.assistant_tasks[0]).toMatchObject({
      user_id: 'user-1',
      title: 'Write report',
      notion_page_id: PAGE_A_DASHED,
      notion_database_id: DB_DASHED,
      due_date: '2026-10-07',
      due_time: '17:00',
      priority: 'high',
    });

    expect(fake.__store.assistant_reminders).toHaveLength(1);
    expect(fake.__store.assistant_reminders[0]).toMatchObject({
      user_id: 'user-1',
      status: 'pending',
      channel: 'in_app',
      scheduled_for: '2026-10-07T16:00:00.000Z',
    });

    expect(fake.__store.assistant_audit_logs).toHaveLength(1);
    expect(fake.__store.assistant_audit_logs[0]).toMatchObject({
      user_id: 'user-1',
      action: 'task_created',
      tool_name: 'create_task',
      notion_page_id: PAGE_A_DASHED,
    });

    // Both Notion calls happened: schema resolution then page creation.
    const methods = fetchMock.mock.calls.map(
      (call) => ((call[1] as RequestInit)?.method ?? 'GET').toUpperCase()
    );
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });

  it('ambiguous task update → selection card → confirming the chosen task updates the mirror', async () => {
    // Two equally-ranked "report" tasks force disambiguation.
    fake.__store.assistant_tasks = [
      taskRow({ id: 't-a', title: 'Report alpha' }),
      taskRow({ id: 't-b', title: 'Report beta', notion_page_id: null, notion_url: null }),
    ];

    mockChat.mockResolvedValue(updateTaskJson);
    const selection = await request(createApp())
      .post('/api/assistant/messages')
      .send({ content: 'Change the priority of the report to high', messages: [] });

    expect(selection.status).toBe(200);
    expect(selection.body.message.cards).toHaveLength(1);
    expect(selection.body.message.cards[0]).toMatchObject({
      type: 'task_select',
      action: 'update_task',
      changes: { priority: 'high' },
    });
    expect(selection.body.message.cards[0].candidates).toEqual([
      expect.objectContaining({ taskId: 't-a', title: 'Report alpha' }),
      expect.objectContaining({ taskId: 't-b', title: 'Report beta' }),
    ]);

    // Confirming does not mutate during the message turn.
    expect(fake.__store.assistant_tasks.find((row) => row.id === 't-a')?.priority).toBe('low');

    // The user picks "Report alpha"; the real update orchestrator runs.
    const confirm = await request(createApp())
      .post('/api/assistant/actions')
      .send({ action: 'update_task', taskId: 't-a', changes: { priority: 'high' } });

    expect(confirm.status).toBe(200);
    expect(confirm.body.message.content).toMatch(/updated/i);

    expect(fake.__store.assistant_tasks.find((row) => row.id === 't-a')).toMatchObject({
      priority: 'high',
      source_of_change: 'assistant',
      sync_status: 'synced',
    });
    // The other task is untouched.
    expect(fake.__store.assistant_tasks.find((row) => row.id === 't-b')?.priority).toBe('low');

    const patchCall = fetchMock.mock.calls.find(
      (call) => ((call[1] as RequestInit)?.method ?? '').toUpperCase() === 'PATCH'
    );
    expect(patchCall).toBeTruthy();
    expect(fake.__store.assistant_audit_logs).toContainEqual(
      expect.objectContaining({ action: 'task_updated', tool_name: 'update_task', task_id: 't-a' })
    );
  });
});
