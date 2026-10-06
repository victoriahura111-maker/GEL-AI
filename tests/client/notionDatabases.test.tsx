import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotionSettingsPage } from '../../client/src/pages/NotionSettingsPage';
import {
  deleteDatabaseMapping,
  fetchNotionConnection,
  listDatabases,
  setDatabaseMapping,
} from '../../client/src/services/notion';
import type {
  NotionConnectionSummary,
  NotionDatabase,
} from '../../client/src/services/notion';

jest.mock('../../client/src/services/notion', () => ({
  fetchNotionConnection: jest.fn(),
  startNotionOAuth: jest.fn(),
  disconnectNotion: jest.fn(),
  listDatabases: jest.fn(),
  setDatabaseMapping: jest.fn(),
  deleteDatabaseMapping: jest.fn(),
}));

const mockFetchConnection = fetchNotionConnection as jest.Mock;
const mockListDatabases = listDatabases as jest.Mock;
const mockSetMapping = setDatabaseMapping as jest.Mock;
const mockDeleteMapping = deleteDatabaseMapping as jest.Mock;

const CONNECTED: NotionConnectionSummary = {
  connected: true,
  workspaceName: 'Ada Workspace',
  workspaceIcon: null,
  workspaceId: 'ws-1',
  connectedAt: '2026-01-01T00:00:00.000Z',
};

const DB_ID = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6';

function database(overrides: Partial<NotionDatabase> = {}): NotionDatabase {
  return {
    id: DB_ID,
    title: 'Work Tasks',
    url: null,
    icon: null,
    purpose: null,
    isDefault: false,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/notion']}>
      <NotionSettingsPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Notion database discovery UI', () => {
  it('renders the discovered databases with a purpose selector', async () => {
    mockFetchConnection.mockResolvedValue(CONNECTED);
    mockListDatabases.mockResolvedValue([
      database({ title: 'Work Tasks' }),
      database({ id: 'b1c2d3e4-f5a6-b7c8-d9e0-f1a2b3c4d5e6', title: 'Study Notes' }),
    ]);

    renderPage();

    expect(await screen.findByText('Your Notion databases')).toBeInTheDocument();
    expect(await screen.findByText('Work Tasks')).toBeInTheDocument();
    expect(screen.getByText('Study Notes')).toBeInTheDocument();
    expect(screen.getByLabelText('Purpose for Work Tasks')).toBeInTheDocument();
  });

  it('saves a purpose when the selector changes', async () => {
    mockFetchConnection.mockResolvedValue(CONNECTED);
    mockListDatabases.mockResolvedValue([database()]);
    mockSetMapping.mockResolvedValue({
      notionDatabaseId: DB_ID,
      databaseTitle: 'Work Tasks',
      purpose: 'work',
      isDefault: false,
    });

    renderPage();

    const select = await screen.findByLabelText('Purpose for Work Tasks');
    fireEvent.change(select, { target: { value: 'work' } });

    await waitFor(() =>
      expect(mockSetMapping).toHaveBeenCalledWith(DB_ID, { purpose: 'work', isDefault: false })
    );
  });

  it('removes the mapping when the purpose is cleared', async () => {
    mockFetchConnection.mockResolvedValue(CONNECTED);
    mockListDatabases.mockResolvedValue([database({ purpose: 'work' })]);
    mockDeleteMapping.mockResolvedValue({ removed: true });

    renderPage();

    const select = await screen.findByLabelText('Purpose for Work Tasks');
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => expect(mockDeleteMapping).toHaveBeenCalledWith(DB_ID));
  });

  it('shows the empty state when no databases are shared', async () => {
    mockFetchConnection.mockResolvedValue(CONNECTED);
    mockListDatabases.mockResolvedValue([]);

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText('No databases shared with the integration yet')
      ).toBeInTheDocument()
    );
  });

  it('shows reconnect guidance when discovery requires a reconnect', async () => {
    mockFetchConnection.mockResolvedValue(CONNECTED);
    mockListDatabases.mockRejectedValue(new Error('Reconnect Notion to continue'));

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText('Reconnect Notion to view your databases.')
      ).toBeInTheDocument()
    );
  });
});
