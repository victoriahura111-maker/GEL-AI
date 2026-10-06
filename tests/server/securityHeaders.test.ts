import request from 'supertest';
import { createApp } from '../../server/src/app';
import { config } from '../../server/src/config';

const ALLOWED_ORIGIN = config.corsOrigins[0];

describe('security headers', () => {
  it('sets helmet headers appropriate for a JSON API', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('does not advertise the server technology', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  it('allows the configured SPA origin', async () => {
    const response = await request(createApp()).get('/health').set('Origin', ALLOWED_ORIGIN);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('answers a preflight request for the configured origin', async () => {
    const response = await request(createApp())
      .options('/health')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers['access-control-allow-methods']).toContain('GET');
  });

  it('rejects a disallowed origin', async () => {
    const response = await request(createApp())
      .get('/health')
      .set('Origin', 'https://evil.example.com');

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows requests without an Origin header (curl / server-to-server)', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('request body limits', () => {
  it('rejects an oversized JSON body with 413', async () => {
    const response = await request(createApp())
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ content: 'x'.repeat(200_000) }));

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'Payload Too Large' });
  });
});
