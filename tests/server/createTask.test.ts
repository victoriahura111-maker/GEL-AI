import { supabaseAdmin } from '../../server/src/services/supabase';
import {
  createTask,
  CreateTaskError,
} from '../../server/src/services/tasks/createTask';
import * as taskRepository from '../../server/src/services/tasks/repository';
import { upsertConnection } from '../../server/src/services/notion/connectionRepository';
import { NotionApiError } from '../../server/src/services/notion/client';
import { clearSchemaCache } from '../../server/src/services/notion/schema';
import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

// The mirror/reminder/audit repositories all run on the in-memory PostgREST fake,
// and the Notion network calls are intercepted by a routed `fetch` mock. Nothing
// touches a live database or the network.
jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

const fake = supabaseAdmin as unknown as FakeSupabaseClient;

const TOKEN = 'secret-notion-token';
const DB_COMPACT = 'AB12CD34EF56AB78CD90EF12AB34CD56';
const DB_DASHED = 'ab12cd34-ef56-ab78-cd90-ef12ab34cd56';
const PAGE_COMPACT = '11111111222233334444555566667777';
const PAGE_DASHED = '11111111-2222-3333-4444-555566667777';
const PAGE_URL = 'https://www.notion.so/page';

const ORIGINAL_FETCH = globalThis.fetch;
const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  clearSchemaCache();
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
  fake.__queries.length = 0;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

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
            { id: 'o1', name: 'Not started', color: 'gray' },
            { id: 'o2', name: 'Done', color: 'green' },
          ],
        },
      },
      Priority: {
        id: 'select-1',
        type: 'select',
        select: { options: [{ id: 'o3', name: 'High', color: 'red' }] },
      },
      Category: {
        id: 'select-2',
        type: 'select',
        select: { options: [{ id: 'o5', name: 'Work', color: 'blue' }] },
      },
    },
  };
}

/** Routes the two Notion calls the orchestrator makes (schema GET, page POST). */
function installFetch(options: { pageStatus?: number } = {}): void {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET' && url.includes('/databases/')) {
      return { ok: true, status: 200, json: async () => rawDatabase() };
    }

    if (method === 'POST' && url.endsWith('/pages')) {
      const status = options.pageStatus ?? 200;
      if (status >= 400) {
        return { ok: false, status, json: async () => ({ message: TOKEN }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: PAGE_COMPACT, url: PAGE_URL }) };
    }

    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function seedMappings(rows: FakeRow[]): void {
  fake.__store.notion_database_mappings = rows;
}

function seedDefaultWorkMapping(): void {
  seedMappings([
    {
      id: 'm-1',
      user_id: 'user-1',
      notion_database_id: DB_DASHED,
      database_title: 'Work Tasks',
      purpose: 'work',
      is_default: true,
    },
  ]);
}

