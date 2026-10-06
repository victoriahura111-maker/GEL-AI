import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { config } from '../../config';
import { safeEqual } from '../../utils/encryption';

/**
 * Signed, expiring, user-bound OAuth `state` tokens.
 *
 * Threat model: the `state` round-trips through the user's browser and the
 * Notion authorize redirect, so an attacker can read and replay it. To make a
 * forged or replayed callback useless we:
 *
 *   1. Bind the state to the authenticated `userId` that initiated the flow, so
 *      a callback can never be redeemed against a different account. The user id
 *      is taken from this signed payload ONLY — never from the callback request.
 *   2. Sign the payload with HMAC-SHA256 keyed by a value derived from
 *      `ENCRYPTION_KEY`, so it cannot be minted without the server secret.
 *   3. Expire the state (`exp`, ~10 minutes) to shrink the replay window.
 *   4. Consume each nonce exactly once, tracked in an in-process TTL set, so a
 *      captured state cannot be replayed even within its lifetime.
 *
 * SINGLE-INSTANCE LIMITATION: the consumed-nonce store is process-local. With
 * multiple server instances (or serverless replicas) a nonce consumed on one
 * instance is not known to the others, so replay protection is best-effort
 * unless a shared store (e.g. Redis/Postgres) is substituted. Signature +
 * expiry + user binding still hold across instances. See `docs/notion-integration.md`.
 */

export type OAuthStateErrorCode =
  | 'not_configured'
  | 'malformed'
  | 'invalid_signature'
  | 'expired'
  | 'replayed';

/** Typed, user-safe error. Messages never include the signing key or payload. */
export class OAuthStateError extends Error {
  readonly code: OAuthStateErrorCode;

  constructor(message: string, code: OAuthStateErrorCode) {
    super(message);
    this.name = 'OAuthStateError';
    this.code = code;
  }
}

/** Decoded, verified state payload. */
export interface OAuthStatePayload {
  userId: string;
  nonce: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

/** State lifetime in seconds (10 minutes). */
export const STATE_TTL_SECONDS = 10 * 60;

const NONCE_BYTES = 16;
const KEY_SALT = 'ai-task-assistant.notion.oauth-state.v1';

/** In-process, TTL-bounded set of consumed nonces -> expiry epoch seconds. */
const consumedNonces = new Map<string, number>();

function signingKey(): Buffer {
  const raw = config.encryptionKey;
  if (!raw) {
    throw new OAuthStateError(
      'OAuth state signing is not configured (missing ENCRYPTION_KEY).',
      'not_configured'
    );
  }
  return scryptSync(raw, KEY_SALT, 32);
}

function base64UrlEncode(input: Buffer | string): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  const withPadding = remainder === 0 ? padded : padded + '='.repeat(4 - remainder);
  return Buffer.from(withPadding, 'base64');
}

function sign(encodedPayload: string): string {
  return base64UrlEncode(createHmac('sha256', signingKey()).update(encodedPayload).digest());
}

/** Drops nonces whose expiry has passed so the store cannot grow unbounded. */
function pruneConsumed(nowSeconds: number): void {
  for (const [nonce, exp] of consumedNonces) {
    if (exp <= nowSeconds) consumedNonces.delete(nonce);
  }
}

/**
 * Creates a fresh signed state for `userId`.
 *
 * @throws {OAuthStateError} `not_configured` when `ENCRYPTION_KEY` is missing.
 */
export function createState(userId: string, ttlSeconds: number = STATE_TTL_SECONDS): string {
  if (!userId) {
    throw new OAuthStateError('A user id is required to create OAuth state.', 'malformed');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: OAuthStatePayload = {
    userId,
    nonce: randomBytes(NONCE_BYTES).toString('hex'),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

/**
 * Verifies a state's signature and expiry, then consumes its nonce (single use).
 *
 * @throws {OAuthStateError} `malformed` | `invalid_signature` | `expired` |
 * `replayed` | `not_configured`.
 */
export function verifyState(state: unknown, nowSeconds: number = Math.floor(Date.now() / 1000)): OAuthStatePayload {
  if (typeof state !== 'string' || state.length === 0) {
    throw new OAuthStateError('OAuth state is missing.', 'malformed');
  }

  const segments = state.split('.');
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new OAuthStateError('OAuth state is malformed.', 'malformed');
  }

  const [encodedPayload, providedSignature] = segments;
  const expectedSignature = sign(encodedPayload);

  // Constant-time signature comparison (length mismatch is rejected first).
  if (!safeEqual(providedSignature, expectedSignature)) {
    throw new OAuthStateError('OAuth state signature is invalid.', 'invalid_signature');
  }

  let payload: OAuthStatePayload;
  try {
    const decoded = base64UrlDecode(encodedPayload).toString('utf8');
    payload = JSON.parse(decoded) as OAuthStatePayload;
  } catch {
    throw new OAuthStateError('OAuth state is malformed.', 'malformed');
  }

  if (
    !payload ||
    typeof payload.userId !== 'string' ||
    payload.userId.length === 0 ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length === 0 ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    throw new OAuthStateError('OAuth state is malformed.', 'malformed');
  }

  pruneConsumed(nowSeconds);

  if (payload.exp <= nowSeconds) {
    throw new OAuthStateError('OAuth state has expired.', 'expired');
  }

  if (consumedNonces.has(payload.nonce)) {
    throw new OAuthStateError('OAuth state has already been used.', 'replayed');
  }

  // Consume the nonce only after every other check passes.
  consumedNonces.set(payload.nonce, payload.exp);

  return payload;
}

/** Test-only helper: clears the in-process consumed-nonce store. */
export function resetOAuthStateStore(): void {
  consumedNonces.clear();
}
