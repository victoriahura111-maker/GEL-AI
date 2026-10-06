import request from 'supertest';
import { createApp } from '../../server/src/app';
import { listDatabases, NotionApiError } from '../../server/src/services/notion/client';
import { upsertMapping } from '../../server/src/services/notion/databaseMappingRepository';
import { supabaseAdmin } from '../../server/src/services/supabase';
import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

// Real mapping repository backed by the in-memory PostgREST fake.
jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

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

// Keep the real module (so NotionApiError is the genuine class) but stub the
// network-touching discovery function.
jest.mock('../../server/src/services/notion/client', () => {
  const actual = jest.requireActual<typeof import('../../server/src/services/notion/client')>(
    '../../server/src/services/notion/client'
  );
  return { ...actual, listDatabases: jest.fn() };
});

const fake = supabaseAdmin as unknown as FakeSupabaseClient;
const mockListDatabases = listDatabases as jest.Mock;

const DB_A = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6';
const DB_B = 'b1c2d3e4-f5a6-b7c8-d9e0-f1a2b3c4d5e6';
const DB_A_COMPACT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function rows(): FakeRow[] {
  return fake.__store.notion_database_mappings ?? [];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListDatabases.mockReset();
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
  fake.__queries.length = 0;
});

describe('GET /api/notion/databases', () => {
  it('merges discovered databases with the caller’s saved purpose/default', async () => {
    mockListDatabases.mockResolvedValue([
      { id: DB_A, title: 'Work Tasks', url: 'https://www.notion.so/work', icon: '📋' },
    ]);
    await upsertMapping('user-1', {
      notionDatabaseId: DB_A,
      databaseTitle: 'Work Tasks',
      purpose: 'work',
      isDefault: true,
    });

    const response = await request(createApp()).get('/api/notion/databases');

    expect(response.status).toBe(200);
    expect(response.body.databases).toEqual([
      {
        id: DB_A,
        title: 'Work Tasks',
        url: 'https://www.notion.so/work',
        icon: '📋',
        purpose: 'work',
        isDefault: true,
      },
    ]);
    expect(mockListDatabases).toHaveBeenCalledWith('user-1');
  });

  it('annotates unmapped databases with a null purpose and isDefault false', async () => {
    mockListDatabases.mockResolvedValue([
      { id: DB_A, title: 'Work Tasks', url: null, icon: null },
    ]);

    const response = await request(createApp()).get('/api/notion/databases');

    expect(response.status).toBe(200);
    expect(response.body.databases[0]).toMatchObject({ purpose: null, isDefault: false });
  });

  it('returns 409 when Notion is not connected', async () => {
    mockListDatabases.mockRejectedValue(
      new NotionApiError('Connect Notion first.', 'not_connected', null)
    );

    const response = await request(createApp()).get('/api/notion/databases');

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/connect notion/i);
  });

  it('returns 409 with reconnect guidance when the connection is invalid', async () => {
    mockListDatabases.mockRejectedValue(
      new NotionApiError('Reconnect Notion to continue.', 'unauthorized', 401)
    );

    const response = await request(createApp()).get('/api/notion/databases');

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/reconnect/i);
  });

  it('returns 502 for an upstream provider failure', async () => {
    mockListDatabases.mockRejectedValue(
      new NotionApiError('Notion could not complete the request.', 'api_error', 500)
    );

    const response = await request(createApp()).get('/api/notion/databases');

    expect(response.status).toBe(502);
  });
});

describe('PUT /api/notion/databases/:databaseId/mapping', () => {
  it('rejects an invalid purpose with 400 and stores nothing', async () => {
    const response = await request(createApp())
      .put(`/api/notion/databases/${DB_A}/mapping`)
      .send({ purpose: 'chores' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid mapping');
    expect(rows()).toHaveLength(0);
  });

  it('rejects a malformed database id with 400', async () => {
    const response = await request(createApp())
      .put('/api/notion/databases/not-a-notion-id/mapping')
      .send({ purpose: 'work' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid Notion database id');
  });

  it('persists the mapping and normalises a compact id', async () => {
    const response = await request(createApp())
      .put(`/api/notion/databases/${DB_A_COMPACT}/mapping`)
      .send({ purpose: 'school', isDefault: true });

    expect(response.status).toBe(200);
    expect(response.body.mapping).toMatchObject({
      notionDatabaseId: DB_A,
      purpose: 'school',
      isDefault: true,
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].user_id).toBe('user-1');
    expect(rows()[0].notion_database_id).toBe(DB_A);
    expect(rows()[0].purpose).toBe('school');
  });

  it('keeps a single default when setting a new one', async () => {
    await upsertMapping('user-1', { notionDatabaseId: DB_A, purpose: 'work', isDefault: true });
    await upsertMapping('user-1', { notionDatabaseId: DB_B, purpose: 'personal' });

    const response = await request(createApp())
      .put(`/api/notion/databases/${DB_B}/mapping`)
      .send({ purpose: 'personal', isDefault: true });

    expect(response.status).toBe(200);
    const defaults = rows().filter((row) => row.is_default === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].notion_database_id).toBe(DB_B);
  });
});

describe('DELETE /api/notion/databases/:databaseId/mapping', () => {
  it('removes the caller’s mapping', async () => {
    await upsertMapping('user-1', { notionDatabaseId: DB_A, purpose: 'work' });

    const response = await request(createApp()).delete(
      `/api/notion/databases/${DB_A}/mapping`
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ removed: true });
    expect(rows()).toHaveLength(0);
  });

  it('rejects a malformed database id with 400', async () => {
    const response = await request(createApp()).delete(
      '/api/notion/databases/not-a-notion-id/mapping'
    );

    expect(response.status).toBe(400);
  });
});

describe('cross-user isolation', () => {
  it('never exposes or mutates another user’s mapping', async () => {
    await upsertMapping('user-2', {
      notionDatabaseId: DB_A,
      databaseTitle: 'Other',
      purpose: 'personal',
      isDefault: true,
    });
    mockListDatabases.mockResolvedValue([
      { id: DB_A, title: 'Work Tasks', url: null, icon: null },
    ]);

    const list = await request(createApp()).get('/api/notion/databases');
    expect(list.body.databases[0]).toMatchObject({ purpose: null, isDefault: false });

    const removed = await request(createApp()).delete(
      `/api/notion/databases/${DB_A}/mapping`
    );
    expect(removed.body.removed).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].user_id).toBe('user-2');

    const put = await request(createApp())
      .put(`/api/notion/databases/${DB_A}/mapping`)
      .send({ purpose: 'work' });
    expect(put.status).toBe(200);
    expect(rows()).toHaveLength(2);
    expect(rows().filter((row) => row.user_id === 'user-1')).toHaveLength(1);
  });
});
