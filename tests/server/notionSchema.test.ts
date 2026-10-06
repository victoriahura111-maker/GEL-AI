import {
  getDatabaseSchema,
  toDatabaseSchema,
  clearSchemaCache,
} from '../../server/src/services/notion/schema';
import { NotionApiError } from '../../server/src/services/notion/client';
import { upsertConnection } from '../../server/src/services/notion/connectionRepository';
import { supabaseAdmin } from '../../server/src/services/supabase';
import type { FakeSupabaseClient } from './supabaseFake';

// Back the connection repository with the in-memory PostgREST fake so the token
// can be encrypted/decrypted for real without any network or database.
jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

const fake = supabaseAdmin as unknown as FakeSupabaseClient;

const TOKEN = 'secret-notion-token';
const DB_COMPACT = 'AB12CD34EF56AB78CD90EF12AB34CD56';
const DB_DASHED = 'ab12cd34-ef56-ab78-cd90-ef12ab34cd56';
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
    title: [{ plain_text: 'Acme Tasks' }],
    properties: {
      Name: { id: 'title-1', type: 'title', title: {} },
      Notes: { id: 'rt-1', type: 'rich_text', rich_text: {} },
      'Due Date': { id: 'date-1', type: 'date', date: {} },
      Status: {
        id: 'status-1',
        type: 'status',
        status: {
          options: [
            { id: 'opt-1', name: 'Not started', color: 'gray' },
            { id: 'opt-2', name: 'Done', color: 'green' },
          ],
        },
      },
      Priority: {
        id: 'select-1',
        type: 'select',
        select: { options: [{ id: 'opt-3', name: 'High', color: 'red' }] },
      },
      Tags: {
        id: 'multi-1',
        type: 'multi_select',
        multi_select: { options: [{ id: 'opt-4', name: 'Home', color: 'blue' }] },
      },
      Link: { id: 'url-1', type: 'url', url: {} },
      Owner: { id: 'people-1', type: 'people', people: {} },
      Estimate: { id: 'num-1', type: 'number', number: {} },
      Formula: { id: 'formula-1', type: 'formula', formula: {} },
    },
  };
}

function stubJson(payload: unknown, ok = true, status = 200): void {
  fetchMock.mockResolvedValue({ ok, status, json: async () => payload });
}

describe('toDatabaseSchema — flattening', () => {
  it('flattens the properties object into an ordered array', () => {
    const schema = toDatabaseSchema(rawDatabase());

    expect(schema).not.toBeNull();
    expect(schema?.id).toBe(DB_DASHED);
    expect(schema?.title).toBe('Acme Tasks');
    expect(schema?.properties.map((property) => property.name)).toEqual([
      'Name',
      'Notes',
      'Due Date',
      'Status',
      'Priority',
      'Tags',
      'Link',
      'Owner',
      'Estimate',
      'Formula',
    ]);
    expect(schema?.properties.map((property) => property.type)).toEqual([
      'title',
      'rich_text',
      'date',
      'status',
      'select',
      'multi_select',
      'url',
      'people',
      'number',
      'formula',
    ]);
  });

  it('collects options for select, multi_select and status (status.options)', () => {
    const schema = toDatabaseSchema(rawDatabase());
    const byName = new Map(schema?.properties.map((property) => [property.name, property]));

    expect(byName.get('Status')?.options).toEqual([
      { id: 'opt-1', name: 'Not started', color: 'gray' },
      { id: 'opt-2', name: 'Done', color: 'green' },
    ]);
    expect(byName.get('Priority')?.options).toEqual([{ id: 'opt-3', name: 'High', color: 'red' }]);
    expect(byName.get('Tags')?.options).toEqual([{ id: 'opt-4', name: 'Home', color: 'blue' }]);
    // Non select-like types never carry options.
    expect(byName.get('Name')?.options).toBeUndefined();
    expect(byName.get('Due Date')?.options).toBeUndefined();
    expect(byName.get('Estimate')?.options).toBeUndefined();
  });

  it('returns null when the raw object has no usable id', () => {
    expect(toDatabaseSchema({})).toBeNull();
    expect(toDatabaseSchema({ id: '' })).toBeNull();
  });

  it('tolerates a missing properties map', () => {
    const schema = toDatabaseSchema({ id: DB_COMPACT, title: [{ plain_text: 'Bare' }] });
    expect(schema?.properties).toEqual([]);
    expect(schema?.title).toBe('Bare');
  });
});

describe('getDatabaseSchema', () => {
  it('fetches the raw database and normalises it (never leaking the token)', async () => {
    await connect();
    stubJson(rawDatabase());

    const schema = await getDatabaseSchema('user-1', DB_DASHED);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe(`https://api.notion.com/v1/databases/${DB_DASHED}`);
    expect(call[1].method).toBe('GET');
    expect((call[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(schema.title).toBe('Acme Tasks');
    expect(JSON.stringify(schema)).not.toContain(TOKEN);
  });

  it('normalises a compact id in the request path', async () => {
    await connect();
    stubJson(rawDatabase());

    await getDatabaseSchema('user-1', DB_COMPACT);

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe(`https://api.notion.com/v1/databases/${DB_DASHED}`);
  });

  it('caches the resolved schema for the TTL window', async () => {
    await connect();
    stubJson(rawDatabase());

    await getDatabaseSchema('user-1', DB_DASHED);
    await getDatabaseSchema('user-1', DB_DASHED);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // `fresh` bypasses the cache.
    await getDatabaseSchema('user-1', DB_DASHED, { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws not_connected without a connection (and never calls Notion)', async () => {
    const error = await getDatabaseSchema('user-1', DB_DASHED).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).code).toBe('not_connected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an upstream 401 to a reconnect (unauthorized) error', async () => {
    await connect();
    stubJson({ message: TOKEN }, false, 401);

    const error = await getDatabaseSchema('user-1', DB_DASHED).catch((caught: unknown) => caught);

    expect((error as NotionApiError).code).toBe('unauthorized');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('maps an upstream 404 to not_found', async () => {
    await connect();
    stubJson({}, false, 404);

    const error = await getDatabaseSchema('user-1', DB_DASHED).catch((caught: unknown) => caught);

    expect((error as NotionApiError).code).toBe('not_found');
    expect((error as NotionApiError).status).toBe(404);
  });

  it('maps a transport failure to network_error', async () => {
    await connect();
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const error = await getDatabaseSchema('user-1', DB_DASHED).catch((caught: unknown) => caught);

    expect((error as NotionApiError).code).toBe('network_error');
  });
});
