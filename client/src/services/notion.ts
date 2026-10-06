import { apiRequest } from './api';

/**
 * Typed wrapper around the Notion endpoints. All calls go through `apiRequest`,
 * which attaches the Supabase Bearer token. No Notion secret or access token
 * ever reaches this layer — the server only exposes status metadata, the public
 * authorization URL, and normalised database summaries.
 */

/** Browser-safe connection status. Mirrors `NotionConnectionSummary` on the server. */
export interface NotionConnectionSummary {
  connected: boolean;
  workspaceName: string | null;
  workspaceIcon: string | null;
  workspaceId: string | null;
  connectedAt: string | null;
}

export interface NotionAuthorizationResponse {
  authorizationUrl: string;
}

/** Allowed purposes for a Notion database. Mirrors the server enum. */
export const NOTION_DATABASE_PURPOSES = [
  'work',
  'personal',
  'school',
  'projects',
  'other',
] as const;

export type NotionDatabasePurpose = (typeof NOTION_DATABASE_PURPOSES)[number];

/** A Notion database available to the integration, merged with its saved mapping. */
export interface NotionDatabase {
  id: string;
  title: string;
  url: string | null;
  /** Emoji or image URL, or `null`. */
  icon: string | null;
  purpose: NotionDatabasePurpose | null;
  isDefault: boolean;
}

/** The saved mapping returned by the API. */
export interface NotionDatabaseMapping {
  notionDatabaseId: string;
  databaseTitle: string | null;
  purpose: NotionDatabasePurpose | null;
  isDefault: boolean;
}

export interface SetDatabaseMappingPayload {
  purpose: NotionDatabasePurpose;
  isDefault?: boolean;
}

/** `GET /api/notion/connection` — current connection status (no token). */
export function fetchNotionConnection(): Promise<NotionConnectionSummary> {
  return apiRequest<NotionConnectionSummary>('/api/notion/connection');
}

/** `GET /api/notion/oauth/start` — mints state and returns the public auth URL. */
export function startNotionOAuth(): Promise<NotionAuthorizationResponse> {
  return apiRequest<NotionAuthorizationResponse>('/api/notion/oauth/start');
}

/** `DELETE /api/notion/connection` — disconnect the workspace. */
export function disconnectNotion(): Promise<{ connected: boolean }> {
  return apiRequest<{ connected: boolean }>('/api/notion/connection', { method: 'DELETE' });
}

/** `GET /api/notion/databases` — databases shared with the integration. */
export function listDatabases(): Promise<NotionDatabase[]> {
  return apiRequest<{ databases: NotionDatabase[] }>('/api/notion/databases').then(
    (response) => response.databases
  );
}

/** `PUT /api/notion/databases/:id/mapping` — set the purpose (and optionally default). */
export function setDatabaseMapping(
  databaseId: string,
  payload: SetDatabaseMappingPayload
): Promise<NotionDatabaseMapping> {
  return apiRequest<{ mapping: NotionDatabaseMapping }>(
    `/api/notion/databases/${encodeURIComponent(databaseId)}/mapping`,
    { method: 'PUT', body: JSON.stringify(payload) }
  ).then((response) => response.mapping);
}

/** `DELETE /api/notion/databases/:id/mapping` — remove the mapping. */
export function deleteDatabaseMapping(databaseId: string): Promise<{ removed: boolean }> {
  return apiRequest<{ removed: boolean }>(
    `/api/notion/databases/${encodeURIComponent(databaseId)}/mapping`,
    { method: 'DELETE' }
  );
}
