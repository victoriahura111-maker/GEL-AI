import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

/**
 * Server-side Supabase admin client.
 *
 * Created with the SERVICE ROLE key, which bypasses Row Level Security. This
 * module must NEVER be imported by client code, and the service role key must
 * never be logged or returned to any caller.
 *
 * It is `null` when Supabase is not configured so the server can still boot
 * with safe defaults (and clear warnings from the config loader). Callers are
 * responsible for guarding against `null` and responding with a 503.
 */
export const supabaseAdmin: SupabaseClient | null = config.isSupabaseConfigured
  ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;
