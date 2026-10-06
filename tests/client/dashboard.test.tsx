import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DashboardPage } from '../../client/src/pages/DashboardPage';
import { getGroupedTasks, getTaskSummary } from '../../client/src/services/tasks';
import type { GroupedTasks, Task, TaskSummary } from '../../client/src/services/tasks';

jest.mock('../../client/src/services/tasks', () => ({
  getTaskSummary: jest.fn(),
  getGroupedTasks: jest.fn(),
  listTasks: jest.fn(),
  getTask: jest.fn(),
}));

jest.mock('../../client/src/context/AuthContext', () => ({
  useAuth: () => ({ profile: { timezone: 'UTC' } }),
}));

const mockSummary = getTaskSummary as jest.Mock;
const mockGrouped = getGroupedTasks as jest.Mock;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    user_id: 'user-1',
    notion_page_id: 'page-1',
    notion_database_id: 'db-1',
    notion_database_name: 'Work Tasks',
    notion_url: null,
    title: 'Write report',
    description: 'Draft the quarterly report.',
    category: 'Work',
    priority: 'high',
    status: 'not_started',
    due_date: '2026-10-06',
    due_time: '17:00',
    timezone: 'UTC',
    source_of_change: 'assistant',
    sync_status: 'synced',
    last_synced_at: null,
    created_at: '2026-10-01T09:00:00.000Z',
    updated_at: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

const SUMMARY: TaskSummary = {
  counts: { today: 3, upcoming: 2, overdue: 1, inProgress: 4, awaitingUpdate: 2, completed: 5 },
  generatedAt: '2026-10-06T10:00:00.000Z',
  timezone: 'UTC',
};

const WITH_URL = makeTask({ id: 'task-1', notion_url: 'https://notion.so/page-1' });
const OVERDUE = makeTask({
  id: 'task-2',
  title: 'Ship release',
  status: 'overdue',
  notion_url: null,
  notion_page_id: null,
  notion_database_name: null,
});

const GROUPED: GroupedTasks = {
  buckets: {
    today: [WITH_URL],
    upcoming: [],
    overdue: [OVERDUE],
    inProgress: [],
    awaitingUpdate: [],
    completed: [],
  },
  generatedAt: '2026-10-06T10:00:00.000Z',
  timezone: 'UTC',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSummary.mockResolvedValue(SUMMARY);
  mockGrouped.mockResolvedValue(GROUPED);
});

describe('DashboardPage', () => {
  it('renders the six summary stat cards with their counts', async () => {
    render(<DashboardPage />);

    expect(await screen.findByText("Today's Tasks")).toBeInTheDocument();
    for (const label of ['Upcoming', 'Overdue', 'In Progress', 'Awaiting Update', 'Completed']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    // The Today tile shows count 3 next to its label.
    expect(screen.getByText("Today's Tasks").parentElement).toHaveTextContent('3');
  });

  it('renders the bucketed task lists', async () => {
    render(<DashboardPage />);

    expect(await screen.findByText('Write report')).toBeInTheDocument();
    expect(screen.getByText('Ship release')).toBeInTheDocument();
  });

  it('opens the detail panel on click and shows "View in Notion" when a URL exists', async () => {
    render(<DashboardPage />);

    fireEvent.click(await screen.findByText('Write report'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Draft the quarterly report.')).toBeInTheDocument();
    expect(within(dialog).getByText('Work Tasks')).toBeInTheDocument();

    const link = within(dialog).getByRole('link', { name: /view in notion/i });
    expect(link).toHaveAttribute('href', 'https://notion.so/page-1');
  });

  it('closes the detail panel on Escape and hides the Notion link when absent', async () => {
    render(<DashboardPage />);

    fireEvent.click(await screen.findByText('Write report'));
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The overdue task has no notion_url, so no link is rendered.
    fireEvent.click(screen.getByText('Ship release'));
    const overdueDialog = await screen.findByRole('dialog');
    expect(within(overdueDialog).queryByRole('link', { name: /view in notion/i })).toBeNull();
  });

  it('shows an error state with a retry action when loading fails', async () => {
    mockSummary.mockRejectedValue(new Error('boom'));
    mockGrouped.mockRejectedValue(new Error('boom'));

    render(<DashboardPage />);

    expect(
      await screen.findByText('Could not load your dashboard. Please try again.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
