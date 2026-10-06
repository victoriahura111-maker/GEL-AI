import request from 'supertest';
import { createApp } from '../../server/src/app';
import { upsertConnection } from '../../server/src/services/notion/connectionRepository';
import { supabaseAdmin } from '../../server/src/services/supabase';
import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

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

const fake = supabaseAdmin as unknown as FakeSupabaseClient;

const TOKEN = 'secret-notion-token';

function connectionRows(): FakeRow[] {
  return fake.__store.notion_connections ?? [];
}

beforeEach(() => {
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
  fake.__queries.length = 0;
});

describe('Notion connection routes', () => {
  it('GET /api/notion/connection reports a safe "not connected" shape', async () => {
    const response = await request(createApp()).get('/api/notion/connection');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      connected: false,
      workspaceName: null,
      workspaceIcon: null,
      workspaceId: null,
      connectedAt: null,
    });
  });

  it('GET /api/notion/connection returns status and never the token', async () => {
    await upsertConnection('user-1', {
      accessToken: TOKEN,
      botId: 'bot-1',
      workspaceId: 'ws-1',
      workspaceName: 'Ada Workspace',
      workspaceIcon: 'https://example.test/icon.png',
      owner: { type: 'user' },
    });

    const response = await request(createApp()).get('/api/notion/connection');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      workspaceName: 'Ada Workspace',
      workspaceId: 'ws-1',
    });
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
    expect(response.body).not.toHaveProperty('accessToken');
    expect(response.body).not.toHaveProperty('access_token_encrypted');
  });

  it('DELETE /api/notion/connection removes the stored connection', async () => {
    await upsertConnection('user-1', {
      accessToken: TOKEN,
      botId: null,
      workspaceId: 'ws-1',
      workspaceName: 'Ada Workspace',
      workspaceIcon: null,
      owner: null,
    });
    expect(connectionRows()).toHaveLength(1);

    const response = await request(createApp()).delete('/api/notion/connection');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: false });
    expect(connectionRows()).toHaveLength(0);

    const after = await request(createApp()).get('/api/notion/connection');
    expect(after.body.connected).toBe(false);
  });

  it('scopes reads and deletes to the authenticated user', async () => {
    fake.__store.notion_connections = [
      {
        id: 'conn-other',
        user_id: 'user-2',
        access_token_encrypted: 'irrelevant-ciphertext',
        bot_id: null,
        workspace_id: 'ws-2',
        workspace_name: 'Other Workspace',
        workspace_icon: null,
        owner: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];

    const status = await request(createApp()).get('/api/notion/connection');
    expect(status.body.connected).toBe(false);

    const deleted = await request(createApp()).delete('/api/notion/connection');
    expect(deleted.status).toBe(200);
    expect(connectionRows()).toHaveLength(1);
    expect(connectionRows()[0].user_id).toBe('user-2');
  });
});
