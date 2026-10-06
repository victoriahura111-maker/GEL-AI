import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationBell } from '../../client/src/components/notifications/NotificationBell';
import {
  getUnreadCount,
  listNotifications,
  markAllRead,
  markRead,
} from '../../client/src/services/notifications';
import type { AppNotification } from '../../client/src/services/notifications';

/**
 * Phase 14 — the notification bell. The notifications service is mocked and the
 * router's `useNavigate` is stubbed; no network.
 */

jest.mock('../../client/src/services/notifications', () => ({
  listNotifications: jest.fn(),
  getUnreadCount: jest.fn(),
  markRead: jest.fn(),
  markAllRead: jest.fn(),
}));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

const mockList = listNotifications as jest.Mock;
const mockCount = getUnreadCount as jest.Mock;
const mockMarkRead = markRead as jest.Mock;
const mockMarkAllRead = markAllRead as jest.Mock;

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  const now = new Date().toISOString();
  return {
    id: 'n-1',
    type: 'task_update',
    title: 'Task updated',
    body: 'Priority changed to high',
    channel: 'in_app',
    status: 'unread',
    task_id: 'task-1',
    notion_url: null,
    created_at: now,
    read_at: null,
    updated_at: now,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCount.mockResolvedValue(0);
  mockList.mockResolvedValue({ notifications: [], nextCursor: null });
  mockMarkAllRead.mockResolvedValue(0);
});

describe('NotificationBell', () => {
  it('renders a bell with the unread badge', async () => {
    mockCount.mockResolvedValue(3);

    render(<NotificationBell />);

    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('opens a panel listing recent notifications by type', async () => {
    mockCount.mockResolvedValue(1);
    mockList.mockResolvedValue({ notifications: [notification()], nextCursor: null });

    render(<NotificationBell />);
    fireEvent.click(await screen.findByRole('button', { name: /notifications/i }));

    expect(await screen.findByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
    expect(await screen.findByText('Task updated')).toBeInTheDocument();
    expect(screen.getByText('Task update')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark all read/i })).toBeInTheDocument();
  });

  it('marks all notifications read through the service', async () => {
    mockCount.mockResolvedValue(2);
    mockList.mockResolvedValue({
      notifications: [notification({ id: 'a' }), notification({ id: 'b' })],
      nextCursor: null,
    });
    mockMarkAllRead.mockResolvedValue(2);

    render(<NotificationBell />);
    fireEvent.click(await screen.findByRole('button', { name: /notifications/i }));
    fireEvent.click(await screen.findByRole('button', { name: /mark all read/i }));

    await waitFor(() => expect(mockMarkAllRead).toHaveBeenCalledTimes(1));
  });

  it('marks a task notification read and navigates to /tasks', async () => {
    mockCount.mockResolvedValue(1);
    mockList.mockResolvedValue({
      notifications: [
        notification({ id: 'n-9', type: 'task_update', task_id: 'task-9', title: 'Write report' }),
      ],
      nextCursor: null,
    });
    mockMarkRead.mockResolvedValue(notification({ id: 'n-9', status: 'read' }));

    render(<NotificationBell />);
    fireEvent.click(await screen.findByRole('button', { name: /notifications/i }));
    fireEvent.click(await screen.findByRole('button', { name: /write report/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/tasks'));
    expect(mockMarkRead).toHaveBeenCalledWith('n-9');
  });

  it('navigates a reminder notification to /reminders', async () => {
    mockCount.mockResolvedValue(1);
    mockList.mockResolvedValue({
      notifications: [
        notification({ id: 'r-1', type: 'reminder', task_id: null, title: 'Reminder: Write report' }),
      ],
      nextCursor: null,
    });
    mockMarkRead.mockResolvedValue(notification({ id: 'r-1', type: 'reminder', status: 'read' }));

    render(<NotificationBell />);
    fireEvent.click(await screen.findByRole('button', { name: /notifications/i }));
    fireEvent.click(await screen.findByRole('button', { name: /reminder: write report/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/reminders'));
  });
});
