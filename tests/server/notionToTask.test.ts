import { mapNotionPageToTask } from '../../server/src/services/notion/notionToTask';
import { resolvePropertyMapping } from '../../server/src/services/notion/propertyMapping';
import type { PropertyMapping } from '../../server/src/services/notion/propertyMapping';
import type { NotionDatabaseSchema } from '../../server/src/services/notion/schema';

/**
 * Phase 16 — reverse mapping (Notion page → internal task fields). Pure unit
 * tests: no network, no database.
 */

const schema: NotionDatabaseSchema = {
  id: 'db-1',
  title: 'Tasks',
  properties: [
    { id: 'p-title', name: 'Name', type: 'title' },
    { id: 'p-date', name: 'Due', type: 'date' },
    {
      id: 'p-status',
      name: 'Status',
      type: 'status',
      options: [
        { name: 'Not started' },
        { name: 'In progress' },
        { name: 'Done' },
        { name: 'Blocked' },
        { name: 'Cancelled' },
      ],
    },
    {
      id: 'p-priority',
      name: 'Priority',
      type: 'select',
      options: [{ name: 'Low' }, { name: 'Medium' }, { name: 'High' }],
    },
    { id: 'p-category', name: 'Category', type: 'select', options: [{ name: 'Work' }] },
    { id: 'p-notes', name: 'Notes', type: 'rich_text' },
    { id: 'p-url', name: 'Link', type: 'url' },
  ],
};

const mapping = resolvePropertyMapping(schema);

describe('mapNotionPageToTask', () => {
  it('reverse-maps title, date, status, priority, category, description and url', () => {
    const { fields, warnings } = mapNotionPageToTask(schema, mapping, {
      properties: {
        Name: { title: [{ plain_text: 'Write report' }] },
        Due: { date: { start: '2026-12-05T17:00:00.000Z', time_zone: 'America/New_York' } },
        Status: { status: { name: 'In progress' } },
        Priority: { select: { name: 'High' } },
        Category: { select: { name: 'Work' } },
        Notes: { rich_text: [{ plain_text: 'Need the Q4 numbers ' }, { plain_text: 'first.' }] },
        Link: { url: 'https://example.com/task' },
      },
    });

    expect(warnings).toEqual([]);
    expect(fields).toEqual({
      title: 'Write report',
      description: 'Need the Q4 numbers first.',
      category: 'Work',
      priority: 'high',
      status: 'in_progress',
      due_date: '2026-12-05',
      due_time: '17:00',
      timezone: 'America/New_York',
      notion_url: 'https://example.com/task',
    });
  });

  it('parses a date-only value without a time or timezone', () => {
    const { fields } = mapNotionPageToTask(schema, mapping, {
      properties: {
        Name: { title: [{ plain_text: 'Buy milk' }] },
        Due: { date: { start: '2026-12-05' } },
      },
    });

    expect(fields.due_date).toBe('2026-12-05');
    expect(fields.due_time).toBeNull();
    expect(fields.timezone).toBeNull();
  });

  it('handles missing / null properties gracefully without throwing', () => {
    const { fields, warnings } = mapNotionPageToTask(schema, mapping, {
      properties: {
        Name: { title: [] },
        Notes: { rich_text: [] },
      },
      url: 'https://www.notion.so/page-1',
    });

    expect(fields.title).toBeUndefined();
    expect(fields.description).toBeNull();
    expect(fields.status).toBeUndefined();
    expect(fields.priority).toBeUndefined();
    expect(fields.category).toBeUndefined();
    expect(fields.due_date).toBeUndefined();
    // Falls back to the page's public URL when no `url` property is mapped.
    expect(fields.notion_url).toBe('https://www.notion.so/page-1');
    expect(warnings).toContain('Notion page Name has no title.');
  });

  it('falls back to not_started for an unknown status option and records a warning', () => {
    const { fields, warnings } = mapNotionPageToTask(schema, mapping, {
      properties: {
        Name: { title: [{ plain_text: 'Mystery' }] },
        Status: { status: { name: 'Frobnicated' } },
      },
    });

    expect(fields.status).toBe('not_started');
    expect(warnings.some((warning) => /Frobnicated/.test(warning))).toBe(true);
  });

  it('ignores an unknown priority option and records a warning', () => {
    const { fields, warnings } = mapNotionPageToTask(schema, mapping, {
      properties: {
        Name: { title: [{ plain_text: 'Test' }] },
        Priority: { select: { name: 'Urgent' } },
      },
    });

    expect(fields.priority).toBeNull();
    expect(warnings.some((warning) => /Urgent/.test(warning))).toBe(true);
  });

  it('accepts common status synonyms (Done → completed)', () => {
    const { fields } = mapNotionPageToTask(schema, mapping, {
      properties: {
        Name: { title: [{ plain_text: 'Ship it' }] },
        Status: { status: { name: 'Done' } },
      },
    });

    expect(fields.status).toBe('completed');
  });

  it('reads the first option of a multi_select category', () => {
    const multiSchema: NotionDatabaseSchema = {
      id: 'db-2',
      title: 'Tasks',
      properties: [
        { id: 't', name: 'Name', type: 'title' },
        { id: 'c', name: 'Category', type: 'multi_select', options: [{ name: 'Home' }] },
      ],
    };
    const multiMapping = resolvePropertyMapping(multiSchema);

    const { fields } = mapNotionPageToTask(multiSchema, multiMapping, {
      properties: {
        Name: { title: [{ plain_text: 'Chores' }] },
        Category: { multi_select: [{ name: 'Home' }, { name: 'Errands' }] },
      },
    });

    expect(fields.category).toBe('Home');
  });

  it('treats a checkbox-backed status as completed/not_started', () => {
    const checkboxSchema: NotionDatabaseSchema = {
      id: 'db-3',
      title: 'Tasks',
      properties: [
        { id: 't', name: 'Name', type: 'title' },
        { id: 's', name: 'Done?', type: 'checkbox' },
      ],
    };
    // Hand-built mapping so the resolved metadata is absent and the mapper
    // exercises its schema-lookup fallback.
    const checkboxMapping: PropertyMapping = { title: 'Name', status: 'Done?', unsupported: [] };

    expect(
      mapNotionPageToTask(checkboxSchema, checkboxMapping, {
        properties: { Name: { title: [{ plain_text: 'A' }] }, 'Done?': { checkbox: true } },
      }).fields.status
    ).toBe('completed');

    expect(
      mapNotionPageToTask(checkboxSchema, checkboxMapping, {
        properties: { Name: { title: [{ plain_text: 'B' }] }, 'Done?': { checkbox: false } },
      }).fields.status
    ).toBe('not_started');
  });
});
