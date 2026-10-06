import { inAppChannel, inAppNotificationService } from '../../server/src/services/notifications/inAppChannel';
import { createNotification } from '../../server/src/services/notifications/repository';
import {
  appendMessage,
  getOrCreateConversation,
  listConversations,
} from '../../server/src/services/conversations';

/**
 * Phase 14 — `in_app` delivery. The repository and conversation layer are
 * mocked; the channel must persist an unread row *and* append the proactive
 * assistant message, isolating failures between the two effects.
 */

jest.mock('../../server/src/services/notifications/repository', () => ({
  createNotification: jest.fn(),
}));

jest.mock('../../server/src/services/conversations', () => ({
  appendMessage: jest.fn(),
  getOrCreateConversation: jest.fn(),
  listConversations: jest.fn(),
}));

const mockCreate = createNotification as jest.Mock;
const mockAppend = appendMessage as jest.Mock;
const mockListConversations = listConversations as jest.Mock;
const mockGetOrCreate = getOrCreateConversation as jest.Mock;

const NOTIFICATION = {
  userId: 'user-1',
  type: 'reminder',
  title: 'Reminder: Write report',
  body: 'Your task "Write report" is due today.',
  taskId: 'task-1',
  notionUrl: 'https://www.notion.so/page-1',
  metadata: { reminderId: 'rem-1' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ id: 'notif-1', status: 'unread' });
  mockListConversations.mockResolvedValue([{ id: 'conv-1', user_id: 'user-1' }]);
  mockGetOrCreate.mockResolvedValue({ id: 'conv-new', user_id: 'user-1' });
  mockAppend.mockResolvedValue({ id: 'msg-1' });
});

describe('inAppChannel', () => {
  it('is the enabled in_app channel', () => {
    expect(inAppChannel.name).toBe('in_app');
    expect(inAppChannel.isEnabled()).toBe(true);
  });

  it('persists an unread row and appends the assistant message', async () => {
    await inAppChannel.send(NOTIFICATION);

    expect(mockCreate).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: 'reminder',
        title: 'Reminder: Write report',
        body: NOTIFICATION.body,
        channel: 'in_app',
        taskId: 'task-1',
        notionUrl: 'https://www.notion.so/page-1',
      })
    );
    expect(mockAppend).toHaveBeenCalledWith(
      'user-1',
      'conv-1',
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('Reminder: Write report'),
        cards: null,
      })
    );
  });

  it('creates a conversation when the user has none', async () => {
    mockListConversations.mockResolvedValue([]);

    await inAppChannel.send(NOTIFICATION);

    expect(mockGetOrCreate).toHaveBeenCalledWith('user-1');
    expect(mockAppend).toHaveBeenCalledWith('user-1', 'conv-new', expect.anything());
  });

  it('still appends the message when persisting the row fails (failure isolation)', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));

    await expect(inAppChannel.send(NOTIFICATION)).resolves.toBeUndefined();
    expect(mockAppend).toHaveBeenCalledTimes(1);
  });

  it('still persists the row when appending the message fails (failure isolation)', async () => {
    mockAppend.mockRejectedValue(new Error('conversation down'));

    await expect(inAppChannel.send(NOTIFICATION)).resolves.toBeUndefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects only when both effects fail', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));
    mockAppend.mockRejectedValue(new Error('conversation down'));

    await expect(inAppChannel.send(NOTIFICATION)).rejects.toThrow(/in_app delivery failed/i);
  });

  it('delegates through the Phase 13 compatibility adapter', async () => {
    await inAppNotificationService.send(NOTIFICATION);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockAppend).toHaveBeenCalledTimes(1);
  });
});
