import {
  SUPPORTED_PROPERTY_TYPES,
  type NotionDatabaseSchema,
  type NotionPropertyOption,
  type NotionPropertySchema,
} from './schema';

/**
 * Phase 9 — Reusable property-mapping service.
 *
 * Turns a normalised {@link NotionDatabaseSchema} into a stable mapping from the
 * app's internal task fields (`title`, `date`, `status`, `priority`, `category`,
 * `description`, `url`, `people`) to Notion property NAMES, and builds the
 * `properties` payload for a Notion page create/update.
 *
 * Design rules:
 *  - Deterministic and pure: the same schema always yields the same mapping.
 *    Candidates are considered in schema order and ties are broken by
 *    schema order, with exact name matches preferred over substring matches.
 *  - NEVER assigns the same Notion property to two internal fields (`used` set).
 *  - The mapping shape is exactly the public contract; resolved property
 *    metadata (type + options) is kept in a module-private `WeakMap` keyed by
 *    the returned mapping object so `buildNotionProperties(mapping, task)` can
 *    emit correct per-type payloads without widening the public contract.
 */

/** Internal-field → Notion-property-name mapping (the public contract). */
export interface PropertyMapping {
  title: string;
  date?: string;
  status?: string;
  priority?: string;
  category?: string;
  description?: string;
  url?: string;
  people?: string;
  /** Notion properties of a type Phase 9 does not map. */
  unsupported: Array<{ name: string; type: string }>;
}

export type PropertyMappingErrorCode = 'missing_title';

/** Typed error raised when a schema cannot be mapped (e.g. no title property). */
export class PropertyMappingError extends Error {
  readonly code: PropertyMappingErrorCode;

  constructor(message: string, code: PropertyMappingErrorCode) {
    super(message);
    this.name = 'PropertyMappingError';
    this.code = code;
  }
}

/**
 * The subset of the task domain model used for Notion writes. `people` is out of
 * scope for Phase 9 (no user resolution) and is intentionally absent.
 */
export interface NotionTaskInput {
  title?: string | null;
  description?: string | null;
  category?: string | null;
  priority?: string | null;
  status?: string | null;
  due_date?: string | null;
  due_time?: string | null;
  timezone?: string | null;
  notion_url?: string | null;
}

/** Internal field names that can be mapped. */
export type MappedField =
  'title' | 'date' | 'status' | 'priority' | 'category' | 'description' | 'url' | 'people';

/** Keyword tables driving the heuristics (documented in `docs/notion-integration.md`). */
export const MAPPING_KEYWORDS = {
  date: ['due', 'deadline', 'date'],
  status: ['status', 'state'],
  priority: ['priority', 'urgency'],
  category: ['category', 'type', 'tags', 'project', 'label'],
  description: ['description', 'notes', 'details'],
} as const;

const SUPPORTED = new Set<string>(SUPPORTED_PROPERTY_TYPES);

/** Resolved property metadata per mapping (module-private, non-leaking). */
const resolvedProperties = new WeakMap<PropertyMapping, Map<MappedField, NotionPropertySchema>>();

/* ------------------------------------------------------------------ */
/* Mapping heuristics                                                  */
/* ------------------------------------------------------------------ */

/**
 * Ranks a name against an ordered keyword list. The returned tuple is
 * `[keywordIndex, exactness]`, where keyword order dominates (the spec lists
 * keywords in preference order) and an exact name match beats a substring match
 * for the same keyword. Returns `null` when nothing matches.
 */
function rankKeyword(name: string, keywords: readonly string[]): [number, number] | null {
  const normalised = name.trim().toLowerCase();
  let best: [number, number] | null = null;

  for (let index = 0; index < keywords.length; index += 1) {
    const keyword = keywords[index];
    const exact = normalised === keyword;
    if (!exact && !normalised.includes(keyword)) continue;

    const rank: [number, number] = [index, exact ? 0 : 1];
    if (!best || isBetterRank(rank, best)) best = rank;
  }

  return best;
}

function isBetterRank(candidate: [number, number], current: [number, number]): boolean {
  if (candidate[0] !== current[0]) return candidate[0] < current[0];
  return candidate[1] < current[1];
}

