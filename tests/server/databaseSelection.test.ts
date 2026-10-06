import {
  selectDatabase,
  categoryToPurpose,
} from '../../server/src/services/notion/databaseSelection';
import { listMappings } from '../../server/src/services/notion/databaseMappingRepository';
import type { NotionDatabaseMapping } from '../../server/src/services/notion/databaseMappingRepository';

// The selection service is pure decision logic on top of the mapping
// repository; mocking the repository keeps the tests offline and deterministic
// (no Supabase, no Notion).
jest.mock('../../server/src/services/notion/databaseMappingRepository', () => ({
  listMappings: jest.fn(),
}));

const mockListMappings = listMappings as jest.MockedFunction<typeof listMappings>;

/** Builds a mapping row with sensible defaults; override what a test cares about. */
function mapping(overrides: Partial<NotionDatabaseMapping> = {}): NotionDatabaseMapping {
  return {
    notionDatabaseId: 'db-1',
    databaseTitle: 'Work Tasks',
    purpose: 'work',
    isDefault: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('categoryToPurpose', () => {
  it('normalises free-form categories to a purpose (case-insensitive)', () => {
    expect(categoryToPurpose('Work')).toBe('work');
    expect(categoryToPurpose('  School assignment ')).toBe('school');
    expect(categoryToPurpose('side project')).toBe('projects');
    expect(categoryToPurpose('personal errands')).toBe('personal');
    expect(categoryToPurpose('misc')).toBe('other');
  });

  it('returns null for blank or unmatched categories', () => {
    expect(categoryToPurpose(null)).toBeNull();
    expect(categoryToPurpose(undefined)).toBeNull();
    expect(categoryToPurpose('   ')).toBeNull();
    expect(categoryToPurpose('zzz-unknown')).toBeNull();
  });
});

describe('selectDatabase', () => {
  it('returns no_databases (never throws) when the user has mapped nothing', async () => {
    mockListMappings.mockResolvedValue([]);

    const result = await selectDatabase('user-1');

    expect(result).toEqual({ status: 'no_databases', candidates: [] });
    expect(mockListMappings).toHaveBeenCalledWith('user-1');
  });

  it('selects by purpose when the category maps to a purpose', async () => {
    mockListMappings.mockResolvedValue([
      mapping({ notionDatabaseId: 'db-school', databaseTitle: 'School', purpose: 'school' }),
      mapping({ notionDatabaseId: 'db-work', databaseTitle: 'Work Tasks', purpose: 'work' }),
    ]);

    const result = await selectDatabase('user-1', 'work stuff');

    expect(result).toEqual({
      status: 'selected',
      databaseId: 'db-work',
      title: 'Work Tasks',
      purpose: 'work',
      source: 'purpose',
    });
  });

  it('prefers the default mapping within a matching purpose', async () => {
    mockListMappings.mockResolvedValue([
      mapping({
        notionDatabaseId: 'db-work-default',
        databaseTitle: 'Work',
        purpose: 'work',
        isDefault: true,
      }),
      mapping({ notionDatabaseId: 'db-work-older', databaseTitle: 'Old Work', purpose: 'work' }),
    ]);

    const result = await selectDatabase('user-1', 'work');

    expect(result).toMatchObject({
      status: 'selected',
      databaseId: 'db-work-default',
      source: 'purpose',
    });
  });

  it('falls back to the default mapping when the category does not match', async () => {
    mockListMappings.mockResolvedValue([
      mapping({
        notionDatabaseId: 'db-default',
        databaseTitle: 'Inbox',
        purpose: 'other',
        isDefault: true,
      }),
      mapping({ notionDatabaseId: 'db-work', databaseTitle: 'Work Tasks', purpose: 'work' }),
    ]);

    const result = await selectDatabase('user-1', 'zzz');

    expect(result).toMatchObject({
      status: 'selected',
      databaseId: 'db-default',
      source: 'default',
    });
  });

  it('falls back to the single mapping when there is no default', async () => {
    mockListMappings.mockResolvedValue([
      mapping({ notionDatabaseId: 'db-only', databaseTitle: 'Only', purpose: 'other' }),
    ]);

    const result = await selectDatabase('user-1');

    expect(result).toMatchObject({ status: 'selected', databaseId: 'db-only', source: 'single' });
  });

  it('returns needs_choice with every mapping as a candidate when ambiguous', async () => {
    mockListMappings.mockResolvedValue([
      mapping({ notionDatabaseId: 'db-a', databaseTitle: 'A', purpose: 'work' }),
      mapping({ notionDatabaseId: 'db-b', databaseTitle: 'B', purpose: 'personal', isDefault: false }),
    ]);

    const result = await selectDatabase('user-1', 'zzz');

    expect(result.status).toBe('needs_choice');
    if (result.status === 'needs_choice') {
      expect(result.candidates).toEqual([
        { databaseId: 'db-a', title: 'A', purpose: 'work', isDefault: false },
        { databaseId: 'db-b', title: 'B', purpose: 'personal', isDefault: false },
      ]);
    }
  });

  it('falls back to "Untitled" when a mapping has no stored title', async () => {
    mockListMappings.mockResolvedValue([
      mapping({ notionDatabaseId: 'db-a', databaseTitle: null, purpose: 'work' }),
    ]);

    const result = await selectDatabase('user-1');

    expect(result).toMatchObject({ status: 'selected', databaseId: 'db-a', title: 'Untitled' });
  });
});
