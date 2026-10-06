import request from 'supertest';
import { createApp } from '../../server/src/app';
import {
  checkSyncCooldown,
  getSyncStatus,
  isNotionConnected,
  isSyncConfigured,
  recordSyncAttempt,
  syncUser,
} from '../../server/src/services/sync';
import type { SyncStatus, SyncSummary } from '../../server/src/services/sync';

/**
 * Phase 16 — `/api/sync` route contract. Auth is injected and the sync service
 * is mocked; nothing touches Supabase or Notion.
 */

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

jest.mock('../../server/src/services/sync', () => ({
  isSyncConfigured: jest.fn(),
  isNotionConnected: jest.fn(),
  checkSyncCooldown: jest.fn(),
  recordSyncAttempt: jest.fn(),
  syncUser: jest.fn(),
  getSyncStatus: jest.fn(),
}));

const mockConfigured = isSyncConfigured as jest.Mock;
const mockConnected = isNotionConnected as jest.Mock;
const mockCooldown = checkSyncCooldown as jest.Mock;
const mockRecordAttempt = recordSyncAttempt as jest.Mock;
const mockSyncUser = syncUser as jest.Mock;
const mockGetStatus = getSyncStatus as jest.Mock;

const app = createApp();

const SUMMARY: SyncSummary = {
  direction: 'both',
  pulled: { created: 1, updated: 0, skipped: 0 },
  pushed: { updated: 0, failed: 0 },
  errors: [],
  startedAt: '2026-06-01T00:00:00.000Z',
  finishedAt: '2026-06-01T00:00:01.000Z',
};

const STATUS: SyncStatus = {
  lastSyncedAt: '2026-06-01T00:00:00.000Z',
  lastDirection: 'both',
  lastError: null,
  counts: { synced: 3, pending: 1, error: 0 },
  recentErrors: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigured.mockReturnValue(true);
  mockConnected.mockResolvedValue(true);
  mockCooldown.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  mockSyncUser.mockResolvedValue(SUMMARY);
  mockGetStatus.mockResolvedValue(STATUS);
});

describe('POST /api/sync', () => {
  it('runs a manual sync and returns the summary', async () => {
    const response = await request(app).post('/api/sync').send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ direction: 'both', pulled: { created: 1 } });
    expect(mockSyncUser).toHaveBeenCalledWith('user-1', { direction: 'both' });
    expect(mockRecordAttempt).toHaveBeenCalledWith('user-1');
  });

  it('passes an explicit direction through', async () => {
    await request(app).post('/api/sync').send({ direction: 'pull' });

    expect(mockSyncUser).toHaveBeenCalledWith('user-1', { direction: 'pull' });
  });

  it('returns 400 for an invalid direction', async () => {
    const response = await request(app).post('/api/sync').send({ direction: 'sideways' });

    expect(response.status).toBe(400);
    expect(mockSyncUser).not.toHaveBeenCalled();
  });

  it('returns 409 when Notion is not connected', async () => {
    mockConnected.mockResolvedValue(false);

    const response = await request(app).post('/api/sync').send({});

    expect(response.status).toBe(409);
    expect(mockSyncUser).not.toHaveBeenCalled();
  });

  it('returns 429 during the per-user cooldown', async () => {
    mockCooldown.mockReturnValue({ allowed: false, retryAfterMs: 5000 });

    const response = await request(app).post('/api/sync').send({});

    expect(response.status).toBe(429);
    expect(response.body.retryAfterMs).toBe(5000);
    expect(mockSyncUser).not.toHaveBeenCalled();
    expect(mockRecordAttempt).not.toHaveBeenCalled();
  });

  it('returns 503 when synchronization is not configured', async () => {
    mockConfigured.mockReturnValue(false);

    const response = await request(app).post('/api/sync').send({});

    expect(response.status).toBe(503);
    expect(mockSyncUser).not.toHaveBeenCalled();
  });
});

describe('GET /api/sync/status', () => {
  it('returns the sync status shape', async () => {
    const response = await request(app).get('/api/sync/status');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      lastSyncedAt: '2026-06-01T00:00:00.000Z',
      counts: { synced: 3, pending: 1, error: 0 },
    });
    expect(mockGetStatus).toHaveBeenCalledWith('user-1');
  });

  it('returns 503 when synchronization is not configured', async () => {
    mockConfigured.mockReturnValue(false);

    const response = await request(app).get('/api/sync/status');

    expect(response.status).toBe(503);
    expect(mockGetStatus).not.toHaveBeenCalled();
  });
});
