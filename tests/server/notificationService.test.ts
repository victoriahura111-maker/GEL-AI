import {
  dispatchNotification,
  getChannel,
  listChannelNames,
  registerChannel,
} from '../../server/src/services/notifications/registry';
import type { AppNotification, NotificationChannel } from '../../server/src/services/notifications/types';

/**
 * Phase 14 — the formal channel registry + fan-out dispatcher. The registry is
 * populated with controlled fakes (the built-in channels live in the `index`
 * barrel, which this test deliberately does not import).
 */

const NOTIFICATION: AppNotification = {
  userId: 'user-1',
  type: 'reminder',
  title: 'Reminder: Write report',
  body: 'Your task "Write report" is due today.',
  taskId: 'task-1',
  notionUrl: 'https://www.notion.so/page-1',
};

const sendInApp = jest.fn();
const sendEmail = jest.fn();
const sendPush = jest.fn();

const inApp: NotificationChannel = { name: 'in_app', isEnabled: () => true, send: sendInApp };
const email: NotificationChannel = { name: 'email', isEnabled: () => false, send: sendEmail };
const push: NotificationChannel = { name: 'push', isEnabled: () => true, send: sendPush };

beforeAll(() => {
  registerChannel(inApp);
  registerChannel(email);
  registerChannel(push);
});

beforeEach(() => {
  jest.clearAllMocks();
  sendInApp.mockResolvedValue(undefined);
  sendPush.mockResolvedValue(undefined);
});

describe('registry', () => {
  it('looks channels up case-insensitively and returns undefined for unknown names', () => {
    expect(getChannel('IN_APP')).toBe(inApp);
    expect(getChannel('carrier_pigeon')).toBeUndefined();
    expect(listChannelNames()).toEqual(expect.arrayContaining(['in_app', 'email', 'push']));
  });
});

describe('dispatchNotification', () => {
  it('sends via enabled channels by default and skips disabled ones', async () => {
    const result = await dispatchNotification(NOTIFICATION);

    expect(sendInApp).toHaveBeenCalledWith(NOTIFICATION);
    expect(sendPush).toHaveBeenCalledWith(NOTIFICATION);
    expect(sendEmail).not.toHaveBeenCalled();

    expect(result).toMatchObject({ delivered: 2, failed: 0, skipped: 1, unknown: 0 });
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'in_app', status: 'sent' }),
        expect.objectContaining({ channel: 'push', status: 'sent' }),
        expect.objectContaining({ channel: 'email', status: 'skipped' }),
      ])
    );
  });

  it('reports a requested disabled channel as skipped without sending', async () => {
    const result = await dispatchNotification(NOTIFICATION, { channels: ['email'] });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: 0, skipped: 1 });
    expect(result.results[0]).toEqual({ channel: 'email', status: 'skipped' });
  });

  it('isolates a failing channel so the others still deliver', async () => {
    sendPush.mockRejectedValue(new Error('push provider down'));

    const result = await dispatchNotification(NOTIFICATION, { channels: ['in_app', 'push'] });

    expect(sendInApp).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ delivered: 1, failed: 1 });
    expect(result.results).toEqual([
      { channel: 'in_app', status: 'sent' },
      { channel: 'push', status: 'failed', error: 'push provider down' },
    ]);
  });

  it('reports a requested, unregistered channel as unknown', async () => {
    const result = await dispatchNotification(NOTIFICATION, { channels: ['telegram'] });

    expect(result).toMatchObject({ unknown: 1, delivered: 0, failed: 0 });
    expect(result.results[0]).toMatchObject({ channel: 'telegram', status: 'unknown' });
  });
});
