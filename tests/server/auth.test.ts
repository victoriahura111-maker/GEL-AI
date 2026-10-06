import request from 'supertest';
import { createApp } from '../../server/src/app';
import { supabaseAdmin } from '../../server/src/services/supabase';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: { getUser: jest.fn() },
    from: jest.fn(),
  })),
}));

type AdminMock = {
  auth: { getUser: jest.Mock };
  from: jest.Mock;
};

const admin = supabaseAdmin as unknown as AdminMock;

const profile = {
  id: 'user-1',
  email: 'ada@example.com',
  full_name: null,
  timezone: 'UTC',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const validUser = { id: 'user-1', email: 'ada@example.com' };

function mockFromResult(result: unknown) {
  admin.from.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(result),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('auth routes', () => {
  describe('GET /api/auth/me', () => {
    it('returns 401 without a token', async () => {
      const app = createApp();
      const response = await request(app).get('/api/auth/me');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 with an invalid token', async () => {
      admin.auth.getUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'invalid token' },
      });

      const app = createApp();
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });

    it('returns 200 and the profile shape for a valid token', async () => {
      admin.auth.getUser.mockResolvedValue({ data: { user: validUser }, error: null });
      mockFromResult({ data: profile, error: null });

      const app = createApp();
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        user: { id: 'user-1', email: 'ada@example.com' },
        profile,
      });
    });
  });

  describe('PATCH /api/auth/profile', () => {
    it('rejects invalid payloads with 400', async () => {
      admin.auth.getUser.mockResolvedValue({ data: { user: validUser }, error: null });

      const app = createApp();
      const response = await request(app)
        .patch('/api/auth/profile')
        .set('Authorization', 'Bearer valid-token')
        .send({ full_name: 123 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid request body');
    });

    it('accepts valid payloads and returns the updated profile', async () => {
      const updatedProfile = {
        ...profile,
        full_name: 'Ada Lovelace',
        timezone: 'Africa/Lagos',
      };

      admin.auth.getUser.mockResolvedValue({ data: { user: validUser }, error: null });
      mockFromResult({ data: updatedProfile, error: null });

      const app = createApp();
      const response = await request(app)
        .patch('/api/auth/profile')
        .set('Authorization', 'Bearer valid-token')
        .send({ full_name: 'Ada Lovelace', timezone: 'Africa/Lagos' });

      expect(response.status).toBe(200);
      expect(response.body.profile.full_name).toBe('Ada Lovelace');
      expect(response.body.profile.timezone).toBe('Africa/Lagos');
    });
  });
});
