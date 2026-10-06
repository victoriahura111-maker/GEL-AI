import { syncUser, SYNC_EPOCH } from '../../server/src/services/sync/engine';
import { getDatabaseSchema } from '../../server/src/services/notion/schema';
import { queryDatabasePages, updatePage } from '../../server/src/services/notion/pages';
import { upsertMapping } from '../../server/src/services/notion/databaseMappingRepository';
import { supabaseAdmin } from '../../server/src/services/supabase';
import type { NotionDatabaseSchema } from '../../server/src/services/notion/schema';
import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

/**
 * Phase 16 — sync engine. The Notion schema + page functions are mocked, while
 * the task/mapping/state repositories run against the in-memory PostgREST fake.
 * No network or database is touched.
 */

jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

// Keep the real exports (e.g. SUPPORTED_PROPERTY_TYPES used by propertyMapping)
// and stub only the network-touching schema fetch.
jest.mock('../../server/src/services/notion/schema', () => {
  const actual = jest.requireActual<typeof import('../../server/src/services/notion/schema')>(
    '../../server/src/services/notion/schema'
  );
  return { ...actual, getDatabaseSchema: jest.fn() };
});

jest.mock('../../server/src/services/notion/pages', () => {
  const actual = jest.requireActual<typeof import('../../server/src/services/notion/pages')>(
    '../../server/src/services/notion/pages'
  );
  return { ...actual, queryDatabasePages: jest.fn(), updatePage: jest.fn() };
});

const fake = supabaseAdmin as unknown as FakeSupabaseClient;
const mockGetSchema = getDatabaseSchema as jest.Mock;
const mockQuery = queryDatabasePages as jest.Mock;
const mockUpdatePage = updatePage as jest.Mock;

const DB_A = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6';
const DB_B = 'b1c2d3e4-f5a6-b7c8-d9e0-f1a2b3c4d5e6';
const PAGE_1 = '11111111-2222-3333-4444-555566667777';
const PAGE_2 = '22222222-3333-4444-5555-666677778888';

const schema: NotionDatabaseSchema = {
  id: DB_A,
  title: 'Tasks',
  properties: [
    { id: 't', name: 'Name', type: 'title' },
    { id: 's', name: 'Status', type: 'status', options: [{ name: 'Not started' }, { name: 'Done' }] },
    { id: 'd', name: 'Due', type: 'date' },
  ],
};

function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAGE_1,
    url: 'https://www.notion.so/page-1',
    archived: false,
    inTrash: false,
    createdTime: '2026-01-01T00:00:00.000Z',
    lastEditedTime: '2026-02-01T00:00:00.000Z',
    parentDatabaseId: DB_A,
    properties: { Name: { title: [{ plain_text: 'From Notion' }] } },
    ...overrides,
  };
}

function taskRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'task-existing',
    user_id: 'user-1',
    notion_page_id: PAGE_1,
    notion_database_id: DB_A,
    notion_url: null,
    title: 'Local title',
    description: null,
    category: null,
    priority: null,
    status: 'not_started',
    due_date: null,
    due_time: null,
    timezone: null,
    source_of_change: 'assistant',
    sync_status: null,
    last_synced_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function tasks(): FakeRow[] {
  return fake.__store.assistant_tasks ?? [];
}

function syncState(): FakeRow[] {
  return fake.__store.user_sync_state ?? [];
}

beforeEach(async () => {
  jest.clearAllMocks();
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
  fake.__queries.length = 0;

  mockGetSchema.mockResolvedValue(schema);
  mockQuery.mockResolvedValue({ pages: [], nextCursor: null, hasMore: false });
  mockUpdatePage.mockResolvedValue({ id: PAGE_1, url: null });

  await upsertMapping('user-1', { notionDatabaseId: DB_A, purpose: 'work' });
});

describe('syncUser — pull', () => {
  it('creates a new mirror row for a Notion page', async () => {
    mockQuery.mockResolvedValue({ pages: [page()], nextCursor: null, hasMore: false });

    const summary = await syncUser('user-1', {
      direction: 'pull',
      now: new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(summary.pulled.created).toBe(1);
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]).toMatchObject({
      title: 'From Notion',
      notion_page_id: PAGE_1,
      notion_database_id: DB_A,
      source_of_change: 'notion',
      sync_status: 'synced',
    });
    // The watermark starts at the epoch and advances to the run instant.
    expect(mockQuery).toHaveBeenCalledWith(
      'user-1',
      DB_A,
      expect.objectContaining({ lastEditedAfter: SYNC_EPOCH })
    );
    expect(syncState()[0].last_synced_at).toBe('2026-05-01T00:00:00.000Z');
  });

  it('updates the mirror when Notion is newer (last-write-wins)', async () => {
    fake.__store.assistant_tasks.push(
      taskRow({ title: 'Stale local', updated_at: '2026-01-01T00:00:00.000Z' })
    );
    mockQuery.mockResolvedValue({
      pages: [page({ lastEditedTime: '2026-02-01T00:00:00.000Z' })],
      nextCursor: null,
      hasMore: false,
    });

    const summary = await syncUser('user-1', { direction: 'pull' });

    expect(summary.pulled.updated).toBe(1);
    expect(tasks()[0].title).toBe('From Notion');
    expect(tasks()[0].sync_status).toBe('synced');
    expect(tasks()[0].source_of_change).toBe('notion');
  });

  it('leaves a newer local change untouched', async () => {
    fake.__store.assistant_tasks.push(
      taskRow({ title: 'Local wins', updated_at: '2026-03-01T00:00:00.000Z' })
    );
    mockQuery.mockResolvedValue({
      pages: [page({ lastEditedTime: '2026-02-01T00:00:00.000Z' })],
      nextCursor: null,
      hasMore: false,
    });

    const summary = await syncUser('user-1', { direction: 'pull' });

    expect(summary.pulled.skipped).toBe(1);
    expect(summary.pulled.updated).toBe(0);
    expect(tasks()[0].title).toBe('Local wins');
  });

  it('cancels the local mirror when the Notion page is archived', async () => {
    fake.__store.assistant_tasks.push(taskRow());
    mockQuery.mockResolvedValue({
      pages: [page({ archived: true })],
      nextCursor: null,
      hasMore: false,
    });

    const summary = await syncUser('user-1', { direction: 'pull' });

    expect(summary.pulled.updated).toBe(1);
    expect(tasks()[0].status).toBe('cancelled');
    expect(tasks()[0].sync_status).toBe('error');
  });

  it('does not advance the watermark when a pull fails', async () => {
    mockGetSchema.mockRejectedValue(new Error('notion down'));

    const summary = await syncUser('user-1', { direction: 'pull' });

    expect(summary.errors.length).toBeGreaterThan(0);
    expect(syncState()[0]?.last_synced_at ?? null).toBeNull();
  });
});

