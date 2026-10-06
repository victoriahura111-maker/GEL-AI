import request from 'supertest';
import { createApp } from '../../server/src/app';
import { getDatabaseRaw, NotionApiError } from '../../server/src/services/notion/client';
import { clearSchemaCache } from '../../server/src/services/notion/schema';

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
// network-touching raw fetch used by the schema service.
jest.mock('../../server/src/services/notion/client', () => {
  const actual = jest.requireActual<typeof import('../../server/src/services/notion/client')>(
    '../../server/src/services/notion/client'
  );
  return { ...actual, getDatabaseRaw: jest.fn() };
});

const mockGetDatabaseRaw = getDatabaseRaw as unknown as jest.Mock;

const DB = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6';
const DB_COMPACT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function rawDatabase(): Record<string, unknown> {
  return {
    id: DB_COMPACT,
    title: [{ plain_text: 'Work Tasks' }],
    properties: {
      Name: { id: 'title-1', type: 'title', title: {} },
      Status: {
        id: 'status-1',
        type: 'status',
        status: { options: [{ id: 'o1', name: 'Done' }] },
      },
      Formula: { id: 'formula-1', type: 'formula', formula: {} },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearSchemaCache();
});

describe('GET /api/notion/databases/:databaseId/schema', () => {
  it('returns the normalised schema, mapping and unsupported properties', async () => {
    mockGetDatabaseRaw.mockResolvedValue(rawDatabase());

    const response = await request(createApp()).get(`/api/notion/databases/${DB_COMPACT}/schema`);

    expect(response.status).toBe(200);
    expect(response.body.database).toEqual({ id: DB, title: 'Work Tasks' });
    expect(response.body.properties).toEqual([
      { id: 'title-1', name: 'Name', type: 'title' },
      { id: 'status-1', name: 'Status', type: 'status', options: [{ id: 'o1', name: 'Done' }] },
      { id: 'formula-1', name: 'Formula', type: 'formula' },
    ]);
    expect(response.body.mapping).toMatchObject({ title: 'Name', status: 'Status' });
    expect(response.body.unsupported).toEqual([{ name: 'Formula', type: 'formula' }]);

    // The raw id is normalised before the provider call.
    expect(mockGetDatabaseRaw).toHaveBeenCalledWith('user-1', DB);
  });

  it('returns 409 when Notion is not connected', async () => {
    mockGetDatabaseRaw.mockRejectedValue(
      new NotionApiError('Connect Notion first.', 'not_connected', null)
    );

    const response = await request(createApp()).get(`/api/notion/databases/${DB}/schema`);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/connect notion/i);
  });

  it('returns 409 with reconnect guidance when the connection is invalid', async () => {
    mockGetDatabaseRaw.mockRejectedValue(
      new NotionApiError('Reconnect Notion to continue.', 'unauthorized', 401)
    );

    const response = await request(createApp()).get(`/api/notion/databases/${DB}/schema`);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/reconnect/i);
  });

  it('returns 404 when the database cannot be found', async () => {
    mockGetDatabaseRaw.mockRejectedValue(
      new NotionApiError('That Notion resource could not be found.', 'not_found', 404)
    );

    const response = await request(createApp()).get(`/api/notion/databases/${DB}/schema`);

    expect(response.status).toBe(404);
  });

  it('returns 502 for an upstream provider failure', async () => {
    mockGetDatabaseRaw.mockRejectedValue(
      new NotionApiError('Notion could not complete the request.', 'api_error', 500)
    );

    const response = await request(createApp()).get(`/api/notion/databases/${DB}/schema`);

    expect(response.status).toBe(502);
  });

  it('rejects a malformed database id with 400 before calling Notion', async () => {
    const response = await request(createApp()).get('/api/notion/databases/not-a-notion-id/schema');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid Notion database id');
    expect(mockGetDatabaseRaw).not.toHaveBeenCalled();
  });
});
