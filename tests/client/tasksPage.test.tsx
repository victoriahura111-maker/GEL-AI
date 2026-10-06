import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TasksPage } from '../../client/src/pages/TasksPage';
import { listTasks } from '../../client/src/services/tasks';
import type { Task } from '../../client/src/services/tasks';

jest.mock('../../client/src/services/tasks', () => ({
  listTasks: jest.fn(),
  getTaskSummary: jest.fn(),
  getGroupedTasks: jest.fn(),
  getTask: jest.fn(),
}));

jest.mock('../../client/src/context/AuthContext', () => ({
  useAuth: () => ({ profile: { timezone: 'UTC' } }),
}));

const mockListTasks = listTasks as jest.Mock;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    user_id: 'user-1',
    notion_page_id: null,
    notion_database_id: null,
    notion_database_name: null,
    notion_url: null,
    title: 'Write report',
    description: null,
    category: 'Work',
    priority: 'medium',
    status: 'not_started',
    due_date: '2026-10-06',
    due_time: null,
    timezone: 'UTC',
    source_of_change: null,
    sync_status: null,
    last_synced_at: null,
    created_at: '2026-10-01T09:00:00.000Z',
    updated_at: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TasksPage', () => {
  it('refetches with a status filter when the status select changes', async () => {
    mockListTasks.mockResolvedValue([makeTask()]);

    render(<TasksPage />);

    expect(await screen.findByText('Write report')).toBeInTheDocument();
    expect(mockListTasks).toHaveBeenCalledWith({ limit: 100 });

    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: { value: 'completed' },
    });

    await waitFor(() =>
      expect(mockListTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'completed', limit: 100 })
      )
    );
  });

  it('filters the fetched list client-side by title search', async () => {
    mockListTasks.mockResolvedValue([
      makeTask({ id: 'a', title: 'Write report' }),
      makeTask({ id: 'b', title: 'Buy milk' }),
    ]);

    render(<TasksPage />);

    expect(await screen.findByText('Write report')).toBeInTheDocument();
    expect(screen.getByText('Buy milk')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'milk' } });

    expect(screen.getByText('Buy milk')).toBeInTheDocument();
    expect(screen.queryByText('Write report')).not.toBeInTheDocument();
    // Only one request was made — the search is client-side.
    expect(mockListTasks).toHaveBeenCalledTimes(1);
  });

  it('opens the detail panel for a task row', async () => {
    mockListTasks.mockResolvedValue([makeTask()]);

    render(<TasksPage />);

    fireEvent.click(await screen.findByText('Write report'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Write report');
  });
});
