import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotionSettingsPage } from '../../client/src/pages/NotionSettingsPage';
import {
  disconnectNotion,
  fetchNotionConnection,
  listDatabases,
  setDatabaseMapping,
  startNotionOAuth,
  deleteDatabaseMapping,
} from '../../client/src/services/notion';
import type { NotionConnectionSummary } from '../../client/src/services/notion';
import { redirectTo } from '../../client/src/utils/navigation';

jest.mock('../../client/src/services/notion', () => ({
  fetchNotionConnection: jest.fn(),
  startNotionOAuth: jest.fn(),
  disconnectNotion: jest.fn(),
  listDatabases: jest.fn(),
  setDatabaseMapping: jest.fn(),
  deleteDatabaseMapping: jest.fn(),
}));

jest.mock('../../client/src/utils/navigation', () => ({
  redirectTo: jest.fn(),
}));

const mockFetch = fetchNotionConnection as jest.Mock;
const mockStart = startNotionOAuth as jest.Mock;
const mockDisconnect = disconnectNotion as jest.Mock;
const mockListDatabases = listDatabases as jest.Mock;
// Referenced so the mocked module exports remain in sync with the page; the
// connect/disconnect tests do not change a mapping.
void (setDatabaseMapping as jest.Mock);
void (deleteDatabaseMapping as jest.Mock);
const redirectToMock = redirectTo as jest.Mock;

const DISCONNECTED: NotionConnectionSummary = {
  connected: false,
  workspaceName: null,
  workspaceIcon: null,
  workspaceId: null,
  connectedAt: null,
};

const CONNECTED: NotionConnectionSummary = {
  connected: true,
  workspaceName: 'Ada Workspace',
  workspaceIcon: null,
  workspaceId: 'ws-1',
  connectedAt: '2026-01-01T00:00:00.000Z',
};

function renderPage(entry = '/settings/notion') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <NotionSettingsPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  // The connected state now discovers databases; keep it empty by default so the
  // connect/disconnect assertions stay focused.
  mockListDatabases.mockResolvedValue([]);
});

describe('NotionSettingsPage', () => {
  it('renders the not-connected state with a Connect button', async () => {
    mockFetch.mockResolvedValue(DISCONNECTED);

    renderPage();

    expect(await screen.findByText('Notion is not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect notion/i })).toBeInTheDocument();
  });

  it('calls the start endpoint and redirects the browser on connect', async () => {
    mockFetch.mockResolvedValue(DISCONNECTED);
    mockStart.mockResolvedValue({
      authorizationUrl: 'https://api.notion.com/v1/oauth/authorize?client_id=x&state=y',
    });

    // jsdom 26 (shipped with Jest 30) makes `window.location.assign` a
    // non-configurable, non-writable property, so it cannot be stubbed. The page
    // navigates through the `redirectTo` seam instead, which we assert here.
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /connect notion/i }));

    expect(await screen.findByRole('button', { name: /connect notion/i })).toBeInTheDocument();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(redirectToMock).toHaveBeenCalledWith(
      'https://api.notion.com/v1/oauth/authorize?client_id=x&state=y'
    );
  });

  it('shows the connected workspace and a Disconnect button', async () => {
    mockFetch.mockResolvedValue(CONNECTED);

    renderPage();

    expect(await screen.findByText('Ada Workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });

  it('disconnects and returns to the not-connected state', async () => {
    mockFetch.mockResolvedValue(CONNECTED);
    mockDisconnect.mockResolvedValue({ connected: false });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /disconnect/i }));

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Notion is not connected')).toBeInTheDocument();
  });

  it('shows a success notice when returning with ?notion=connected', async () => {
    mockFetch.mockResolvedValue(CONNECTED);

    renderPage('/settings/notion?notion=connected');

    expect(await screen.findByText('Notion connected successfully.')).toBeInTheDocument();
  });

  it('shows a safe error notice when returning with ?notion=error&reason=state_expired', async () => {
    mockFetch.mockResolvedValue(DISCONNECTED);

    renderPage('/settings/notion?notion=error&reason=state_expired');

    expect(
      await screen.findByText('The connection request expired. Please start again.')
    ).toBeInTheDocument();
  });
});
