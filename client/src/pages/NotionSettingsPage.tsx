import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Database as DatabaseIcon,
  Link2,
  Link2Off,
  Loader,
  RefreshCw,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Button } from '../components/Button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '../components/Card';
import {
  deleteDatabaseMapping,
  disconnectNotion,
  fetchNotionConnection,
  listDatabases,
  setDatabaseMapping,
  startNotionOAuth,
} from '../services/notion';
import type {
  NotionConnectionSummary,
  NotionDatabase,
  NotionDatabasePurpose,
} from '../services/notion';
import { fetchSyncStatus, runSync } from '../services/sync';
import type { SyncStatus, SyncSummary } from '../services/sync';
import { redirectTo } from '../utils/navigation';

/** Fixed, user-safe copy for each `?notion=error&reason=` code from the callback. */
const REASON_MESSAGES: Record<string, string> = {
  access_denied: 'You declined the Notion connection request.',
  state_expired: 'The connection request expired. Please start again.',
  state_replayed: 'That connection link was already used. Please start again.',
  state_invalid: 'The connection request could not be verified. Please start again.',
  state_malformed: 'The connection request was invalid. Please start again.',
  missing_code: 'Notion did not return an authorization code. Please start again.',
  exchange_failed: 'Notion could not complete the connection. Please try again.',
  network_error: 'Could not reach Notion. Please try again.',
  not_configured: 'Notion is not configured on this server.',
  unknown: 'Could not connect Notion. Please try again.',
};

/** Purpose choices shown in each database row's selector. */
const PURPOSE_OPTIONS: Array<{ value: NotionDatabasePurpose; label: string }> = [
  { value: 'work', label: 'Work' },
  { value: 'personal', label: 'Personal' },
  { value: 'school', label: 'School' },
  { value: 'projects', label: 'Projects' },
  { value: 'other', label: 'Other' },
];

const DISCONNECTED: NotionConnectionSummary = {
  connected: false,
  workspaceName: null,
  workspaceIcon: null,
  workspaceId: null,
  connectedAt: null,
};

interface Notice {
  type: 'success' | 'error';
  message: string;
}

/** Renders a database icon (emoji, image URL) or a neutral fallback. */
function DatabaseIconBadge({ icon }: { icon: string | null }) {
  if (icon && /^https?:\/\//i.test(icon)) {
    return (
      <img
        src={icon}
        alt=""
        className="h-8 w-8 shrink-0 rounded-md border border-gray-200 object-cover"
      />
    );
  }
  if (icon) {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center text-lg" aria-hidden="true">
        {icon}
      </span>
    );
  }
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">
      <DatabaseIcon className="h-4 w-4" aria-hidden="true" />
    </span>
  );
}

