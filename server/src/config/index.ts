import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// Load environment variables from the repository root so a single .env file
// (copied from .env.example) serves the whole monorepo regardless of cwd.
loadEnv({ path: path.resolve(__dirname, '../../../.env') });

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

/** Parses a boolean-ish env var, falling back to `defaultValue` when unset. */
const booleanFromString = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    const normalised = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
    return undefined;
  }, z.boolean().default(defaultValue));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(4000)),
  API_URL: z.preprocess(emptyToUndefined, z.string().url().default('http://localhost:4000')),
  APP_URL: z.preprocess(emptyToUndefined, z.string().url().default('http://localhost:5173')),
  SUPABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  SUPABASE_ANON_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  AI_PROVIDER: z.preprocess(emptyToUndefined, z.string().optional()),
  AI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  AI_MODEL: z.preprocess(emptyToUndefined, z.string().optional()),
  AI_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  NOTION_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  NOTION_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  NOTION_REDIRECT_URI: z.preprocess(emptyToUndefined, z.string().optional()),
  ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  // Phase 13 — reminder engine. The scheduler stays off unless Supabase is
  // configured and REMINDERS_ENABLED is not false.
  REMINDER_TICK_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(60000)
  ),
  REMINDERS_ENABLED: booleanFromString(true),
  // Phase 15 — follow-up engine. The scheduler stays off unless Supabase is
  // configured and FOLLOW_UP_ENABLED is not false. The lead/interval/cap
  // values are the global anti-spam defaults; per-user overrides arrive in
  // Phase 24 (settings).
  FOLLOW_UP_ENABLED: booleanFromString(true),
  FOLLOW_UP_TICK_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(300000)
  ),
  FOLLOW_UP_LEAD_HOURS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().positive().default(24)
  ),
  FOLLOW_UP_MIN_INTERVAL_HOURS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().positive().default(20)
  ),
  FOLLOW_UP_MAX_PER_TASK: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(3)
  ),
  // Phase 16 — Notion synchronization. The scheduler is DISABLED by default
  // (SYNC_ENABLED=false) because periodic sync is opt-in: it also requires
  // Supabase + Notion to be configured. SYNC_TICK_MS is the worker interval
  // (default 15 minutes); SYNC_MIN_INTERVAL_MS is the per-user cooldown that
  // protects the manual `POST /api/sync` endpoint from hammering Notion.
  SYNC_ENABLED: booleanFromString(false),
  SYNC_TICK_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(900000)
  ),
  SYNC_MIN_INTERVAL_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(10000)
  ),
  // Phase 17 — security hardening.
  // TRUST_PROXY enables Express `trust proxy` (set it to the number of trusted
  // hops, or `true`/`1` behind a single trusted reverse proxy). Off by default so
  // a direct deployment cannot be fooled into trusting spoofed X-Forwarded-* headers.
  TRUST_PROXY: booleanFromString(false),
  // CORS_ORIGIN restricts browser access to the configured SPA origin(s). Accepts
  // a single origin or a comma-separated list. Falls back to APP_URL when unset.
  CORS_ORIGIN: z.preprocess(emptyToUndefined, z.string().optional()),
  // Phase 17 — per-window request limits (express-rate-limit).
  RATE_LIMIT_WINDOW_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(60000)
  ),
  RATE_LIMIT_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(300)
  ),
  RATE_LIMIT_ASSISTANT_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(30)
  ),
  RATE_LIMIT_SYNC_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(10)
  ),
  RATE_LIMIT_NOTION_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(60)
  ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[config] Invalid environment configuration.');
  console.error('[config]', JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

const env = parsed.data;

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'AI_PROVIDER',
  'AI_API_KEY',
  'AI_MODEL',
  'NOTION_CLIENT_ID',
  'NOTION_CLIENT_SECRET',
  'NOTION_REDIRECT_URI',
  'APP_URL',
  'API_URL',
  'ENCRYPTION_KEY',
] as const;

const missingVars = REQUIRED_VARS.filter((name) => !process.env[name]);

if (missingVars.length > 0) {
  if (env.NODE_ENV === 'production') {
    console.error(`[config] Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
  }
  console.warn(
    `[config] Missing environment variables (safe local defaults applied): ${missingVars.join(', ')}`
  );
}

export const config = {
  env: env.NODE_ENV,
  port: env.PORT,
  apiUrl: env.API_URL,
  appUrl: env.APP_URL,
  supabaseUrl: env.SUPABASE_URL ?? '',
  supabaseAnonKey: env.SUPABASE_ANON_KEY ?? '',
  supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  isSupabaseConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
  aiProvider: env.AI_PROVIDER ?? '',
  aiApiKey: env.AI_API_KEY ?? '',
  aiModel: env.AI_MODEL ?? '',
  aiBaseUrl: env.AI_BASE_URL ?? 'https://api.openai.com/v1',
  isAiConfigured: Boolean(env.AI_API_KEY && env.AI_MODEL),
  notionClientId: env.NOTION_CLIENT_ID ?? '',
  notionClientSecret: env.NOTION_CLIENT_SECRET ?? '',
  notionRedirectUri: env.NOTION_REDIRECT_URI ?? '',
  isNotionConfigured: Boolean(
    env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET && env.NOTION_REDIRECT_URI
  ),
  encryptionKey: env.ENCRYPTION_KEY ?? '',
  isEncryptionConfigured: Boolean(env.ENCRYPTION_KEY),
  // Phase 13 — reminder engine.
  reminderTickMs: env.REMINDER_TICK_MS,
  remindersEnabled: env.REMINDERS_ENABLED,
  // Phase 15 — follow-up engine (global anti-spam defaults).
  followUpEnabled: env.FOLLOW_UP_ENABLED,
  followUpTickMs: env.FOLLOW_UP_TICK_MS,
  followUpLeadHours: env.FOLLOW_UP_LEAD_HOURS,
  followUpMinIntervalHours: env.FOLLOW_UP_MIN_INTERVAL_HOURS,
  followUpMaxPerTask: env.FOLLOW_UP_MAX_PER_TASK,
  // Phase 16 — Notion synchronization (opt-in; disabled by default).
  syncEnabled: env.SYNC_ENABLED,
  syncTickMs: env.SYNC_TICK_MS,
  syncMinIntervalMs: env.SYNC_MIN_INTERVAL_MS,
  // Phase 17 — security hardening.
  isTest: env.NODE_ENV === 'test',
  // Express `trust proxy` value. `false` by default; set via TRUST_PROXY.
  trustProxy: env.TRUST_PROXY,
  // The primary allowed CORS origin (falls back to APP_URL).
  corsOrigin: env.CORS_ORIGIN?.split(',')[0]?.trim() || env.APP_URL,
  // Every allowed CORS origin, comma-separated (defaults to APP_URL alone).
  corsOrigins: (env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',') : [env.APP_URL])
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  // Request body size cap. Assistant content is already capped at 4000 chars.
  jsonBodyLimit: '100kb',
  // express-rate-limit tuning. Tests override these to stay non-flaky (see
  // `middleware/rateLimit.ts`, which publishes effectively-infinite test limits).
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    assistantMax: env.RATE_LIMIT_ASSISTANT_MAX,
    syncMax: env.RATE_LIMIT_SYNC_MAX,
    notionMax: env.RATE_LIMIT_NOTION_MAX,
  },
} as const;

export default config;
