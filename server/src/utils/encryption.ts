import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config';

/**
 * Symmetric encryption for secrets at rest (Notion access tokens).
 *
 * Algorithm : AES-256-GCM (authenticated encryption — tampering is detected).
 * Key        : derived deterministically from `ENCRYPTION_KEY` via scrypt with a
 *              fixed, non-secret salt, so the same env value always produces the
 *              same 32-byte key across restarts and instances.
 * Wire format: `v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>`
 *              The `v1` prefix is versioned so a future key/algorithm rotation
 *              can be introduced without ambiguity.
 *
 * The plaintext key never leaves this module; only ciphertext is stored. When
 * `ENCRYPTION_KEY` is missing or too short this module fails closed (a typed
 * `EncryptionError`) instead of falling back to a hard-coded key.
 */

/** Minimum acceptable `ENCRYPTION_KEY` length (characters). */
export const MIN_ENCRYPTION_KEY_LENGTH = 32;

const KEY_LENGTH = 32;
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size.
const AUTH_TAG_LENGTH = 16;
const CURRENT_VERSION = 'v1';

/** Fixed scrypt salt. Not secret — its only job is deterministic derivation. */
const KEY_SALT = 'ai-task-assistant.notion.token.v1';

export type EncryptionErrorCode =
  | 'not_configured'
  | 'invalid_key'
  | 'malformed'
  | 'tampered'
  | 'decrypt_failed';

/** Typed, user-safe error. Messages never include the key or plaintext. */
export class EncryptionError extends Error {
  readonly code: EncryptionErrorCode;

  constructor(message: string, code: EncryptionErrorCode) {
    super(message);
    this.name = 'EncryptionError';
    this.code = code;
  }
}

/** Resolves and validates the raw `ENCRYPTION_KEY`, failing closed when absent. */
function getRawKey(): string {
  const raw = config.encryptionKey;
  if (!raw) {
    throw new EncryptionError(
      'Encryption is not configured. Set ENCRYPTION_KEY (at least 32 characters).',
      'not_configured'
    );
  }
  if (raw.length < MIN_ENCRYPTION_KEY_LENGTH) {
    throw new EncryptionError(
      `ENCRYPTION_KEY must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters long.`,
      'invalid_key'
    );
  }
  return raw;
}

/** Derives the 32-byte AES key from `ENCRYPTION_KEY` (deterministic). */
function deriveKey(): Buffer {
  return scryptSync(getRawKey(), KEY_SALT, KEY_LENGTH);
}

/**
 * Encrypts `plaintext` and returns the versioned, self-describing payload.
 *
 * @throws {EncryptionError} `not_configured` / `invalid_key` when the key is
 * unusable.
 */
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    CURRENT_VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypts a payload produced by {@link encrypt}.
 *
 * Fails closed: a tampered ciphertext, wrong key, or malformed payload raises an
 * {@link EncryptionError} rather than returning partial/attacker-controlled data.
 */
export function decrypt(payload: string): string {
  const key = deriveKey();

  const parts = payload.split(':');
  if (parts.length !== 4) {
    throw new EncryptionError('Encrypted payload is malformed.', 'malformed');
  }

  const [version, ivB64, authTagB64, ciphertextB64] = parts;
  if (version !== CURRENT_VERSION) {
    throw new EncryptionError('Encrypted payload has an unsupported version.', 'malformed');
  }

  let iv: Buffer;
  let authTag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(ivB64, 'base64');
    authTag = Buffer.from(authTagB64, 'base64');
    ciphertext = Buffer.from(ciphertextB64, 'base64');
  } catch {
    throw new EncryptionError('Encrypted payload is malformed.', 'malformed');
  }

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new EncryptionError('Encrypted payload is malformed.', 'malformed');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    // Auth-tag mismatch (tampering / wrong key) or unrecoverable ciphertext.
    throw new EncryptionError('Encrypted payload failed authentication.', 'tampered');
  }
}

/**
 * Constant-time string comparison for secrets/signatures of equal length.
 * Returns `false` (never throws) when lengths differ.
 */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export default { encrypt, decrypt, safeEqual, EncryptionError };