export function NotionSettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState<NotionConnectionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const handledReturn = useRef(false);

  // Phase 8 — database discovery + purpose configuration.
  const [databases, setDatabases] = useState<NotionDatabase[] | null>(null);
  const [databasesLoading, setDatabasesLoading] = useState(false);
  const [databasesError, setDatabasesError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Phase 16 — synchronization.
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const notionFlag = searchParams.get('notion');
  const reason = searchParams.get('reason');

  // Show the success/error notice from the OAuth return, then clean the URL.
  useEffect(() => {
    if (handledReturn.current) return;

    if (notionFlag === 'connected') {
      handledReturn.current = true;
      setNotice({ type: 'success', message: 'Notion connected successfully.' });
      setSearchParams({}, { replace: true });
    } else if (notionFlag === 'error') {
      handledReturn.current = true;
      setNotice({
        type: 'error',
        message: REASON_MESSAGES[reason ?? ''] ?? REASON_MESSAGES.unknown,
      });
      setSearchParams({}, { replace: true });
    }
  }, [notionFlag, reason, setSearchParams]);

  // Load the current connection status once on mount.
  useEffect(() => {
    let cancelled = false;

    fetchNotionConnection()
      .then((summary) => {
        if (!cancelled) {
          setStatus(summary);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Could not check your Notion connection. Please refresh and try again.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Load the available databases whenever the connection is (re)established or a
  // manual refresh is requested. The whole loader lives in the effect so React's
  // exhaustive-deps rule is satisfied without extra memoisation.
  useEffect(() => {
    if (!status?.connected) {
      setDatabases(null);
      setDatabasesError(null);
      setDatabasesLoading(false);
      return;
    }

    let cancelled = false;
    setDatabasesLoading(true);
    setDatabasesError(null);

    listDatabases()
      .then((result) => {
        if (!cancelled) setDatabases(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : '';
        setDatabases([]);
        setDatabasesError(
          /reconnect/i.test(message)
            ? 'Reconnect Notion to view your databases.'
            : 'Could not load your Notion databases. Please try again.'
        );
      })
      .finally(() => {
        if (!cancelled) setDatabasesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [status?.connected, reloadToken]);

  // Load the sync status once the connection is established (best-effort).
  useEffect(() => {
    if (!status?.connected) {
      setSyncStatus(null);
      return;
    }

    let cancelled = false;
    fetchSyncStatus()
      .then((result) => {
        if (!cancelled) setSyncStatus(result);
      })
      .catch(() => {
        // Best-effort only; the "Sync now" control still works.
      });

    return () => {
      cancelled = true;
    };
  }, [status?.connected]);

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      const { authorizationUrl } = await startNotionOAuth();
      // Hand the browser to Notion's public authorization page.
      redirectTo(authorizationUrl);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start the Notion connection.'
      );
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError(null);
    try {
      await disconnectNotion();
      setStatus(DISCONNECTED);
      setNotice({ type: 'success', message: 'Notion disconnected.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect Notion.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePurposeChange(database: NotionDatabase, value: string) {
    setError(null);
    setSavingId(database.id);
    try {
      if (value === '') {
        await deleteDatabaseMapping(database.id);
        setDatabases((previous) =>
          previous
            ? previous.map((item) =>
                item.id === database.id ? { ...item, purpose: null, isDefault: false } : item
              )
            : previous
        );
      } else {
        const mapping = await setDatabaseMapping(database.id, {
          purpose: value as NotionDatabasePurpose,
          isDefault: database.isDefault,
        });
        setDatabases((previous) =>
          previous
            ? previous.map((item) =>
                item.id === database.id
                  ? { ...item, purpose: mapping.purpose, isDefault: mapping.isDefault }
                  : item
              )
            : previous
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that change.');
    } finally {
      setSavingId(null);
    }
  }

  async function handleDefaultToggle(database: NotionDatabase, next: boolean) {
    if (!database.purpose) return;
    setError(null);
    setSavingId(database.id);
    try {
      const mapping = await setDatabaseMapping(database.id, {
        purpose: database.purpose,
        isDefault: next,
      });
      setDatabases((previous) =>
        previous
          ? previous.map((item) => {
              if (item.id === database.id) {
                return { ...item, isDefault: mapping.isDefault };
              }
              // Setting a new default clears the others (the server enforces the
              // same invariant); clearing a default leaves the others untouched.
              return next ? { ...item, isDefault: false } : item;
            })
          : previous
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that change.');
    } finally {
      setSavingId(null);
    }
  }

  async function handleSyncNow() {
    setSyncing(true);
    setSyncError(null);
    try {
      const summary = await runSync('both');
      setSyncResult(summary);
      const refreshed = await fetchSyncStatus().catch(() => null);
      if (refreshed) setSyncStatus(refreshed);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Could not sync with Notion.');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section>
      <PageHeader
        title="Notion"
        description="Connect Notion so your assistant can work with your pages, databases, and tasks."
      />

      {notice ? (
        <div
          role="status"
          className={
            notice.type === 'success'
              ? 'mb-4 flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800'
              : 'mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800'
          }
        >
          {notice.type === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span>{notice.message}</span>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <Card className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-gray-500">
          <Loader className="h-5 w-5 animate-spin" aria-hidden="true" />
          <span>Checking your Notion connection…</span>
        </Card>
      ) : status?.connected ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Connected workspace</CardTitle>
              <CardDescription>Your assistant can now use this Notion workspace.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                {status.workspaceIcon ? (
                  <img
                    src={status.workspaceIcon}
                    alt=""
                    className="h-10 w-10 rounded-md border border-gray-200 object-cover"
                  />
                ) : (
                  <span className="flex h-10 w-10 items-center justify-center rounded-md bg-brand-50 text-brand-600">
                    <Link2 className="h-5 w-5" aria-hidden="true" />
                  </span>
                )}
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {status.workspaceName ?? 'Notion workspace'}
                  </p>
                  {status.connectedAt ? (
                    <p className="text-xs text-gray-500">
                      Connected {new Date(status.connectedAt).toLocaleString()}
                    </p>
                  ) : null}
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button variant="secondary" onClick={handleDisconnect} disabled={busy}>
                <Link2Off className="h-4 w-4" aria-hidden="true" />
                Disconnect
              </Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>Your Notion databases</CardTitle>
                <CardDescription>
                  Choose what each database is for. Your assistant uses these to file tasks.
                </CardDescription>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setReloadToken((token) => token + 1)}
                disabled={databasesLoading}
              >
                {databasesLoading ? (
                  <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                )}
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {databasesError ? (
                <p role="alert" className="text-sm text-red-700">
                  {databasesError}
                </p>
              ) : databasesLoading && databases === null ? (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>Loading databases…</span>
                </div>
              ) : !databases || databases.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No databases shared with the integration yet
                </p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {databases.map((database) => (
                    <li
                      key={database.id}
                      className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <DatabaseIconBadge icon={database.icon} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-gray-900">
                            {database.title}
                          </p>
                          {database.url ? (
                            <a
                              href={database.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-brand-600 hover:underline"
                            >
                              Open in Notion
                            </a>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <select
                          aria-label={`Purpose for ${database.title}`}
                          value={database.purpose ?? ''}
                          disabled={savingId !== null}
                          onChange={(event) => handlePurposeChange(database, event.target.value)}
                          className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60"
                        >
                          <option value="">No purpose</option>
                          {PURPOSE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <label className="flex items-center gap-2 text-sm text-gray-600">
                          <input
                            type="checkbox"
                            checked={database.isDefault}
                            disabled={!database.purpose || savingId !== null}
                            onChange={(event) => handleDefaultToggle(database, event.target.checked)}
                            className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 disabled:opacity-60"
                          />
                          Default
                        </label>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>Synchronization</CardTitle>
                <CardDescription>
                  Keep your tasks and Notion pages in step. The most recent change always wins.
                </CardDescription>
              </div>
              <Button variant="secondary" size="sm" onClick={handleSyncNow} disabled={syncing}>
                {syncing ? (
                  <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                )}
                {syncing ? 'Syncing…' : 'Sync now'}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {syncError ? (
                <p role="alert" className="text-sm text-red-700">
                  {syncError}
                </p>
              ) : null}

              <p className="text-sm text-gray-500">
                {syncStatus?.lastSyncedAt
                  ? `Last synced ${new Date(syncStatus.lastSyncedAt).toLocaleString()}`
                  : 'Not synced yet.'}
                {syncStatus && syncStatus.counts.error > 0
                  ? ` · ${syncStatus.counts.error} task${
                      syncStatus.counts.error === 1 ? '' : 's'
                    } need attention`
                  : ''}
              </p>

              {syncResult ? (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
                  <p className="font-medium text-gray-900">Sync complete</p>
                  <ul className="mt-1 space-y-0.5">
                    <li>
                      Pulled — created {syncResult.pulled.created}, updated{' '}
                      {syncResult.pulled.updated}, skipped {syncResult.pulled.skipped}
                    </li>
                    <li>
                      Pushed — updated {syncResult.pushed.updated}, failed{' '}
                      {syncResult.pushed.failed}
                    </li>
                  </ul>
                  {syncResult.errors.length > 0 ? (
                    <ul role="alert" className="mt-2 list-disc space-y-0.5 pl-5 text-red-700">
                      {syncResult.errors.map((entry, index) => (
                        <li key={`${entry.scope}-${index}`}>{entry.message}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : (
        <EmptyState
          icon={Link2}
          title="Notion is not connected"
          description="Connect your Notion workspace to let your assistant read and write pages, databases, and tasks. Nothing is shared until you approve it in Notion."
          action={
            <Button onClick={handleConnect} disabled={busy}>
              {busy ? (
                <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Link2 className="h-4 w-4" aria-hidden="true" />
              )}
              Connect Notion
            </Button>
          }
        />
      )}
    </section>
  );
}