describe('createTask — happy path', () => {
  it('creates the page, mirrors it, records a pending reminder + audit, and returns the URL', async () => {
    await connect();
    seedDefaultWorkMapping();
    installFetch();

    const result = await createTask(
      'user-1',
      {
        title: 'Write report',
        dueDate: '2026-10-03',
        dueTime: '17:00',
        priority: 'high',
        category: 'Work Tasks',
      },
      { reminder: { datetime: '2026-10-03T16:00:00.000Z', timezone: 'Africa/Lagos' } }
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.notion).toEqual({ id: PAGE_DASHED, url: PAGE_URL });
    expect(result.database).toEqual({ id: DB_DASHED, title: 'Work Tasks' });
    expect(result.task).toMatchObject({
      user_id: 'user-1',
      title: 'Write report',
      notion_page_id: PAGE_DASHED,
      notion_database_id: DB_DASHED,
      notion_url: PAGE_URL,
      source_of_change: 'assistant',
      sync_status: 'synced',
    });
    expect(result.task?.last_synced_at).toEqual(expect.any(String));

    expect(result.reminder).toMatchObject({
      task_id: result.task?.id,
      status: 'pending',
      scheduled_for: '2026-10-03T16:00:00.000Z',
    });

    // Side-effects landed exactly once each, scoped to the caller.
    expect(fake.__store.assistant_tasks).toHaveLength(1);
    expect(fake.__store.assistant_reminders).toHaveLength(1);
    expect(fake.__store.assistant_audit_logs).toHaveLength(1);
    expect(fake.__store.assistant_tasks[0].user_id).toBe('user-1');
    expect(fake.__store.assistant_audit_logs[0]).toMatchObject({
      user_id: 'user-1',
      action: 'task_created',
      tool_name: 'create_task',
      notion_page_id: PAGE_DASHED,
    });

    // The page POST targets the resolved database and never leaks the token.
    const pageCall = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit).method === 'POST'
    );
    expect(pageCall).toBeDefined();
    const body = JSON.parse(String((pageCall?.[1] as RequestInit).body));
    expect(body.parent).toEqual({ database_id: DB_DASHED });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('verifies an explicit databaseId via a schema fetch scoped to the user token', async () => {
    await connect();
    installFetch();

    const result = await createTask('user-1', { title: 'Ad hoc task' }, { databaseId: DB_COMPACT });

    expect(result.status).toBe('created');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.notion.com/v1/databases/${DB_DASHED}`
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
    });
  });
});

describe('createTask — needs_database', () => {
  it('returns needs_database and makes NO Notion call when the choice is ambiguous', async () => {
    await connect();
    seedMappings([
      {
        id: 'm-1',
        user_id: 'user-1',
        notion_database_id: 'db-a',
        database_title: 'A',
        purpose: 'work',
        is_default: false,
      },
      {
        id: 'm-2',
        user_id: 'user-1',
        notion_database_id: 'db-b',
        database_title: 'B',
        purpose: 'personal',
        is_default: false,
      },
    ]);
    installFetch();

    const result = await createTask('user-1', { title: 'Task', category: 'zzz' });

    expect(result.status).toBe('needs_database');
    if (result.status === 'needs_database') {
      expect(result.candidates).toHaveLength(2);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.__store.assistant_tasks ?? []).toHaveLength(0);
    expect(fake.__store.assistant_audit_logs ?? []).toHaveLength(0);
  });

  it('returns no_databases (empty candidates) and makes NO Notion call', async () => {
    await connect();
    seedMappings([]);
    installFetch();

    const result = await createTask('user-1', { title: 'Task' });

    expect(result).toEqual({ status: 'no_databases', candidates: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createTask — failure handling', () => {
  it('propagates a typed Notion error and writes no mirror/reminder/audit rows', async () => {
    await connect();
    seedDefaultWorkMapping();
    installFetch({ pageStatus: 500 });

    const error = await createTask('user-1', { title: 'Task' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotionApiError);
    expect(fake.__store.assistant_tasks ?? []).toHaveLength(0);
    expect(fake.__store.assistant_reminders ?? []).toHaveLength(0);
    expect(fake.__store.assistant_audit_logs ?? []).toHaveLength(0);
  });

  it('still returns the Notion URL (task: null) when the local mirror write fails', async () => {
    await connect();
    seedDefaultWorkMapping();
    installFetch();

    const spy = jest
      .spyOn(taskRepository, 'createTaskRecord')
      .mockRejectedValueOnce(new Error('database down'));

    const result = await createTask('user-1', { title: 'Task' });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.task).toBeNull();
    expect(result.notion.url).toBe(PAGE_URL);
    expect(fake.__store.assistant_tasks ?? []).toHaveLength(0);
    // The audit row is still written (with a null task_id).
    expect(fake.__store.assistant_audit_logs).toHaveLength(1);
    expect(fake.__store.assistant_audit_logs[0].task_id).toBeNull();

    spy.mockRestore();
  });

  it('throws a typed CreateTaskError for invalid input without any Notion call', async () => {
    await connect();
    installFetch();

    const error = await createTask('user-1', { title: '' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CreateTaskError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
