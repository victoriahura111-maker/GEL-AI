/**
 * Unit tests for the signed, expiring, single-use, user-bound OAuth state.
 *
 * `ENCRYPTION_KEY` is provided by `tests/server/setupEnv.ts`, so the real module
 * is imported directly (no network, no database).
 */

import {
  createState,
  resetOAuthStateStore,
  verifyState,
  OAuthStateError,
} from '../../server/src/services/notion/oauthState';

function getError(fn: () => unknown): Error & { code?: string } {
  try {
    fn();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('Expected the function to throw, but it returned.');
}

beforeEach(() => {
  resetOAuthStateStore();
});

describe('OAuth state', () => {
  it('creates a state that verifies and is bound to the initiating user', () => {
    const state = createState('user-1');

    const payload = verifyState(state);

    expect(payload.userId).toBe('user-1');
    expect(payload.nonce).toHaveLength(32);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('keeps distinct states bound to their own users', () => {
    const stateA = createState('user-a');
    const stateB = createState('user-b');

    expect(verifyState(stateA).userId).toBe('user-a');
    expect(verifyState(stateB).userId).toBe('user-b');
  });

  it('rejects an expired state', () => {
    const state = createState('user-1', -1);

    const error = getError(() => verifyState(state));

    expect(error).toBeInstanceOf(OAuthStateError);
    expect(error.code).toBe('expired');
  });

  it('rejects a forged signature', () => {
    const [payload] = createState('user-1').split('.');
    const otherSignature = createState('user-1').split('.')[1];

    const error = getError(() => verifyState(`${payload}.${otherSignature}`));

    expect(error).toBeInstanceOf(OAuthStateError);
    expect(error.code).toBe('invalid_signature');
  });

  it('rejects a tampered payload', () => {
    const [payload, signature] = createState('user-1').split('.');
    const flipped = (payload[0] === 'A' ? 'B' : 'A') + payload.slice(1);

    const error = getError(() => verifyState(`${flipped}.${signature}`));

    expect(error.code).toBe('invalid_signature');
  });

  it('rejects malformed states', () => {
    expect(getError(() => verifyState('not-a-state')).code).toBe('malformed');
    expect(getError(() => verifyState('')).code).toBe('malformed');
    expect(getError(() => verifyState(undefined)).code).toBe('malformed');
  });

  it('is single-use: a second verification is rejected', () => {
    const state = createState('user-1');

    expect(verifyState(state).userId).toBe('user-1');

    const error = getError(() => verifyState(state));
    expect(error).toBeInstanceOf(OAuthStateError);
    expect(error.code).toBe('replayed');
  });

  it('does not mark an expired state as consumed', () => {
    const state = createState('user-1', -1);

    expect(getError(() => verifyState(state)).code).toBe('expired');
    expect(getError(() => verifyState(state)).code).toBe('expired');
  });
});
