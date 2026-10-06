import request from 'supertest';
import { createApp } from '../../server/src/app';
import { createState, resetOAuthStateStore } from '../../server/src/services/notion/oauthState';
import { buildAuthorizationUrl } from '../../server/src/services/notion/oauth';
import { supabaseAdmin } from '../../server/src/services/supabase';
import { decrypt } from '../../server/src/utils/encryption';
import type { FakeSupabaseClient } from './supabaseFake';

// Back the connection repository with the in-memory PostgREST fake so the full
// "exchange -> encrypt -> store" path runs without any real database.
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

// Keep the real OAuth module (so the callback exchanges for real) but allow the
// authorization-URL builder to be forced to fail for the unconfigured case.
jest.mock('../../server/src/services/notion/oauth', () => {
  const actual = jest.requireActual<typeof import('../../server/src/services/notion/oauth')>(
    '../../server/src/services/notion/oauth'
  );
  return { ...actual, buildAuthorizationUrl: jest.fn(actual.buildAuthorizationUrl) };
});

const fake = supabaseAdmin as unknown as FakeSupabaseClient;
const mockBuildAuthorizationUrl = buildAuthorizationUrl as jest.Mock;

const CONNECTED_REDIRECT = 'http://localhost:5173/settings/notion?notion=connected';
const TOKEN = 'secret-notion-token';

const ORIGINAL_FETCH = globalThis.fetch;
const fetchMock = jest.fn();

function connectionRows() {
  return fake.__store.notion_connections ?? [];
}

/** Stubs a successful Notion token exchange. */
function stubTokenResponse() {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: TOKEN,
      bot_id: 'bot-1',
      workspace_id: 'ws-1',
      workspace_name: 'Ada Workspace',
      workspace_icon: 'https://example.test/icon.png',
      owner: { type: 'user', user: { id: 'notion-user-1' } },
    }),
  });
}

function lastFetchInit(): Record<string, unknown> {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, Record<string, unknown>];
  return call[1];
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
  fake.__queries.length = 0;
  resetOAuthStateStore();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('GET /api/notion/oauth/start', () => {
  it('returns a public authorization URL containing client_id, redirect_uri and state', async () => {
    const response = await request(createApp()).get('/api/notion/oauth/start');

    expect(response.status).toBe(200);

    const url = new URL(response.body.authorizationUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.notion.com/v1/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-notion-client-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('owner')).toBe('user');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/api/notion/oauth/callback'
    );
    expect(url.searchParams.get('state')).toBeTruthy();

    // The client secret must never be part of the browser-facing URL.
    expect(response.body.authorizationUrl).not.toContain('test-notion-client-secret');
  });

  it('returns 503 when Notion is not configured', async () => {
    const { NotionOAuthError } = jest.requireActual<
      typeof import('../../server/src/services/notion/oauth')
    >('../../server/src/services/notion/oauth');
    mockBuildAuthorizationUrl.mockImplementationOnce(() => {
      throw new NotionOAuthError('Notion is not configured.', 'not_configured');
    });

    const response = await request(createApp()).get('/api/notion/oauth/start');

    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/not configured/i);
  });
});

describe('GET /api/notion/oauth/callback', () => {
  it('exchanges the code, encrypts and stores the token, then redirects to connected', async () => {
    stubTokenResponse();
    const state = createState('user-1');

    const response = await request(createApp())
      .get('/api/notion/oauth/callback')
      .query({ code: 'auth-code', state });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(CONNECTED_REDIRECT);

    // The token exchange request is built correctly and server-side only.
    const init = lastFetchInit();
    const headers = init.headers as Record<string, string>;
    expect(headers['Notion-Version']).toBe('2022-06-28');
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('test-notion-client-id:test-notion-client-secret').toString('base64')}`
    );
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code',
      redirect_uri: 'http://localhost:4000/api/notion/oauth/callback',
    });

    // Stored token is ciphertext (never the raw token) and decrypts back.
    expect(connectionRows()).toHaveLength(1);
    expect(connectionRows()[0].user_id).toBe('user-1');
    expect(connectionRows()[0].access_token_encrypted).not.toBe(TOKEN);
    expect(String(connectionRows()[0].access_token_encrypted)).not.toContain(TOKEN);
    expect(decrypt(connectionRows()[0].access_token_encrypted as string)).toBe(TOKEN);

    // The token is never present in the redirect response.
    expect(response.headers.location).not.toContain(TOKEN);
    expect(response.text).not.toContain(TOKEN);
  });

  it('never surfaces the token through the connection status endpoint', async () => {
    stubTokenResponse();
    const state = createState('user-1');

    await request(createApp()).get('/api/notion/oauth/callback').query({ code: 'c', state });
    const status = await request(createApp()).get('/api/notion/connection');

    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      connected: true,
      workspaceName: 'Ada Workspace',
      workspaceId: 'ws-1',
    });
    expect(JSON.stringify(status.body)).not.toContain(TOKEN);
    expect(status.body).not.toHaveProperty('accessToken');
    expect(status.body).not.toHaveProperty('access_token_encrypted');
  });

  it('redirects to an error URL for a malformed state and never calls Notion', async () => {
    const response = await request(createApp())
      .get('/api/notion/oauth/callback')
      .query({ code: 'c', state: 'garbage' });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('notion=error');
    expect(response.headers.location).toContain('reason=state_malformed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects to an error URL for an expired state', async () => {
    const state = createState('user-1', -5);

    const response = await request(createApp())
      .get('/api/notion/oauth/callback')
      .query({ code: 'c', state });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('reason=state_expired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a replayed state', async () => {
    stubTokenResponse();
    const state = createState('user-1');

    const first = await request(createApp())
      .get('/api/notion/oauth/callback')
      .query({ code: 'c', state });
    expect(first.headers.location).toBe(CONNECTED_REDIRECT);

    const second = await request(createApp())
      .get('/api/notion/oauth/callback')
      .query({ code: 'c', state });
    expect(second.headers.location).toContain('reason=state_replayed');
  });

  it('redirects to an error URL when Notion returns an error param', async () => {
    const response = await request(createApp())
      .get('/api/notion/oauth/callback')
      .query({ error: 'access_denied', state: 'irrelevant' });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('notion=error');
    expect(response.headers.location).toContain('reason=access_denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects to an error URL when the authorization code is missing', async () => {
    const state = createState('user-1');

    const response = await request(createApp())
      .get('/api/notion/oauth/callback')
      .query({ state });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('reason=missing_code');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects to a safe error URL when the token exchange fails, without leaking', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: TOKEN, message: 'notion failure' }),
    });
    const state = createState('user-1');

    const response = await request(createApp())
      .get('/api/notion/oauth/callback')
      .query({ code: 'c', state });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('reason=exchange_failed');
    expect(response.headers.location).not.toContain(TOKEN);
    expect(response.headers.location).not.toContain('test-notion-client-secret');
    expect(connectionRows()).toHaveLength(0);
  });
});
