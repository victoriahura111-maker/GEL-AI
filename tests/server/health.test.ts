import request from 'supertest';
import { createApp } from '../../server/src/app';

describe('GET /health', () => {
  it('responds with 200 and { status: "ok" }', async () => {
    const app = createApp();
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  it('reports dependency configuration booleans without leaking secrets', async () => {
    const response = await request(createApp()).get('/health/ready');

    // Tests run with Supabase/Notion/encryption configured (see
    // tests/server/setupEnv.ts); AI is intentionally unconfigured.
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks).toEqual({
      supabase: true,
      ai: false,
      notion: true,
      encryption: true,
    });
    expect(response.body.schedulersEnabled).toEqual({
      reminders: true,
      followUps: true,
      sync: false,
    });
    expect(typeof response.body.uptimeSeconds).toBe('number');

    // Booleans and metadata only — no config values, URLs, or secrets.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('test-service-role-key');
    expect(serialized).not.toContain('test-encryption-key');
    expect(serialized).not.toContain('test-notion-client-secret');
    expect(serialized).not.toMatch(/https?:\/\//);
  });
});