describe('syncUser — push', () => {
  it('updates changed local tasks and marks them synced', async () => {
    fake.__store.assistant_tasks.push(
      taskRow({ source_of_change: 'assistant', updated_at: '2026-02-01T00:00:00.000Z' })
    );

    const summary = await syncUser('user-1', {
      direction: 'push',
      now: new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(summary.pushed.updated).toBe(1);
    expect(mockUpdatePage).toHaveBeenCalledWith('user-1', PAGE_1, expect.any(Object));
    expect(tasks()[0].sync_status).toBe('synced');
    expect(tasks()[0].last_synced_at).toBe('2026-05-01T00:00:00.000Z');
  });

  it('marks a failed push as error but continues with the rest', async () => {
    fake.__store.assistant_tasks.push(
      taskRow({ id: 'task-1', notion_page_id: PAGE_1, updated_at: '2026-02-01T00:00:00.000Z' })
    );
    fake.__store.assistant_tasks.push(
      taskRow({ id: 'task-2', notion_page_id: PAGE_2, updated_at: '2026-02-01T00:00:00.000Z' })
    );
    mockUpdatePage
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: PAGE_2, url: null });

    const summary = await syncUser('user-1', { direction: 'push' });

    expect(summary.pushed.failed).toBe(1);
    expect(summary.pushed.updated).toBe(1);
    const byId = new Map(tasks().map((row) => [row.id, row]));
    expect(byId.get('task-1')?.sync_status).toBe('error');
    expect(byId.get('task-2')?.sync_status).toBe('synced');
  });

  it('skips tasks originating from Notion', async () => {
    fake.__store.assistant_tasks.push(
      taskRow({ source_of_change: 'notion', updated_at: '2026-02-01T00:00:00.000Z' })
    );

    const summary = await syncUser('user-1', { direction: 'push' });

    expect(summary.pushed.updated).toBe(0);
    expect(mockUpdatePage).not.toHaveBeenCalled();
  });
});

describe('syncUser — loop prevention', () => {
  it('does not immediately push a row that was just pulled', async () => {
    mockQuery.mockResolvedValue({ pages: [page()], nextCursor: null, hasMore: false });

    const summary = await syncUser('user-1', { direction: 'both' });

    expect(summary.pulled.created).toBe(1);
    expect(summary.pushed.updated).toBe(0);
    expect(mockUpdatePage).not.toHaveBeenCalled();
  });

  it('does not re-pull a row already synced at that Notion timestamp', async () => {
    fake.__store.assistant_tasks.push(
      taskRow({
        title: 'Already pushed',
        last_synced_at: '2026-01-04T00:00:00.000Z',
        updated_at: '2026-01-05T00:00:00.000Z',
      })
    );
    mockQuery.mockResolvedValue({
      pages: [page({ lastEditedTime: '2026-01-03T00:00:00.000Z' })],
      nextCursor: null,
      hasMore: false,
    });

    const summary = await syncUser('user-1', { direction: 'pull' });

    expect(summary.pulled.skipped).toBe(1);
    expect(summary.pulled.updated).toBe(0);
    expect(tasks()[0].title).toBe('Already pushed');
  });
});

describe('syncUser — isolation & summary', () => {
  it('isolates a per-database failure and continues with other databases', async () => {
    await upsertMapping('user-1', { notionDatabaseId: DB_B, purpose: 'personal' });
    mockGetSchema.mockImplementation(async (_userId: string, databaseId: string) => {
      if (databaseId === DB_A) throw new Error('schema unavailable');
      return schema;
    });
    mockQuery.mockResolvedValue({
      pages: [page({ parentDatabaseId: DB_B })],
      nextCursor: null,
      hasMore: false,
    });

    const summary = await syncUser('user-1', { direction: 'pull' });

    expect(summary.errors.some((entry) => entry.scope === `database:${DB_A}`)).toBe(true);
    expect(summary.pulled.created).toBe(1);
  });

  it('returns the documented summary shape and never throws', async () => {
    mockGetSchema.mockRejectedValue(new Error('total failure'));

    const summary = await syncUser('user-1', { direction: 'both' });

    expect(summary).toMatchObject({
      direction: 'both',
      pulled: { created: 0, updated: 0, skipped: 0 },
      pushed: { updated: 0, failed: 0 },
    });
    expect(typeof summary.startedAt).toBe('string');
    expect(typeof summary.finishedAt).toBe('string');
    expect(summary.errors.length).toBeGreaterThan(0);
  });
});
