import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../../client/src/App';
import { supabase } from '../../client/src/services/supabase';
import { fetchMe } from '../../client/src/services/api';

jest.mock('../../client/src/services/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(),
      signUp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
      resetPasswordForEmail: jest.fn(),
      updateUser: jest.fn(),
    },
  },
}));

jest.mock('../../client/src/services/api', () => ({
  apiRequest: jest.fn(),
  fetchMe: jest.fn(),
  patchProfile: jest.fn(),
}));

// The dashboard now fetches its summary/grouped buckets on mount; stub them so
// this shell test stays offline and deterministic.
jest.mock('../../client/src/services/tasks', () => ({
  getTaskSummary: jest.fn().mockResolvedValue({
    counts: { today: 0, upcoming: 0, overdue: 0, inProgress: 0, awaitingUpdate: 0, completed: 0 },
    generatedAt: '2026-01-01T00:00:00.000Z',
    timezone: 'UTC',
  }),
  getGroupedTasks: jest.fn().mockResolvedValue({
    buckets: {
      today: [],
      upcoming: [],
      overdue: [],
      inProgress: [],
      awaitingUpdate: [],
      completed: [],
    },
    generatedAt: '2026-01-01T00:00:00.000Z',
    timezone: 'UTC',
  }),
  listTasks: jest.fn().mockResolvedValue([]),
  getTask: jest.fn(),
}));

const auth = supabase.auth as unknown as {
  getSession: jest.Mock;
  onAuthStateChange: jest.Mock;
};

const mockFetchMe = fetchMe as jest.Mock;

const mockSessionUser = { id: 'user-1', email: 'ada@example.com' };

const mockProfile = {
  id: 'user-1',
  email: 'ada@example.com',
  full_name: null,
  timezone: 'UTC',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('App', () => {
  it('renders the authenticated dashboard shell without crashing', async () => {
    auth.getSession.mockResolvedValue({
      data: { session: { user: mockSessionUser } },
      error: null,
    });
    auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: jest.fn() } },
    });
    mockFetchMe.mockResolvedValue({
      user: { id: 'user-1', email: 'ada@example.com' },
      profile: mockProfile,
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Dashboard' })
    ).toBeInTheDocument();
    expect(await screen.findByText("Today's Tasks")).toBeInTheDocument();
    expect(screen.getAllByText('AI Virtual Task Assistant').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ada@example\.com/).length).toBeGreaterThan(0);
  });
});
