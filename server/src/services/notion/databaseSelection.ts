import { listMappings } from './databaseMappingRepository';
import type { NotionDatabaseMapping } from './databaseMappingRepository';
import type { NotionDatabasePurpose } from '../../validators/notionDatabase';

/**
 * Phase 10 — Notion database selection intelligence.
 *
 * Decides which of a user's mapped Notion databases a new task should be filed
 * in. The AI extracts a free-form `category`; this service normalises it to one
 * of the five purposes, then resolves a database with a deterministic fallback
 * chain. Every read is user-scoped (delegated to
 * {@link listMappings}, which filters on `user_id`).
 *
 * Design rules:
 *  - Never throws for "the user has no databases" — the caller receives a typed
 *    `no_databases` signal so the assistant can ask conversationally.
 *  - Pure decision logic on top of the repository; no Notion network call here
 *    (verifying an explicitly-supplied `databaseId` is the orchestrator's job,
 *    which does so with a schema fetch scoped to the user's token).
 */

/** A selectable candidate surfaced when the assistant must ask which database. */
export interface DatabaseCandidate {
  databaseId: string;
  title: string;
  purpose: NotionDatabasePurpose | null;
  isDefault: boolean;
}

/** Why a database was auto-selected. */
export type DatabaseSelectionSource = 'purpose' | 'default' | 'single';

/**
 * Typed selection result. A discriminated union so callers cannot accidentally
 * read `databaseId` without first checking `status`.
 */
export type DatabaseSelectionResult =
  | {
      status: 'selected';
      databaseId: string;
      title: string;
      purpose: NotionDatabasePurpose | null;
      source: DatabaseSelectionSource;
    }
  | { status: 'needs_choice'; candidates: DatabaseCandidate[] }
  | { status: 'no_databases'; candidates: [] };

/**
 * Keyword table mapping free-form category text to a purpose. Order within each
 * list is not significant (all keywords are tried); the first purpose whose
 * keyword appears wins, and `work`/`personal`/`school`/`projects` are checked
 * before the `other` catch-all.
 *
 * Deliberately conservative: a category with no matching keyword resolves to
 * `other` rather than guessing a domain.
 */
export const CATEGORY_PURPOSE_KEYWORDS: ReadonlyArray<{
  purpose: NotionDatabasePurpose;
  keywords: readonly string[];
}> = [
  {
    purpose: 'work',
    keywords: ['work', 'office', 'client', 'meeting', 'job', 'business', 'career', 'report'],
  },
  {
    purpose: 'school',
    keywords: ['school', 'study', 'class', 'course', 'assignment', 'homework', 'exam', 'uni'],
  },
  {
    purpose: 'projects',
    keywords: ['project', 'side project', 'sprint', 'initiative', 'product', 'build'],
  },
  {
    purpose: 'personal',
    keywords: ['personal', 'home', 'errand', 'family', 'health', 'gym', 'shopping', 'life'],
  },
  { purpose: 'other', keywords: ['other', 'misc', 'general', 'inbox'] },
];

/**
 * Normalises a free-form AI category to a purpose. Returns `null` when the
 * category is missing/blank or matches nothing (the caller then falls back to
 * the default / single-mapping rules).
 */
export function categoryToPurpose(category?: string | null): NotionDatabasePurpose | null {
  if (!category) return null;
  const normalised = category.trim().toLowerCase();
  if (!normalised) return null;

  for (const entry of CATEGORY_PURPOSE_KEYWORDS) {
    if (entry.keywords.some((keyword) => normalised.includes(keyword))) {
      return entry.purpose;
    }
  }

  return null;
}

/** Converts a mapping row into the public candidate shape. */
function toCandidate(mapping: NotionDatabaseMapping): DatabaseCandidate {
  return {
    databaseId: mapping.notionDatabaseId,
    title: mapping.databaseTitle ?? 'Untitled',
    purpose: mapping.purpose,
    isDefault: mapping.isDefault,
  };
}

/** Picks the best mapping for a purpose: default first, then oldest first. */
function pickForPurpose(
  mappings: NotionDatabaseMapping[],
  purpose: NotionDatabasePurpose
): NotionDatabaseMapping | undefined {
  const matches = mappings.filter((mapping) => mapping.purpose === purpose);
  if (matches.length === 0) return undefined;
  return matches.find((mapping) => mapping.isDefault) ?? matches[0];
}

/**
 * Resolves the Notion database a task should be created in.
 *
 * Resolution order:
 *  1. `category` → purpose (keyword match) → the mapping tagged with that
 *     purpose (default wins), `source: 'purpose'`.
 *  2. The user's `is_default` mapping, `source: 'default'`.
 *  3. The user's only mapping, `source: 'single'`.
 *  4. Otherwise `needs_choice` with every mapping as a candidate.
 *
 * Returns `no_databases` (never throws) when the user has mapped nothing.
 */
export async function selectDatabase(
  userId: string,
  category?: string | null
): Promise<DatabaseSelectionResult> {
  const mappings = await listMappings(userId);

  if (mappings.length === 0) {
    return { status: 'no_databases', candidates: [] };
  }

  const purpose = categoryToPurpose(category);
  if (purpose) {
    const byPurpose = pickForPurpose(mappings, purpose);
    if (byPurpose) {
      return {
        status: 'selected',
        databaseId: byPurpose.notionDatabaseId,
        title: byPurpose.databaseTitle ?? 'Untitled',
        purpose: byPurpose.purpose,
        source: 'purpose',
      };
    }
  }

  const defaultMapping = mappings.find((mapping) => mapping.isDefault);
  if (defaultMapping) {
    return {
      status: 'selected',
      databaseId: defaultMapping.notionDatabaseId,
      title: defaultMapping.databaseTitle ?? 'Untitled',
      purpose: defaultMapping.purpose,
      source: 'default',
    };
  }

  if (mappings.length === 1) {
    const only = mappings[0];
    return {
      status: 'selected',
      databaseId: only.notionDatabaseId,
      title: only.databaseTitle ?? 'Untitled',
      purpose: only.purpose,
      source: 'single',
    };
  }

  return { status: 'needs_choice', candidates: mappings.map(toCandidate) };
}
