import {
  getDatabaseRaw,
  listDatabases,
  NotionApiError,
} from '../../server/src/services/notion/client';
import {
  archivePage,
  createNotionPage,
  retrievePage,
  updatePage,
} from '../../server/src/services/notion/pages';
import { upsertConnection } from '../../server/src/services/notion/connectionRepository';
import { supabaseAdmin } from '../../server/src/services/supabase';
import type { FakeSupabaseClient } from './supabaseFake';

/**
 * Phase 18 — Notion failure matrix.
 *
 * Every Notion operation is exercised against each upstream failure shape
 * (401/403/404/429/5xx, an unreadable body, and a dead transport) to prove the
 * failures are mapped to the typed, user-safe `NotionApiError` codes that the
 * routes depend on — and that the access token never leaks into an error.
 *
 * Nothing touches the network: the connection repository runs on the in-memory
 * PostgREST fake and `fetch` is a stub.
 */

jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

const fake = supabaseAdmin as unknown as FakeSupabaseClient;

const TOKEN = 'secret-notion-token';
const DB_COMPACT = 'AB12CD34EF56AB78CD90EF12AB34CD56';
const PAGE_COMPACT = '11111111222233334444555566667777';

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

function refuse(status: number): void {
  fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ message: TOKEN }) });
}

function unreadable(): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('invalid json');
    },
  });
}

function transportDown(): void {
  fetchMock.mockRejectedValue(new Error(`ECONNREFUSED ${TOKEN}`));
}

async function capture(promise: Promise<unknown>): Promise<NotionApiError> {
  return promise.then(
    () => {
      throw new Error('Expected the promise to reject.');
    },
    (error: unknown) => error as NotionApiError
  );
}

function expectSafe(error: NotionApiError, code: string, status: number | null): void {
  expect(error).toBeInstanceOf(NotionApiError);
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
  // The token must never appear in a user-facing error.
  expect(error.message).not.toContain(TOKEN);
}

describe('listDatabases — failure mapping', () => {
  beforeEach(connect);

  it('maps 401 to unauthorized', async () => {
    refuse(401);
    expectSafe(await capture(listDatabases('user-1')), 'unauthorized', 401);
  });

  it('maps 403 to forbidden', async () => {
    refuse(403);
    expectSafe(await capture(listDatabases('user-1')), 'forbidden', 403);
  });

  it('maps 429 to rate_limited', async () => {
    refuse(429);
    expectSafe(await capture(listDatabases('user-1')), 'rate_limited', 429);
  });

  it('maps 500 to api_error', async () => {
    refuse(500);
    expectSafe(await capture(listDatabases('user-1')), 'api_error', 500);
  });

  it('maps an unreadable 200 body to invalid_response', async () => {
    unreadable();
    expectSafe(await capture(listDatabases('user-1')), 'invalid_response', 200);
  });

  it('maps a transport failure to network_error', async () => {
    transportDown();
    expectSafe(await capture(listDatabases('user-1')), 'network_error', null);
  });
});

describe('getDatabaseRaw — failure mapping', () => {
  beforeEach(connect);

  it('maps 403 to forbidden', async () => {
    refuse(403);
    expectSafe(await capture(getDatabaseRaw('user-1', DB_COMPACT)), 'forbidden', 403);
  });

  it('maps 404 to not_found', async () => {
    refuse(404);
    expectSafe(await capture(getDatabaseRaw('user-1', DB_COMPACT)), 'not_found', 404);
  });

  it('maps 429 to rate_limited', async () => {
    refuse(429);
    expectSafe(await capture(getDatabaseRaw('user-1', DB_COMPACT)), 'rate_limited', 429);
  });

  it('maps 503 to api_error', async () => {
    refuse(503);
    expectSafe(await capture(getDatabaseRaw('user-1', DB_COMPACT)), 'api_error', 503);
  });

  it('maps a transport failure to network_error', async () => {
    transportDown();
    expectSafe(await capture(getDatabaseRaw('user-1', DB_COMPACT)), 'network_error', null);
  });
});

describe('page writes — failure mapping', () => {
  beforeEach(connect);

  it('createNotionPage maps 429 to rate_limited', async () => {
    refuse(429);
    expectSafe(await capture(createNotionPage('user-1', DB_COMPACT, {})), 'rate_limited', 429);
  });

  it('createNotionPage maps 500 to api_error', async () => {
    refuse(500);
    expectSafe(await capture(createNotionPage('user-1', DB_COMPACT, {})), 'api_error', 500);
  });

  it('createNotionPage maps a transport failure to network_error', async () => {
    transportDown();
    expectSafe(await capture(createNotionPage('user-1', DB_COMPACT, {})), 'network_error', null);
  });

  it('updatePage maps 403 to forbidden', async () => {
    refuse(403);
    expectSafe(await capture(updatePage('user-1', PAGE_COMPACT, {})), 'forbidden', 403);
  });

  it('updatePage maps 502 to api_error', async () => {
    refuse(502);
    expectSafe(await capture(updatePage('user-1', PAGE_COMPACT, {})), 'api_error', 502);
  });

  it('retrievePage maps 404 to not_found', async () => {
    refuse(404);
    expectSafe(await capture(retrievePage('user-1', PAGE_COMPACT)), 'not_found', 404);
  });

  it('archivePage maps a transport failure to network_error', async () => {
    transportDown();
    expectSafe(await capture(archivePage('user-1', PAGE_COMPACT)), 'network_error', null);
  });

  it('never calls Notion when the user is not connected', async () => {
    const error = await createNotionPage('user-2', DB_COMPACT, {}).catch(
      (caught: unknown) => caught
    );
    expect((error as NotionApiError).code).toBe('not_connected');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
