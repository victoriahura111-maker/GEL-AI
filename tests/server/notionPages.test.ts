import {
  createNotionPage,
  retrievePage,
  updatePage,
} from '../../server/src/services/notion/pages';
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
const PAGE_COMPACT = '11111111222233334444555566667777';
const PAGE_DASHED = '11111111-2222-3333-4444-555566667777';

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

describe('createNotionPage', () => {
  it('POSTs to /pages with parent.database_id and the properties, returning { id, url }', async () => {
    await connect();
    stubJson({ id: PAGE_COMPACT, url: 'https://www.notion.so/page' });

    const properties = { Name: { title: [{ text: { content: 'Write report' } }] } };
    const page = await createNotionPage('user-1', DB_COMPACT, properties);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = lastCall();
    expect(url).toBe('https://api.notion.com/v1/pages');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Notion-Version']).toBe('2022-06-28');
    expect(headers['Content-Type']).toBe('application/json');

    expect(JSON.parse(String(init.body))).toEqual({
      parent: { database_id: DB_DASHED },
      properties,
    });

    expect(page).toEqual({ id: PAGE_DASHED, url: 'https://www.notion.so/page' });
    // The token is never part of the returned summary.
    expect(JSON.stringify(page)).not.toContain(TOKEN);
  });

  it('returns url: null when Notion omits the url', async () => {
    await connect();
    stubJson({ id: PAGE_COMPACT });

    const page = await createNotionPage('user-1', DB_DASHED, {});

    expect(page).toEqual({ id: PAGE_DASHED, url: null });
  });

  it('throws a typed not_connected error (and never calls Notion) without a connection', async () => {
    const error = await createNotionPage('user-1', DB_DASHED, {}).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).code).toBe('not_connected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 401 to a reconnect error without leaking the token', async () => {
    await connect();
    stubJson({ message: TOKEN, code: 'unauthorized' }, false, 401);

    const error = await createNotionPage('user-1', DB_DASHED, {}).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).code).toBe('unauthorized');
    expect((error as NotionApiError).status).toBe(401);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('maps a transport failure to network_error', async () => {
    await connect();
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const error = await createNotionPage('user-1', DB_DASHED, {}).catch(
      (caught: unknown) => caught
    );

    expect((error as NotionApiError).code).toBe('network_error');
    expect((error as Error).message).not.toContain('socket hang up');
  });

  it('throws when Notion returns no usable page id', async () => {
    await connect();
    stubJson({ url: 'https://www.notion.so/page' });

    const error = await createNotionPage('user-1', DB_DASHED, {}).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/usable page id/i);
  });
});

describe('retrievePage', () => {
  it('GETs /pages/:id with a normalised id and returns { id, url }', async () => {
    await connect();
    stubJson({ id: PAGE_COMPACT, url: 'https://www.notion.so/page' });

    const page = await retrievePage('user-1', PAGE_COMPACT);

    const { url, init } = lastCall();
    expect(url).toBe(`https://api.notion.com/v1/pages/${PAGE_DASHED}`);
    expect(init.method).toBe('GET');
    expect(page).toEqual({ id: PAGE_DASHED, url: 'https://www.notion.so/page' });
  });
});

describe('updatePage', () => {
  it('PATCHes /pages/:id with a { properties } body', async () => {
    await connect();
    stubJson({ id: PAGE_COMPACT, url: 'https://www.notion.so/page' });

    const properties = { Status: { status: { name: 'Done' } } };
    const page = await updatePage('user-1', PAGE_COMPACT, properties);

    const { url, init } = lastCall();
    expect(url).toBe(`https://api.notion.com/v1/pages/${PAGE_DASHED}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ properties });
    expect(page.id).toBe(PAGE_DASHED);
  });

  it('maps 404 to not_found', async () => {
    await connect();
    stubJson({}, false, 404);

    const error = await updatePage('user-1', PAGE_DASHED, {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).code).toBe('not_found');
    expect((error as NotionApiError).status).toBe(404);
  });
});
