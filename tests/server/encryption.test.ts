/**
 * Unit tests for the AES-256-GCM token encryption utility.
 *
 * The module reads `ENCRYPTION_KEY` from the config, which is captured at import
 * time, so each scenario clears the env and re-imports with `jest.resetModules`.
 */

type EncryptionModule = typeof import('../../server/src/utils/encryption');

const VALID_KEY = 'test-encryption-key-0123456789abcdef';
const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

async function loadEncryption(key: string | undefined): Promise<EncryptionModule> {
  // Use '' (not delete) so dotenv cannot repopulate from a stray local .env —
  // the config loader coerces '' to undefined.
  process.env.ENCRYPTION_KEY = key ?? '';
  jest.resetModules();
  return import('../../server/src/utils/encryption');
}

function getError(fn: () => unknown): Error & { code?: string } {
  try {
    fn();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('Expected the function to throw, but it returned.');
}

afterEach(() => {
  process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  jest.resetModules();
});

afterAll(() => {
  process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe('encrypt / decrypt', () => {
  it('round-trips a plaintext value', async () => {
    const { encrypt, decrypt } = await loadEncryption(VALID_KEY);

    const payload = encrypt('notion-secret-token');

    expect(payload.startsWith('v1:')).toBe(true);
    expect(payload.split(':')).toHaveLength(4);
    expect(decrypt(payload)).toBe('notion-secret-token');
  });

  it('never embeds the plaintext and uses a fresh IV each time', async () => {
    const { encrypt } = await loadEncryption(VALID_KEY);

    const first = encrypt('super-secret');
    const second = encrypt('super-secret');

    expect(first).not.toContain('super-secret');
    expect(first).not.toBe(second);
  });

  it('fails closed when the ciphertext is tampered with', async () => {
    const { encrypt, decrypt, EncryptionError } = await loadEncryption(VALID_KEY);

    const parts = encrypt('super-secret').split(':');
    const ciphertext = Buffer.from(parts[3], 'base64');
    ciphertext[0] ^= 0xff;
    parts[3] = ciphertext.toString('base64');

    const error = getError(() => decrypt(parts.join(':')));

    expect(error).toBeInstanceOf(EncryptionError);
    expect(error.code).toBe('tampered');
  });

  it('fails closed when the authentication tag is tampered with', async () => {
    const { encrypt, decrypt, EncryptionError } = await loadEncryption(VALID_KEY);

    const parts = encrypt('super-secret').split(':');
    const tag = Buffer.from(parts[2], 'base64');
    tag[0] ^= 0xff;
    parts[2] = tag.toString('base64');

    const error = getError(() => decrypt(parts.join(':')));

    expect(error).toBeInstanceOf(EncryptionError);
    expect(error.code).toBe('tampered');
  });

  it('rejects a malformed or unknown-version payload', async () => {
    const { encrypt, decrypt } = await loadEncryption(VALID_KEY);

    expect(getError(() => decrypt('not-a-payload')).code).toBe('malformed');

    const parts = encrypt('x').split(':');
    parts[0] = 'v2';
    expect(getError(() => decrypt(parts.join(':'))).code).toBe('malformed');
  });
});

describe('configuration guards', () => {
  it('throws not_configured when ENCRYPTION_KEY is missing', async () => {
    const { encrypt, decrypt, EncryptionError } = await loadEncryption(undefined);

    const encryptError = getError(() => encrypt('x'));
    expect(encryptError).toBeInstanceOf(EncryptionError);
    expect(encryptError.code).toBe('not_configured');

    const decryptError = getError(() => decrypt('v1:a:b:c'));
    expect(decryptError.code).toBe('not_configured');
  });

  it('throws invalid_key when ENCRYPTION_KEY is too short', async () => {
    const { encrypt, EncryptionError } = await loadEncryption('too-short');

    const error = getError(() => encrypt('x'));

    expect(error).toBeInstanceOf(EncryptionError);
    expect(error.code).toBe('invalid_key');
  });

  it('never falls back to a hard-coded key when unconfigured', async () => {
    const { encrypt } = await loadEncryption(undefined);
    expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY/);
  });
});
