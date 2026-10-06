import { config } from '../../config';

/**
 * The single place in the server that talks HTTP to Notion's OAuth endpoints.
 *
 * - `buildAuthorizationUrl` is a pure URL builder (the result is public and safe
 *   to hand to the browser).
 * - `exchangeCodeForToken` performs the confidential, server-side code exchange
 *   using HTTP Basic auth. The client secret and the returned access token are
 *   never logged and never appear in thrown error messages.
 *
 * Built on the native `fetch` available in Node 18+ (no axios/node-fetch).
 */

const NOTION_AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize';
const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';

/** Pinned public Notion API version, sent on the token exchange. */
export const NOTION_VERSION = '2022-06-28';

export type NotionOAuthErrorCode =
  | 'not_configured'
  | 'token_exchange_failed'
  | 'network_error'
  | 'invalid_response';

/** Typed, user-safe error. Messages never include the token, secret, or raw body. */
export class NotionOAuthError extends Error {
  readonly code: NotionOAuthErrorCode;

  constructor(message: string, code: NotionOAuthErrorCode) {
    super(message);
    this.name = 'NotionOAuthError';
    this.code = code;
  }
}

/** The subset of Notion's OAuth owner object we persist for auditing. */
export interface NotionOwner {
  type?: string;
  user?: { id?: string; name?: string | null; avatar_url?: string | null } | null;
  workspace?: boolean;
}

/** Typed result of a successful `POST /v1/oauth/token`. */
export interface NotionTokenResponse {
  access_token: string;
  bot_id: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_icon: string | null;
  owner: NotionOwner | null;
}

function requireNotionConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!config.isNotionConfigured) {
    throw new NotionOAuthError('Notion is not configured on this server.', 'not_configured');
  }
  return {
    clientId: config.notionClientId,
    clientSecret: config.notionClientSecret,
    redirectUri: config.notionRedirectUri,
  };
}

/**
 * Builds the public Notion authorization URL the browser is redirected to.
 *
 * @throws {NotionOAuthError} `not_configured` when Notion env vars are missing.
 */
export function buildAuthorizationUrl(state: string): string {
  const { clientId, redirectUri } = requireNotionConfig();

  const url = new URL(NOTION_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('owner', 'user');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);

  return url.toString();
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Exchanges an authorization `code` for a Notion access token (server-side).
 *
 * @throws {NotionOAuthError} `not_configured` | `network_error` |
 * `token_exchange_failed` | `invalid_response`. The message is always user-safe.
 */
export async function exchangeCodeForToken(code: string): Promise<NotionTokenResponse> {
  const { clientId, clientSecret, redirectUri } = requireNotionConfig();

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');

  let response: Response;
  try {
    response = await fetch(NOTION_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch {
    // Never surface the underlying error or the request headers.
    throw new NotionOAuthError('Could not reach Notion to complete the connection.', 'network_error');
  }

  if (!response.ok) {
    throw new NotionOAuthError('Notion rejected the authorization request.', 'token_exchange_failed');
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new NotionOAuthError('Notion returned an unreadable response.', 'invalid_response');
  }

  const accessToken = asStringOrNull(payload.access_token);
  if (!accessToken) {
    throw new NotionOAuthError('Notion did not return an access token.', 'invalid_response');
  }

  return {
    access_token: accessToken,
    bot_id: asStringOrNull(payload.bot_id),
    workspace_id: asStringOrNull(payload.workspace_id),
    workspace_name: asStringOrNull(payload.workspace_name),
    workspace_icon: asStringOrNull(payload.workspace_icon),
    owner: (payload.owner as NotionOwner | undefined) ?? null,
  };
}