/** Picks the best keyword-matching candidate, preserving schema order on ties. */
function pickByKeyword(
  candidates: NotionPropertySchema[],
  keywords: readonly string[]
): NotionPropertySchema | undefined {
  let best: NotionPropertySchema | undefined;
  let bestRank: [number, number] | null = null;

  for (const candidate of candidates) {
    const rank = rankKeyword(candidate.name, keywords);
    if (!rank) continue;
    if (!best || !bestRank || isBetterRank(rank, bestRank)) {
      best = candidate;
      bestRank = rank;
    }
  }

  return best;
}

/**
 * Resolves the internal-field → Notion-property-name mapping for a schema.
 *
 * @throws {PropertyMappingError} `missing_title` when the database has no
 * `title` property (Notion guarantees one, but a malformed schema must fail
 * loudly rather than silently drop the task title).
 */
export function resolvePropertyMapping(schema: NotionDatabaseSchema): PropertyMapping {
  const all = schema.properties;
  const used = new Set<string>();
  const resolved = new Map<MappedField, NotionPropertySchema>();

  const title = all.find((property) => property.type === 'title');
  if (!title) {
    throw new PropertyMappingError(
      'The Notion database has no title property to map the task title to.',
      'missing_title'
    );
  }

  const mapping: PropertyMapping = { title: title.name, unsupported: [] };
  used.add(title.name);
  resolved.set('title', title);

  const assign = (field: MappedField, property: NotionPropertySchema | undefined): void => {
    if (!property) return;
    (mapping as unknown as Record<string, unknown>)[field] = property.name;
    resolved.set(field, property);
    used.add(property.name);
  };

  const available = (
    predicate: (property: NotionPropertySchema) => boolean
  ): NotionPropertySchema[] =>
    all.filter((property) => !used.has(property.name) && predicate(property));

  const isSelectLike = (property: NotionPropertySchema): boolean =>
    property.type === 'select' || property.type === 'multi_select';

  // date — prefer names containing due/deadline/date, else first date property.
  const dateCandidates = available((property) => property.type === 'date');
  assign('date', pickByKeyword(dateCandidates, MAPPING_KEYWORDS.date) ?? dateCandidates[0]);

  // status — a real `status` property, else a `select` named status/state.
  const statusProperty = available((property) => property.type === 'status')[0];
  const statusSelect = pickByKeyword(
    available((property) => property.type === 'select'),
    MAPPING_KEYWORDS.status
  );
  assign('status', statusProperty ?? statusSelect);

  // priority — select/multi_select named priority/urgency.
  assign('priority', pickByKeyword(available(isSelectLike), MAPPING_KEYWORDS.priority));

  // category — select/multi_select named category/type/tags/project/label
  // (status/priority already removed via `used`).
  assign('category', pickByKeyword(available(isSelectLike), MAPPING_KEYWORDS.category));

  // description — rich_text named description/notes/details, else first rich_text.
  const richTextCandidates = available((property) => property.type === 'rich_text');
  assign(
    'description',
    pickByKeyword(richTextCandidates, MAPPING_KEYWORDS.description) ?? richTextCandidates[0]
  );

  // url — optional first url property.
  assign('url', available((property) => property.type === 'url')[0]);

  // people — optional first people property (Phase 9 does not resolve users).
  assign('people', available((property) => property.type === 'people')[0]);

  mapping.unsupported = all
    .filter((property) => !SUPPORTED.has(property.type))
    .map((property) => ({ name: property.name, type: property.type }));

  resolvedProperties.set(mapping, resolved);
  return mapping;
}

/** Returns the resolved Notion property metadata for a mapped internal field. */
export function getResolvedProperty(
  mapping: PropertyMapping,
  field: MappedField
): NotionPropertySchema | undefined {
  return resolvedProperties.get(mapping)?.get(field);
}

/* ------------------------------------------------------------------ */
/* Payload builders                                                    */
/* ------------------------------------------------------------------ */

/** Friendly Notion option names for internal status values. */
export const STATUS_OPTION_NAMES: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  completed: 'Done',
  cancelled: 'Cancelled',
  overdue: 'Overdue',
};

/** Friendly Notion option names for internal priority values. */
export const PRIORITY_OPTION_NAMES: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

function isProvided(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim().length > 0;
}

/** Case-insensitive option lookup against a select-like property's options. */
function matchOption(
  options: NotionPropertyOption[] | undefined,
  desired: string
): NotionPropertyOption | undefined {
  if (!options) return undefined;
  const needle = desired.trim().toLowerCase();
  return options.find((option) => option.name.trim().toLowerCase() === needle);
}

