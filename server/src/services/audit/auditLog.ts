import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';

/**
 * Phase 10 — append-only write helper for `public.assistant_audit_logs`.
 *
 * Audit writes are intentionally best-effort: they must never fail a user
 * action that already succeeded against Notion. Failures are logged and
 * swallowed. Every row is scoped to the authenticated `userId`.
 */

const TABLE = 'assistant_audit_logs';

/** Row shape of `public.assistant_audit_logs`. */
export interface AuditLogRecord {
  id: string;
  user_id: string;
  action: string;
  task_id: string | null;
  notion_page_id: string | null;
  tool_name: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Input for {@link writeAuditLog}. */
export interface WriteAuditLogInput {
  action: string;
  taskId?: string | null;
  notionPageId?: string | null;
  toolName?: string | null;
  metadata?: Record<string, unknown> | null;
}

function client(): SupabaseClient | null {
  return supabaseAdmin;
}

/**
 * Appends an audit row for `userId`. Never throws: on an unconfigured Supabase
 * or a write failure it logs and returns `null` so the caller's primary action
 * is unaffected.
 */
export async function writeAuditLog(
  userId: string,
  input: WriteAuditLogInput
): Promise<AuditLogRecord | null> {
  const admin = client();
  if (!admin) return null;

  try {
    const { data, error } = await admin
      .from(TABLE)
      .insert({
        user_id: userId,
        action: input.action,
        task_id: input.taskId ?? null,
        notion_page_id: input.notionPageId ?? null,
        tool_name: input.toolName ?? null,
        metadata: input.metadata ?? null,
      })
      .select('*')
      .single();

    if (error) {
      console.error('[audit] Could not write an audit log entry.');
      return null;
    }

    return (data as AuditLogRecord | null) ?? null;
  } catch {
    console.error('[audit] Could not write an audit log entry.');
    return null;
  }
}
