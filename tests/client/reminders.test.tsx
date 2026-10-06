import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RemindersPage } from '../../client/src/pages/RemindersPage';
import {
  cancelReminder,
  listReminders,
  rescheduleReminder,
} from '../../client/src/services/reminders';
import type { Reminder } from '../../client/src/services/reminders';

jest.mock('../../client/src/services/reminders', () => ({
  listReminders: jest.fn(),
  cancelReminder: jest.fn(),
  rescheduleReminder: jest.fn(),
  createReminder: jest.fn(),
}));

jest.mock('../../client/src/context/AuthContext', () => ({
  useAuth: () => ({ profile: { timezone: 'UTC' } }),
}));

const mockList = listReminders as jest.Mock;
const mockCancel = cancelReminder as jest.Mock;
const mockReschedule = rescheduleReminder as jest.Mock;

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'rem-1',
    task_id: 'task-1',
    user_id: 'user-1',
    scheduled_for: '2999-01-01T10:00:00.000Z',
    timezone: 'UTC',
    channel: 'in_app',
    status: 'pending',
    recurrence: null,
    sent_at: null,
    failure_reason: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    task: {
      id: 'task-1',
      title: 'Future task',
      due_date: '2999-01-02',
      due_time: '17:00',
      status: 'not_started',
      notion_url: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('RemindersPage', () => {
  it('renders reminders grouped into upcoming and past', async () => {
    mockList.mockResolvedValue([
      makeReminder({ id: 'future', task: { ...makeReminder().task!, title: 'Future task' } }),
      makeReminder({
        id: 'past',
        scheduled_for: '2000-01-01T10:00:00.000Z',
        status: 'sent',
        task: { ...makeReminder().task!, title: 'Past task' },
      }),
    ]);

    render(<RemindersPage />);

    expect(await screen.findByText('Future task')).toBeInTheDocument();
    expect(screen.getByText('Past task')).toBeInTheDocument();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Past')).toBeInTheDocument();
  });

  it('shows an empty state when there are no reminders', async () => {
    mockList.mockResolvedValue([]);

    render(<RemindersPage />);

    expect(await screen.findByText('No reminders scheduled')).toBeInTheDocument();
  });

  it('cancels a reminder through the service', async () => {
    const reminder = makeReminder();
    mockList.mockResolvedValue([reminder]);
    mockCancel.mockResolvedValue({ ...reminder, status: 'cancelled' });

    render(<RemindersPage />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Cancel' }))[0]);

    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('rem-1'));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('reschedules a reminder through the service', async () => {
    const reminder = makeReminder();
    mockList.mockResolvedValue([reminder]);
    mockReschedule.mockResolvedValue({
      ...reminder,
      scheduled_for: '2999-02-01T10:00:00.000Z',
    });

    render(<RemindersPage />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Reschedule' }))[0]);

    const input = await screen.findByLabelText('New reminder time');
    fireEvent.change(input, { target: { value: '2999-02-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockReschedule).toHaveBeenCalledWith('rem-1', {
        datetime: '2999-02-01T10:00',
        timezone: 'UTC',
      })
    );
  });
});