/**
 * Builds the Notion value payload for a single property type.
 *
 * Per-type shapes:
 *  - `title` / `rich_text` → `{ [type]: [{ text: { content } }] }`
 *  - `select` → `{ select: { name } }` — case-insensitive match to an existing
 *    option when possible; otherwise the raw name is passed through so Notion can
 *    create the option (documented choice for non-status selects).
 *  - `multi_select` → `{ multi_select: [{ name }] }` (same match-or-create rule).
 *  - `status` → `{ status: { name } }` — ONLY when it matches an existing option;
 *    Notion status options cannot be created implicitly, so it is omitted
 *    otherwise.
 *  - `date` → `{ date: { start } }`, `checkbox` → `{ checkbox }`,
 *    `number` → `{ number }`, `url` → `{ url }`.
 *
 * Returns `undefined` when the value is empty or the shape cannot be produced.
 */
export function buildNotionPropertyValue(
  type: string,
  value: unknown,
  options?: NotionPropertyOption[]
): unknown | undefined {
  if (!isProvided(value)) return undefined;

  switch (type) {
    case 'title':
      return { title: [{ text: { content: String(value) } }] };
    case 'rich_text':
      return { rich_text: [{ text: { content: String(value) } }] };
    case 'select': {
      const match = matchOption(options, String(value));
      return { select: { name: match?.name ?? String(value) } };
    }
    case 'multi_select': {
      const match = matchOption(options, String(value));
      return { multi_select: [{ name: match?.name ?? String(value) }] };
    }
    case 'status': {
      const match = matchOption(options, String(value));
      return match ? { status: { name: match.name } } : undefined;
    }
    case 'date':
      return { date: { start: String(value) } };
    case 'checkbox':
      return { checkbox: Boolean(value) };
    case 'number': {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? { number: parsed } : undefined;
    }
    case 'url':
      return { url: String(value) };
    default:
      return undefined;
  }
}

/** Combines `due_date` + `due_time` (+ `timezone`) into a Notion date value. */
function buildDateValue(
  dueDate: string,
  dueTime: string | null | undefined,
  timezone: string | null | undefined
): unknown | undefined {
  const start = isProvided(dueTime) ? `${dueDate}T${String(dueTime)}:00` : dueDate;
  if (!isProvided(start)) return undefined;

  const date: Record<string, unknown> = { start };
  if (isProvided(timezone)) date.time_zone = timezone;
  return { date };
}

/**
 * Builds the `properties` payload for a Notion page create/update.
 *
 * Fields whose Notion property is absent from the mapping, or whose task value
 * is `null`/`undefined`/empty, are omitted.
 */
export function buildNotionProperties(
  mapping: PropertyMapping,
  task: NotionTaskInput
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const resolved = resolvedProperties.get(mapping);

  const propertyOf = (field: MappedField): NotionPropertySchema | undefined => resolved?.get(field);

  if (mapping.title && isProvided(task.title)) {
    properties[mapping.title] = { title: [{ text: { content: String(task.title) } }] };
  }

  if (mapping.description && isProvided(task.description)) {
    properties[mapping.description] = {
      rich_text: [{ text: { content: String(task.description) } }],
    };
  }

  if (mapping.url && isProvided(task.notion_url)) {
    properties[mapping.url] = { url: String(task.notion_url) };
  }

  if (mapping.date && isProvided(task.due_date)) {
    const value = buildDateValue(String(task.due_date), task.due_time, task.timezone);
    if (value) properties[mapping.date] = value;
  }

  if (mapping.status && isProvided(task.status)) {
    const property = propertyOf('status');
    const desired = STATUS_OPTION_NAMES[String(task.status)] ?? String(task.status);
    const value = buildNotionPropertyValue(property?.type ?? 'select', desired, property?.options);
    if (value) properties[mapping.status] = value;
  }

  if (mapping.priority && isProvided(task.priority)) {
    const property = propertyOf('priority');
    const desired = PRIORITY_OPTION_NAMES[String(task.priority)] ?? String(task.priority);
    const value = buildNotionPropertyValue(property?.type ?? 'select', desired, property?.options);
    if (value) properties[mapping.priority] = value;
  }

  if (mapping.category && isProvided(task.category)) {
    const property = propertyOf('category');
    const value = buildNotionPropertyValue(
      property?.type ?? 'select',
      String(task.category),
      property?.options
    );
    if (value) properties[mapping.category] = value;
  }

  return properties;
}
