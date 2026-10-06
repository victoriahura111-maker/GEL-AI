import request from 'supertest';
import { createApp } from '../../server/src/app';
import {
  getConversation,
  listConversations,
  listMessages,
} from '../../server/src/services/conversations';

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

jest.mock('../../server/src/services/conversations', () => ({
  getConversation: jest.fn(),
  getOrCreateConversation: jest.fn(),
  appendMessage: jest.fn(),
  listMessages: jest.fn(),
  listConversations: jest.fn(),
}));

const mockGetConversation = getConversation as jest.Mock;
const mockListMessages = listMessages as jest.Mock;
const mockListConversations = listConversations as jest.Mock;

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('conversation routes', () => {
  describe('GET /api/conversations', () => {
    it('returns the caller-scoped conversation list', async () => {
      mockListConversations.mockResolvedValue([{ id: CONVERSATION_ID, user_id: 'user-1' }]);

      const response = await request(createApp()).get('/api/conversations');

      expect(response.status).toBe(200);
      expect(response.body.conversations).toHaveLength(1);
      expect(mockListConversations).toHaveBeenCalledWith('user-1');
    });
  });

  describe('GET /api/conversations/:id/messages', () => {
    it('rejects a malformed conversation id with 400', async () => {
      const response = await request(createApp()).get('/api/conversations/not-a-uuid/messages');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid conversation id');
      expect(mockGetConversation).not.toHaveBeenCalled();
    });

    it('returns 404 when the conversation is not owned by the caller', async () => {
      mockGetConversation.mockResolvedValue(null);

      const response = await request(createApp()).get(
        `/api/conversations/${CONVERSATION_ID}/messages`
      );

      expect(response.status).toBe(404);
      expect(mockGetConversation).toHaveBeenCalledWith('user-1', CONVERSATION_ID);
      expect(mockListMessages).not.toHaveBeenCalled();
    });

    it('returns the owned conversation messages', async () => {
      mockGetConversation.mockResolvedValue({ id: CONVERSATION_ID, user_id: 'user-1' });
      mockListMessages.mockResolvedValue([
        { id: 'm-1', conversation_id: CONVERSATION_ID, user_id: 'user-1', role: 'user' },
      ]);

      const response = await request(createApp())
        .get(`/api/conversations/${CONVERSATION_ID}/messages`)
        .query({ limit: 10 });

      expect(response.status).toBe(200);
      expect(response.body.messages).toHaveLength(1);
      expect(mockListMessages).toHaveBeenCalledWith('user-1', CONVERSATION_ID, 10);
    });

    it('rejects an invalid limit with 400', async () => {
      const response = await request(createApp())
        .get(`/api/conversations/${CONVERSATION_ID}/messages`)
        .query({ limit: -3 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid query parameters');
    });
  });
});
