export { buildAuthorizationUrl, exchangeCodeForToken, NotionOAuthError, NOTION_VERSION } from './oauth';
export type { NotionOwner, NotionTokenResponse, NotionOAuthErrorCode } from './oauth';

export { createState, verifyState, resetOAuthStateStore, OAuthStateError, STATE_TTL_SECONDS } from './oauthState';
export type { OAuthStatePayload, OAuthStateErrorCode } from './oauthState';

export {
  upsertConnection,
  getConnection,
  getConnectionSummary,
  deleteConnection,
  listConnectedUserIds,
  NotionConnectionRepositoryError,
} from './connectionRepository';
export type {
  NotionConnectionRecord,
  NotionConnection,
  NotionConnectionSummary,
  UpsertConnectionInput,
} from './connectionRepository';

export { listDatabases, getDatabase, getDatabaseRaw, NotionApiError, MAX_SEARCH_PAGES } from './client';
export type { NotionDatabaseSummary, NotionApiErrorCode } from './client';

export {
  getDatabaseSchema,
  toDatabaseSchema,
  clearSchemaCache,
  isSelectLikeType,
  SUPPORTED_PROPERTY_TYPES,
  SCHEMA_CACHE_TTL_MS,
} from './schema';
export type {
  NotionDatabaseSchema,
  NotionPropertySchema,
  NotionPropertyOption,
  NotionPropertyType,
} from './schema';

export {
  resolvePropertyMapping,
  buildNotionProperties,
  buildNotionPropertyValue,
  getResolvedProperty,
  PropertyMappingError,
  MAPPING_KEYWORDS,
  STATUS_OPTION_NAMES,
  PRIORITY_OPTION_NAMES,
} from './propertyMapping';
export type {
  PropertyMapping,
  NotionTaskInput,
  MappedField,
  PropertyMappingErrorCode,
} from './propertyMapping';

export {
  listMappings,
  getMappingsByPurpose,
  upsertMapping,
  deleteMapping,
  setDefault,
  DatabaseMappingRepositoryError,
} from './databaseMappingRepository';
export type {
  NotionDatabaseMappingRecord,
  NotionDatabaseMapping,
  UpsertMappingInput,
} from './databaseMappingRepository';

export { selectDatabase, categoryToPurpose, CATEGORY_PURPOSE_KEYWORDS } from './databaseSelection';
export type {
  DatabaseCandidate,
  DatabaseSelectionResult,
  DatabaseSelectionSource,
} from './databaseSelection';

export { createNotionPage, retrievePage, updatePage, archivePage, queryDatabasePages } from './pages';
export type { NotionPageSummary, NotionPageRecord, NotionPageQueryResult } from './pages';

// Phase 16 — reverse mapping (Notion page → internal task fields).
export { mapNotionPageToTask } from './notionToTask';
export type { NotionPageLike, NotionTaskFields, NotionPageMapResult } from './notionToTask';
