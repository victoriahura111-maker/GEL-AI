import {
  getDatabase,
  listDatabases,
  NotionApiError,
} from '../../server/src/services/notion/client';
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
const ORIGINAL_FETCH = globalThis.fetch;
const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
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

function stubJson(payload: unknown, ok = true, status = 200): void {
  fetchMock.mockResolvedValue({ ok, status, json: async () => payload });
}

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

describe('Notion API client — listDatabases', () => {
  it('throws a typed not_connected error (and never calls Notion) without a connection', async () => {
    const error = await listDatabases('user-1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).code).toBe('not_connected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds the /search request and normalises the results', async () => {
    await connect();
    stubJson({
      object: 'list',
      results: [
        {
          object: 'database',
          id: 'AB12CD34EF56AB78CD90EF12AB34CD56',
          title: [{ plain_text: 'Work Tasks' }],
          url: 'https://www.notion.so/work',
          icon: { type: 'emoji', emoji: '📋' },
        },
        {
          object: 'database',
          id: '11111111-2222-3333-4444-555555555555',
          title: [],
          url: null,
          icon: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    });

    const databases = await listDatabases('user-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = lastCall();
    expect(url).toBe('https://api.notion.com/v1/search');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Notion-Version']).toBe('2022-06-28');

    expect(JSON.parse(String(init.body))).toEqual({
      filter: { property: 'object', value: 'database' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 100,
    });

    expect(databases[0]).toEqual({
      id: 'ab12cd34-ef56-ab78-cd90-ef12ab34cd56',
      title: 'Work Tasks',
      url: 'https://www.notion.so/work',
      icon: '📋',
    });
    expect(databases[1]).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      title: 'Untitled',
      url: null,
      icon: null,
    });

    // The access token is never part of the normalised result.
    expect(JSON.stringify(databases)).not.toContain(TOKEN);
  });

  it('follows next_cursor pagination', async () => {
    await connect();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { id: 'aaaaaaaa-1111-2222-3333-444444444444', title: [{ plain_text: 'A' }] },
          ],
          has_more: true,
          next_cursor: 'cursor-1',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { id: 'bbbbbbbb-1111-2222-3333-444444444444', title: [{ plain_text: 'B' }] },
          ],
          has_more: false,
          next_cursor: null,
        }),
      });

    const databases = await listDatabases('user-1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(secondBody.start_cursor).toBe('cursor-1');
    expect(databases.map((database) => database.title)).toEqual(['A', 'B']);
  });

  it('caps pagination at MAX_SEARCH_PAGES', async () => {
    await connect();
    // Always report more pages; the client must stop at the safe cap (5).
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], has_more: true, next_cursor: 'next' }),
    });

    await listDatabases('user-1');

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe('Notion API client — error mapping', () => {
  it('maps 401 to a reconnect error without leaking the token', async () => {
    await connect();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: TOKEN, code: 'unauthorized' }),
    });

    const error = await listDatabases('user-1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).code).toBe('unauthorized');
    expect((error as NotionApiError).status).toBe(401);
    expect((error as Error).message).toMatch(/reconnect/i);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('maps 403 to a reconnect error', async () => {
    await connect();
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

    const error = await listDatabases('user-1').catch((caught: unknown) => caught);

    expect((error as NotionApiError).code).toBe('forbidden');
    expect((error as NotionApiError).status).toBe(403);
  });

  it('maps 429 to a rate_limited error', async () => {
    await connect();
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

    const error = await listDatabases('user-1').catch((caught: unknown) => caught);

    expect((error as NotionApiError).code).toBe('rate_limited');
  });

  it('maps a transport failure to a network_error', async () => {
    await connect();
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const error = await listDatabases('user-1').catch((caught: unknown) => caught);

    expect((error as NotionApiError).code).toBe('network_error');
    expect((error as Error).message).not.toContain('socket hang up');
  });
});

describe('Notion API client — getDatabase', () => {
  it('fetches a single database by its normalised id', async () => {
    await connect();
    stubJson({
      id: 'AB12CD34EF56AB78CD90EF12AB34CD56',
      title: [{ plain_text: 'School' }],
      url: null,
      icon: null,
    });

    const database = await getDatabase('user-1', 'AB12CD34-EF56-AB78-CD90-EF12AB34CD56');

    expect(lastCall().url).toBe(
      'https://api.notion.com/v1/databases/ab12cd34-ef56-ab78-cd90-ef12ab34cd56'
    );
    expect(database).toEqual({
      id: 'ab12cd34-ef56-ab78-cd90-ef12ab34cd56',
      title: 'School',
      url: null,
      icon: null,
    });
  });
});
