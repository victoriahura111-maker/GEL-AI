import { supabaseAdmin } from '../../server/src/services/supabase';
import { applyTaskUpdate, deleteTask } from '../../server/src/services/tasks/updateTask';
import { upsertConnection } from '../../server/src/services/notion/connectionRepository';
import { NotionApiError } from '../../server/src/services/notion/client';
import { clearSchemaCache } from '../../server/src/services/notion/schema';
import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

// The mirror/reminder/audit repositories run on the in-memory PostgREST fake and
// the Notion calls are intercepted by a routed `fetch` mock — no network/DB.
jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

const fake = supabaseAdmin as unknown as FakeSupabaseClient;

const TOKEN = 'secret-notion-token';
const DB_COMPACT = 'AB12CD34EF56AB78CD90EF12AB34CD56';
const DB_DASHED = 'ab12cd34-ef56-ab78-cd90-ef12ab34cd56';
const DB2_COMPACT = '11112222333344445555666677778888';
const DB2_DASHED = '11112222-3333-4444-5555-666677778888';
const PAGE_COMPACT = '99998888777766665555444433332222';
const PAGE_DASHED = '99998888-7777-6666-5555-444433332222';
const PAGE_URL = 'https://www.notion.so/original';
const NEW_PAGE_COMPACT = '00001111222233334444555566667777';
const NEW_PAGE_DASHED = '00001111-2222-3333-4444-555566667777';
const NEW_PAGE_URL = 'https://www.notion.so/moved';

const ORIGINAL_FETCH = globalThis.fetch;
const fetchMock = jest.fn();

interface RouteConfig {
  statusOptions?: string[];
  createStatus?: number;
  updateStatus?: number;
  archiveStatus?: number;
}

let config: RouteConfig = {};

