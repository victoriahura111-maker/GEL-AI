import { redact, redactUrl } from '../../server/src/middleware/requestLogger';

describe('redact', () => {
  it('redacts Bearer tokens', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts JWT-shaped values anywhere in a string', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(redact(`token=${jwt}`)).toBe('token=[REDACTED]');
  });

  it('leaves non-secret values untouched', () => {
    expect(redact('GET /api/tasks 200')).toBe('GET /api/tasks 200');
  });
});

describe('redactUrl', () => {
  it('redacts sensitive query parameters and keeps benign ones', () => {
    const result = redactUrl('/api/notion/oauth/callback?code=abc&state=xyz&page=2');

    expect(result).toContain('/api/notion/oauth/callback');
    expect(result).toContain('page=2');
    expect(result).not.toContain('abc');
    expect(result).not.toContain('xyz');
    expect(result).toContain('code=');
    expect(result).toContain('state=');
  });

  it('handles URLs without a query string', () => {
    expect(redactUrl('/api/tasks')).toBe('/api/tasks');
  });
});
