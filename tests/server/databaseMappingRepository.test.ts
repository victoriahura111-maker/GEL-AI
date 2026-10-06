import {
  deleteMapping,
  getMappingsByPurpose,
  listMappings,
  setDefault,
  upsertMapping,
} from '../../server/src/services/notion/databaseMappingRepository';
import { supabaseAdmin } from '../../server/src/services/supabase';
import type { FakeRow, FakeSupabaseClient } from './supabaseFake';

jest.mock('@supabase/supabase-js', () => {
  const fake = jest.requireActual<typeof import('./supabaseFake')>('./supabaseFake');
  return { createClient: jest.fn(() => fake.createSupabaseFake()) };
});

const fake = supabaseAdmin as unknown as FakeSupabaseClient;

const DB_A = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6';
const DB_B = 'b1c2d3e4-f5a6-b7c8-d9e0-f1a2b3c4d5e6';

function rows(): FakeRow[] {
  return fake.__store.notion_database_mappings ?? [];
}

beforeEach(() => {
  for (const key of Object.keys(fake.__store)) {
    fake.__store[key].length = 0;
  }
  fake.__queries.length = 0;
});

describe('databaseMappingRepository', () => {
  it('upserts and lists mappings scoped to the user', async () => {
    await upsertMapping('user-1', {
      notionDatabaseId: DB_A,
      databaseTitle: 'Work Tasks',
      purpose: 'work',
    });
    await upsertMapping('user-2', {
      notionDatabaseId: DB_B,
      databaseTitle: 'Other',
      purpose: 'personal',
    });

    const mappings = await listMappings('user-1');

    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toEqual({
      notionDatabaseId: DB_A,
      databaseTitle: 'Work Tasks',
      purpose: 'work',
      isDefault: false,
    });
  });

  it('updates an existing mapping instead of creating a duplicate', async () => {
    await upsertMapping('user-1', { notionDatabaseId: DB_A, purpose: 'work' });
    await upsertMapping('user-1', { notionDatabaseId: DB_A, purpose: 'school' });

    expect(rows()).toHaveLength(1);
    const mappings = await listMappings('user-1');
    expect(mappings[0].purpose).toBe('school');
  });

  it('keeps at most one default when isDefault is set during upsert', async () => {
    await upsertMapping('user-1', { notionDatabaseId: DB_A, purpose: 'work', isDefault: true });
    await upsertMapping('user-1', { notionDatabaseId: DB_B, purpose: 'personal', isDefault: true });

    const mappings = await listMappings('user-1');
    const defaults = mappings.filter((mapping) => mapping.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].notionDatabaseId).toBe(DB_B);
  });

  it('setDefault clears the previous default and sets the target', async () => {
    await upsertMapping('user-1', { notionDatabaseId: DB_A, purpose: 'work', isDefault: true });
    await upsertMapping('user-1', { notionDatabaseId: DB_B, purpose: 'personal' });

    const updated = await setDefault('user-1', DB_B);

    expect(updated?.isDefault).toBe(true);
    const mappings = await listMappings('user-1');
    expect(mappings.find((mapping) => mapping.notionDatabaseId === DB_A)?.isDefault).toBe(false);
    expect(mappings.find((mapping) => mapping.notionDatabaseId === DB_B)?.isDefault).toBe(true);
  });

  it('setDefault returns null (and does not clobber) when the caller has no mapping', async () => {
    await upsertMapping('user-1', { notionDatabaseId: DB_A, purpose: 'work', isDefault: true });

    const updated = await setDefault('user-1', DB_B);

    expect(updated).toBeNull();
    const mappings = await listMappings('user-1');
    expect(mappings.find((mapping) => mapping.notionDatabaseId === DB_A)?.isDefault).toBe(true);
  });

  it('filters mappings by purpose', async () => {
    await upsertMapping('user-1', { notionDatabaseId: DB_A, purpose: 'work' });
    await upsertMapping('user-1', { notionDatabaseId: DB_B, purpose: 'personal' });

    const work = await getMappingsByPurpose('user-1', 'work');

    expect(work).toHaveLength(1);
    expect(work[0].notionDatabaseId).toBe(DB_A);
    expect(await getMappingsByPurpose('user-1', 'school')).toEqual([]);
  });

  it('deletes only the caller-owned mapping', async () => {
    await upsertMapping('user-1', { notionDatabaseId: DB_A, purpose: 'work' });
    await upsertMapping('user-2', { notionDatabaseId: DB_A, purpose: 'work' });

    expect(await deleteMapping('user-1', DB_A)).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].user_id).toBe('user-2');

    expect(await deleteMapping('user-1', DB_A)).toBe(false);
  });
});
