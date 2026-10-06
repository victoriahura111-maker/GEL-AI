import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

import { supabaseAdmin } from '../../server/src/services/supabase';
import {
  appendMessage,
  getConversation,
  getOrCreateConversation,
  isUuid,
  listConversations,
  listMessages,
} from '../../server/src/services/conversations';

const fake = supabaseAdmin as unknown as FakeSupabaseClient;

const USER_A = 'user-a';
const USER_B = 'user-b';
const OWNED_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_ID = '22222222-2222-4222-8222-222222222222';

function conversations(): FakeRow[] {
  return fake.__store.assistant_conversations ?? [];
}

function messages(): FakeRow[] {
  return fake.__store.assistant_messages ?? [];
}

function lastFilterCalls(): Array<[string, unknown]> {
  return fake.__queries[fake.__queries.length - 1].filterCalls;
}

beforeEach(() => {
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
  fake.__queries.length = 0;
});

describe('conversation persistence', () => {
  describe('getOrCreateConversation', () => {
    it('reuses a conversation owned by the caller', async () => {
      fake.__store.assistant_conversations = [{ id: OWNED_ID, user_id: USER_A }];

      const conversation = await getOrCreateConversation(USER_A, OWNED_ID);

      expect(conversation?.id).toBe(OWNED_ID);
      expect(conversation?.user_id).toBe(USER_A);
      expect(conversations()).toHaveLength(1);
    });

    it('scopes the ownership lookup by user_id', async () => {
      fake.__store.assistant_conversations = [{ id: OWNED_ID, user_id: USER_A }];

      await getOrCreateConversation(USER_A, OWNED_ID);

      expect(lastFilterCalls()).toContainEqual(['id', OWNED_ID]);
      expect(lastFilterCalls()).toContainEqual(['user_id', USER_A]);
    });

    it('creates a new conversation (never returns the foreign one) for another user\'s id', async () => {
      fake.__store.assistant_conversations = [{ id: FOREIGN_ID, user_id: USER_B }];

      const conversation = await getOrCreateConversation(USER_A, FOREIGN_ID);

      expect(conversation).not.toBeNull();
      expect(conversation?.id).not.toBe(FOREIGN_ID);
      expect(conversation?.user_id).toBe(USER_A);
      expect(conversations()).toHaveLength(2);
      expect(conversations().some((row) => row.id === FOREIGN_ID && row.user_id === USER_B)).toBe(
        true
      );
    });

    it('creates a new conversation when no id is supplied', async () => {
      const conversation = await getOrCreateConversation(USER_A);

      expect(conversation?.user_id).toBe(USER_A);
      expect(isUuid(conversation?.id as string)).toBe(true);
      expect(conversations()).toHaveLength(1);
    });

    it('creates a new conversation for a malformed id', async () => {
      const conversation = await getOrCreateConversation(USER_A, 'not-a-uuid');

      expect(conversation?.id).not.toBe('not-a-uuid');
      expect(conversation?.user_id).toBe(USER_A);
    });
  });

  describe('appendMessage', () => {
    it('inserts the correct conversation/user/role and serializes cards', async () => {
      const cards = [
        { type: 'task', title: 'Write report', priority: 'high', actions: ['create', 'edit'] },
      ];

      const message = await appendMessage(USER_A, OWNED_ID, {
        role: 'user',
        content: 'Create a task for my report',
        cards,
      });

      expect(messages()).toHaveLength(1);
      expect(messages()[0]).toMatchObject({
        conversation_id: OWNED_ID,
        user_id: USER_A,
        role: 'user',
        content: 'Create a task for my report',
      });
      // Cards are persisted as JSON (jsonb) exactly as supplied.
      expect(messages()[0].cards).toEqual(cards);
      expect(message).toMatchObject({ conversation_id: OWNED_ID, user_id: USER_A, role: 'user' });
    });

    it('stores null cards when none are supplied', async () => {
      await appendMessage(USER_A, OWNED_ID, { role: 'assistant', content: 'Hi there' });

      expect(messages()[0].cards).toBeNull();
    });

    it('bumps the parent conversation last_message_at (scoped to the owner)', async () => {
      fake.__store.assistant_conversations = [
        { id: OWNED_ID, user_id: USER_A, last_message_at: null },
      ];

      await appendMessage(USER_A, OWNED_ID, { role: 'user', content: 'Hi' });

      expect(conversations()[0].last_message_at).toBeTruthy();
      expect(lastFilterCalls()).toContainEqual(['user_id', USER_A]);
    });
  });

  describe('listMessages', () => {
    it('returns only the caller\'s messages in chronological order', async () => {
      fake.__store.assistant_messages = [
        {
          id: 'm-2',
          conversation_id: OWNED_ID,
          user_id: USER_A,
          role: 'assistant',
          content: 'second',
          created_at: '2026-10-02T10:00:02.000Z',
        },
        {
          id: 'm-1',
          conversation_id: OWNED_ID,
          user_id: USER_A,
          role: 'user',
          content: 'first',
          created_at: '2026-10-02T10:00:01.000Z',
        },
        {
          id: 'foreign',
          conversation_id: OWNED_ID,
          user_id: USER_B,
          role: 'user',
          content: 'not mine',
          created_at: '2026-10-02T10:00:00.000Z',
        },
      ];

      const result = await listMessages(USER_A, OWNED_ID);

      expect(result.map((row) => row.id)).toEqual(['m-1', 'm-2']);
      expect(lastFilterCalls()).toContainEqual(['conversation_id', OWNED_ID]);
      expect(lastFilterCalls()).toContainEqual(['user_id', USER_A]);
    });

    it('returns nothing when the conversation belongs to another user', async () => {
      fake.__store.assistant_messages = [
        { id: 'm-1', conversation_id: OWNED_ID, user_id: USER_B, role: 'user', content: 'x' },
      ];

      const result = await listMessages(USER_A, OWNED_ID);

      expect(result).toEqual([]);
    });
  });

  describe('listConversations', () => {
    it('returns only the caller\'s conversations', async () => {
      fake.__store.assistant_conversations = [
        { id: OWNED_ID, user_id: USER_A, last_message_at: '2026-10-02T10:00:00.000Z' },
        { id: FOREIGN_ID, user_id: USER_B, last_message_at: '2026-10-02T11:00:00.000Z' },
      ];

      const result = await listConversations(USER_A);

      expect(result.map((row) => row.id)).toEqual([OWNED_ID]);
      expect(lastFilterCalls()).toContainEqual(['user_id', USER_A]);
    });
  });

  describe('getConversation', () => {
    it('returns null for a conversation owned by another user', async () => {
      fake.__store.assistant_conversations = [{ id: FOREIGN_ID, user_id: USER_B }];

      const result = await getConversation(USER_A, FOREIGN_ID);

      expect(result).toBeNull();
    });

    it('returns null for a malformed id without querying', async () => {
      const result = await getConversation(USER_A, 'nope');

      expect(result).toBeNull();
      expect(fake.__queries).toHaveLength(0);
    });
  });

  it('isUuid accepts server-shaped ids and rejects client-ish ids', () => {
    expect(isUuid(OWNED_ID)).toBe(true);
    expect(isUuid('conv-lx3k2')).toBe(false);
  });
});
