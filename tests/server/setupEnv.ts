// Server tests run with Supabase "configured" so the auth middleware can be
// exercised (otherwise it short-circuits with a 503). The @supabase/supabase-js
// module itself is mocked in auth.test.ts, so no real credentials are used.
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

// Phase 7 — Notion OAuth + token encryption. These are non-secret test values;
// tests that need "unconfigured" behavior re-import the config with these
// values cleared. `ENCRYPTION_KEY` must be >= 32 characters.
process.env.ENCRYPTION_KEY = 'test-encryption-key-0123456789abcdef';
process.env.NOTION_CLIENT_ID = 'test-notion-client-id';
process.env.NOTION_CLIENT_SECRET = 'test-notion-client-secret';
process.env.NOTION_REDIRECT_URI = 'http://localhost:4000/api/notion/oauth/callback';
process.env.APP_URL = 'http://localhost:5173';
