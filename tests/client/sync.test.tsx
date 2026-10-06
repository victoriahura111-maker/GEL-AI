import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotionSettingsPage } from '../../client/src/pages/NotionSettingsPage';
import { fetchNotionConnection, listDatabases } from '../../client/src/services/notion';
import { fetchSyncStatus, runSync } from '../../client/src/services/sync';
import type { NotionConnectionSummary } from '../../client/src/services/notion';
import type { SyncStatus } from '../../client/src/services/sync';

/**
 * Phase 16 — the "Sync now" control on the Notion settings page. The Notion and
 * sync services are mocked; no network is touched.
 */

jest.mock('../../client/src/services/notion', () => ({
  fetchNotionConnection: jest.fn(),
  startNotionOAuth: jest.fn(),
  disconnectNotion: jest.fn(),
  listDatabases: jest.fn(),
  setDatabaseMapping: jest.fn(),
  deleteDatabaseMapping: jest.fn(),
}));

jest.mock('../../client/src/services/sync', () => ({
  runSync: jest.fn(),
  fetchSyncStatus: jest.fn(),
}));

const CONNECTED: NotionConnectionSummary = {
  connected: true,
  workspaceName: 'Ada Workspace',
  workspaceIcon: null,
  workspaceId: 'ws-1',
  connectedAt: '2026-01-01T00:00:00.000Z',
};

const STATUS: SyncStatus = {
  lastSyncedAt: null,
  lastDirection: null,
  lastError: null,
  counts: { synced: 0, pending: 0, error: 0 },
  recentErrors: [],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/notion']}>
      <NotionSettingsPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  (fetchNotionConnection as jest.Mock).mockResolvedValue(CONNECTED);
  (listDatabases as jest.Mock).mockResolvedValue([]);
  (fetchSyncStatus as jest.Mock).mockResolvedValue(STATUS);
});

describe('Notion "Sync now" control', () => {
  it('runs a sync and renders the summary counts', async () => {
    (runSync as jest.Mock).mockResolvedValue({
      direction: 'both',
      pulled: { created: 2, updated: 1, skipped: 3 },
      pushed: { updated: 1, failed: 0 },
      errors: [],
      startedAt: '2026-06-01T00:00:00.000Z',
      finishedAt: '2026-06-01T00:00:01.000Z',
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /sync now/i }));

    expect(await screen.findByText('Sync complete')).toBeInTheDocument();
    expect(runSync).toHaveBeenCalledWith('both');
    expect(screen.getByText(/created 2, updated 1, skipped 3/)).toBeInTheDocument();
    expect(screen.getByText(/updated 1, failed 0/)).toBeInTheDocument();
  });

  it('renders any errors returned in the summary', async () => {
    (runSync as jest.Mock).mockResolvedValue({
      direction: 'both',
      pulled: { created: 0, updated: 0, skipped: 0 },
      pushed: { updated: 0, failed: 1 },
      errors: [{ scope: 'task:1', message: 'Could not push a task to Notion.' }],
      startedAt: '2026-06-01T00:00:00.000Z',
      finishedAt: '2026-06-01T00:00:01.000Z',
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /sync now/i }));

    expect(await screen.findByText('Could not push a task to Notion.')).toBeInTheDocument();
  });

  it('shows a safe error when the sync request fails (e.g. cooldown)', async () => {
    (runSync as jest.Mock).mockRejectedValue(
      new Error('A sync ran recently. Please wait a moment before trying again.')
    );

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /sync now/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/sync ran recently/i);
  });
});