beforeEach(() => {
  jest.clearAllMocks();
  clearSchemaCache();
  config = {};
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

function rawDatabase(id: string = DB_COMPACT): Record<string, unknown> {
  const statusOptions = (config.statusOptions ?? ['Not started', 'In progress', 'Done', 'Cancelled']).map(
    (name, index) => ({ id: `s${index}`, name, color: 'gray' })
  );

  return {
    object: 'database',
    id,
    title: [{ plain_text: 'Work Tasks' }],
    properties: {
      Name: { id: 'title-1', type: 'title', title: {} },
      Notes: { id: 'rt-1', type: 'rich_text', rich_text: {} },
      'Due Date': { id: 'date-1', type: 'date', date: {} },
      Status: { id: 'status-1', type: 'status', status: { options: statusOptions } },
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

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function fail(status: number) {
  return { ok: false, status, json: async () => ({ message: TOKEN }) };
}

function installFetch(): void {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (method === 'GET' && url.includes('/databases/')) {
      const id = url.split('/databases/')[1] ?? DB_COMPACT;
      return ok(rawDatabase(id));
    }

    if (method === 'POST' && url.endsWith('/pages')) {
      if (config.createStatus && config.createStatus >= 400) return fail(config.createStatus);
      return ok({ id: NEW_PAGE_COMPACT, url: NEW_PAGE_URL });
    }

    if (method === 'PATCH' && url.includes('/pages/')) {
      if (body.archived === true) {
        if (config.archiveStatus && config.archiveStatus >= 400) return fail(config.archiveStatus);
        return ok({ id: PAGE_COMPACT, url: PAGE_URL });
      }
      if (config.updateStatus && config.updateStatus >= 400) return fail(config.updateStatus);
      return ok({ id: PAGE_COMPACT, url: PAGE_URL });
    }

    return fail(404);
  });
}

function seedTask(overrides: Partial<FakeRow> = {}): FakeRow {
  const row: FakeRow = {
    id: 'task-1',
    user_id: 'user-1',
    notion_page_id: PAGE_DASHED,
    notion_database_id: DB_DASHED,
    notion_url: PAGE_URL,
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
  fake.__store.assistant_tasks = [row];
  return row;
}

/** Returns the properties payload of the first non-archive PATCH call. */
function updateProperties(): Record<string, unknown> | null {
  const call = fetchMock.mock.calls.find((entry) => {
    const init = entry[1] as RequestInit;
    if ((init?.method ?? '').toUpperCase() !== 'PATCH') return false;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    return body.archived !== true;
  });
  if (!call) return null;
  const body = JSON.parse(String((call[1] as RequestInit).body));
  return body.properties as Record<string, unknown>;
}

describe('applyTaskUpdate — field updates', () => {
  beforeEach(async () => {
    await connect();
    installFetch();
  });

  it('completes a task, updating Notion + the mirror and writing an audit row', async () => {
    seedTask();

    const result = await applyTaskUpdate('user-1', 'task-1', { status: 'completed' });

    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.task?.status).toBe('completed');
      expect(result.warnings).toEqual([]);
    }
    expect(updateProperties()).toMatchObject({ Status: { status: { name: 'Done' } } });
    expect(fake.__store.assistant_audit_logs[0]).toMatchObject({
      user_id: 'user-1',
      action: 'task_completed',
      tool_name: 'complete_task',
      task_id: 'task-1',
    });
  });

  it('cancels a task', async () => {
    seedTask();

    await applyTaskUpdate('user-1', 'task-1', { status: 'cancelled' });

    expect(updateProperties()).toMatchObject({ Status: { status: { name: 'Cancelled' } } });
    expect(fake.__store.assistant_tasks[0].status).toBe('cancelled');
    expect(fake.__store.assistant_audit_logs[0]).toMatchObject({ action: 'task_cancelled' });
  });

  it('changes priority', async () => {
    seedTask({ priority: 'low' });

    await applyTaskUpdate('user-1', 'task-1', { priority: 'high' });

    expect(updateProperties()).toMatchObject({ Priority: { select: { name: 'High' } } });
    expect(fake.__store.assistant_tasks[0].priority).toBe('high');
  });

  it('changes the title, category and description together', async () => {
    seedTask({ category: null });

    await applyTaskUpdate('user-1', 'task-1', {
      title: 'Write final report',
      category: 'Work',
      description: 'Q4 numbers',
    });

    expect(updateProperties()).toMatchObject({
      Name: { title: [{ text: { content: 'Write final report' } }] },
      Category: { select: { name: 'Work' } },
      Notes: { rich_text: [{ text: { content: 'Q4 numbers' } }] },
    });
    expect(fake.__store.assistant_tasks[0].description).toBe('Q4 numbers');
  });

  it('reschedules the due date + time', async () => {
    seedTask();

    await applyTaskUpdate('user-1', 'task-1', { dueDate: '2026-10-06', dueTime: '09:00' });

    expect(updateProperties()).toMatchObject({
      'Due Date': { date: { start: '2026-10-06T09:00:00' } },
    });
    expect(fake.__store.assistant_tasks[0].due_date).toBe('2026-10-06');
  });

  it('omits an unmapped status option and warns, still updating the mirror', async () => {
    config.statusOptions = ['Not started'];
    seedTask();

    const result = await applyTaskUpdate('user-1', 'task-1', { status: 'completed' });

    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.warnings.join(' ')).toMatch(/status option/i);
    }
    expect(updateProperties()).toBeNull();
    expect(fake.__store.assistant_tasks[0].status).toBe('completed');
  });

  it('returns not_found for another user’s task', async () => {
    seedTask({ user_id: 'user-2' });

    const result = await applyTaskUpdate('user-1', 'task-1', { status: 'completed' });

    expect(result).toEqual({ status: 'not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a typed Notion error and leaves the mirror unchanged', async () => {
    config.updateStatus = 401;
    seedTask();

    const error = await applyTaskUpdate('user-1', 'task-1', { priority: 'high' }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(NotionApiError);
    expect(fake.__store.assistant_tasks[0].priority).toBe('medium');
    expect(fake.__store.assistant_audit_logs ?? []).toHaveLength(0);
  });
});

describe('applyTaskUpdate — move between databases', () => {
  beforeEach(async () => {
    await connect();
    installFetch();
  });

  it('creates a page in the target database, archives the original, and updates the mirror', async () => {
    seedTask();

    const result = await applyTaskUpdate('user-1', 'task-1', { databaseId: DB2_COMPACT });

    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.notion).toEqual({ id: NEW_PAGE_DASHED, url: NEW_PAGE_URL });
      expect(result.warnings).toEqual([]);
    }

    // A new page was created under the target database.
    const createCall = fetchMock.mock.calls.find(
      (entry) => (entry[1] as RequestInit).method === 'POST'
    );
    const createBody = JSON.parse(String((createCall?.[1] as RequestInit).body));
    expect(createBody.parent).toEqual({ database_id: DB2_DASHED });

    // The original page was archived.
    const archiveCall = fetchMock.mock.calls.find((entry) => {
      const init = entry[1] as RequestInit;
      if ((init?.method ?? '').toUpperCase() !== 'PATCH') return false;
      const body = init.body ? JSON.parse(String(init.body)) : {};
      return body.archived === true;
    });
    expect(archiveCall).toBeDefined();
    expect(String(archiveCall?.[0])).toContain(PAGE_DASHED);

    expect(fake.__store.assistant_tasks[0]).toMatchObject({
      notion_page_id: NEW_PAGE_DASHED,
      notion_database_id: DB2_DASHED,
      notion_url: NEW_PAGE_URL,
    });
    expect(fake.__store.assistant_audit_logs[0]).toMatchObject({
      action: 'task_moved',
      tool_name: 'move_task',
      notion_page_id: NEW_PAGE_DASHED,
    });
  });

  it('keeps both pages and warns when archiving the original fails', async () => {
    config.archiveStatus = 500;
    seedTask();

    const result = await applyTaskUpdate('user-1', 'task-1', { databaseId: DB2_COMPACT });

    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.warnings.join(' ')).toMatch(/could not be archived/i);
      expect(result.notion?.id).toBe(NEW_PAGE_DASHED);
    }
    // The mirror points at the new page; the change is never lost.
    expect(fake.__store.assistant_tasks[0].notion_page_id).toBe(NEW_PAGE_DASHED);
  });
});

describe('deleteTask', () => {
  beforeEach(async () => {
    await connect();
    installFetch();
  });

  it('archives the page, cancels pending reminders, and removes the mirror row', async () => {
    seedTask();
    fake.__store.assistant_reminders = [
      {
        id: 'rem-1',
        task_id: 'task-1',
        user_id: 'user-1',
        scheduled_for: '2026-10-03T16:00:00.000Z',
        timezone: 'UTC',
        channel: 'in_app',
        status: 'pending',
        recurrence: null,
        sent_at: null,
        failure_reason: null,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
      },
    ];

    const result = await deleteTask('user-1', 'task-1');

    expect(result.status).toBe('deleted');
    expect(fake.__store.assistant_tasks).toHaveLength(0);
    expect(fake.__store.assistant_reminders[0].status).toBe('cancelled');
    expect(fake.__store.assistant_audit_logs[0]).toMatchObject({
      action: 'task_deleted',
      tool_name: 'delete_task',
    });
  });

  it('returns not_found without a Notion call for a foreign task', async () => {
    seedTask({ user_id: 'user-2' });

    const result = await deleteTask('user-1', 'task-1');

    expect(result).toEqual({ status: 'not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
