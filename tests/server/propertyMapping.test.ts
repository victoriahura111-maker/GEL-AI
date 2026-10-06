import {
  buildNotionProperties,
  buildNotionPropertyValue,
  PropertyMappingError,
  resolvePropertyMapping,
} from '../../server/src/services/notion/propertyMapping';
import type {
  NotionDatabaseSchema,
  NotionPropertyOption,
  NotionPropertySchema,
} from '../../server/src/services/notion/schema';

function prop(name: string, type: string, options?: NotionPropertyOption[]): NotionPropertySchema {
  return options ? { id: `${name}-id`, name, type, options } : { id: `${name}-id`, name, type };
}

function schema(properties: NotionPropertySchema[]): NotionDatabaseSchema {
  return { id: 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6', title: 'Test DB', properties };
}

/** A realistic full-featured task database. */
function fullSchema(): NotionDatabaseSchema {
  return schema([
    prop('Name', 'title'),
    prop('Notes', 'rich_text'),
    prop('Due Date', 'date'),
    prop('Status', 'status', [
      { name: 'Not started' },
      { name: 'In progress' },
      { name: 'Done' },
      { name: 'Blocked' },
    ]),
    prop('Priority', 'select', [{ name: 'Low' }, { name: 'Medium' }, { name: 'High' }]),
    prop('Tags', 'multi_select', [{ name: 'Home' }, { name: 'Work' }]),
    prop('Link', 'url'),
    prop('Owner', 'people'),
    prop('Formula', 'formula'),
  ]);
}

describe('resolvePropertyMapping — heuristics', () => {
  it('maps every supported field on a full-featured database', () => {
    const mapping = resolvePropertyMapping(fullSchema());

    expect(mapping).toEqual({
      title: 'Name',
      date: 'Due Date',
      status: 'Status',
      priority: 'Priority',
      category: 'Tags',
      description: 'Notes',
      url: 'Link',
      people: 'Owner',
      unsupported: [{ name: 'Formula', type: 'formula' }],
    });
  });

  it('maps a minimal title-only database and leaves optional fields undefined', () => {
    const mapping = resolvePropertyMapping(schema([prop('Name', 'title')]));

    expect(mapping).toEqual({ title: 'Name', unsupported: [] });
    expect(mapping.date).toBeUndefined();
    expect(mapping.status).toBeUndefined();
    expect(mapping.priority).toBeUndefined();
    expect(mapping.category).toBeUndefined();
    expect(mapping.description).toBeUndefined();
  });

  it('is deterministic regardless of property order', () => {
    const reordered = schema([
      prop('Formula', 'formula'),
      prop('Owner', 'people'),
      prop('Link', 'url'),
      prop('Tags', 'multi_select', [{ name: 'Home' }]),
      prop('Priority', 'select', [{ name: 'High' }]),
      prop('Status', 'status', [{ name: 'Done' }]),
      prop('Due Date', 'date'),
      prop('Notes', 'rich_text'),
      prop('Name', 'title'),
    ]);

    expect(resolvePropertyMapping(reordered)).toEqual(resolvePropertyMapping(fullSchema()));
  });

  it('never assigns the same property to two internal fields', () => {
    const mapping = resolvePropertyMapping(
      schema([
        prop('Task', 'title'),
        prop('Status', 'select', [{ name: 'Todo' }, { name: 'Done' }]),
        prop('Priority', 'select', [{ name: 'Low' }, { name: 'High' }]),
        prop('Labels', 'multi_select', [{ name: 'Home' }]),
      ])
    );

    expect(mapping.status).toBe('Status');
    expect(mapping.priority).toBe('Priority');
    expect(mapping.category).toBe('Labels');
    expect(new Set([mapping.status, mapping.priority, mapping.category]).size).toBe(3);
  });

  it('does not let a single select satisfy both status and category', () => {
    const mapping = resolvePropertyMapping(
      schema([prop('Name', 'title'), prop('Status', 'select', [{ name: 'Todo' }])])
    );

    expect(mapping.status).toBe('Status');
    expect(mapping.category).toBeUndefined();
  });

  it('prefers a keyword date property over the first date property', () => {
    const mapping = resolvePropertyMapping(
      schema([
        prop('Name', 'title'),
        prop('Created', 'date'),
        prop('Deadline', 'date'),
        prop('Due Date', 'date'),
      ])
    );

    expect(mapping.date).toBe('Due Date');
  });

  it('falls back to the first date property when no keyword matches', () => {
    const mapping = resolvePropertyMapping(
      schema([prop('Name', 'title'), prop('Opened', 'date'), prop('Closed', 'date')])
    );

    expect(mapping.date).toBe('Opened');
  });

  it('uses a select named State when no native status property exists', () => {
    const mapping = resolvePropertyMapping(
      schema([prop('Name', 'title'), prop('State', 'select', [{ name: 'Todo' }])])
    );

    expect(mapping.status).toBe('State');
  });

  it('prefers a keyword description rich_text, else the first rich_text', () => {
    expect(
      resolvePropertyMapping(
        schema([prop('Name', 'title'), prop('Misc', 'rich_text'), prop('Details', 'rich_text')])
      ).description
    ).toBe('Details');

    expect(
      resolvePropertyMapping(schema([prop('Name', 'title'), prop('Random Text', 'rich_text')]))
        .description
    ).toBe('Random Text');
  });

  it('collects unsupported property types without failing', () => {
    const mapping = resolvePropertyMapping(
      schema([prop('Name', 'title'), prop('Rollup', 'rollup'), prop('Relation', 'relation')])
    );

    expect(mapping.unsupported).toEqual([
      { name: 'Rollup', type: 'rollup' },
      { name: 'Relation', type: 'relation' },
    ]);
  });

  it('throws a typed error when the database has no title property', () => {
    let caught: unknown;
    try {
      resolvePropertyMapping(schema([prop('Notes', 'rich_text')]));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PropertyMappingError);
    expect((caught as PropertyMappingError).code).toBe('missing_title');
  });
});

describe('buildNotionProperties — payload shapes', () => {
  it('builds a payload for every mapped field', () => {
    const mapping = resolvePropertyMapping(fullSchema());

    const payload = buildNotionProperties(mapping, {
      title: 'Write report',
      description: 'Draft it',
      category: 'home',
      priority: 'high',
      status: 'in_progress',
      due_date: '2026-10-10',
      due_time: '09:30',
      timezone: 'Africa/Lagos',
      notion_url: 'https://www.notion.so/page',
    });

    expect(payload).toEqual({
      Name: { title: [{ text: { content: 'Write report' } }] },
      Notes: { rich_text: [{ text: { content: 'Draft it' } }] },
      Link: { url: 'https://www.notion.so/page' },
      'Due Date': { date: { start: '2026-10-10T09:30:00', time_zone: 'Africa/Lagos' } },
      Status: { status: { name: 'In progress' } },
      Priority: { select: { name: 'High' } },
      Tags: { multi_select: [{ name: 'Home' }] },
    });
  });

  it('maps internal status values to friendly option names (completed → Done)', () => {
    const mapping = resolvePropertyMapping(fullSchema());
    const payload = buildNotionProperties(mapping, { title: 'T', status: 'completed' });

    expect(payload.Status).toEqual({ status: { name: 'Done' } });
  });

  it('omits a status-type value when no matching option exists (status options are fixed)', () => {
    const mapping = resolvePropertyMapping(
      schema([prop('Name', 'title'), prop('Status', 'status', [{ name: 'Todo' }])])
    );

    const payload = buildNotionProperties(mapping, { title: 'T', status: 'completed' });

    expect(payload.Status).toBeUndefined();
    expect(payload).toEqual({ Name: { title: [{ text: { content: 'T' } }] } });
  });

  it('matches select options case-insensitively', () => {
    const mapping = resolvePropertyMapping(
      schema([
        prop('Name', 'title'),
        prop('Priority', 'select', [{ name: 'LOW' }, { name: 'Medium' }, { name: 'High' }]),
      ])
    );

    const payload = buildNotionProperties(mapping, { title: 'T', priority: 'low' });

    expect(payload.Priority).toEqual({ select: { name: 'LOW' } });
  });

  it('passes a non-status select value through so Notion can create the option', () => {
    const mapping = resolvePropertyMapping(
      schema([prop('Name', 'title'), prop('Priority', 'select', [{ name: 'Urgent' }])])
    );

    const payload = buildNotionProperties(mapping, { title: 'T', priority: 'high' });

    expect(payload.Priority).toEqual({ select: { name: 'High' } });
  });

  it('builds a date without a time_zone when only a date is present', () => {
    const mapping = resolvePropertyMapping(fullSchema());
    const payload = buildNotionProperties(mapping, { title: 'T', due_date: '2026-10-10' });

    expect(payload['Due Date']).toEqual({ date: { start: '2026-10-10' } });
  });

  it('omits fields whose value is missing or undefined', () => {
    const mapping = resolvePropertyMapping(fullSchema());
    const payload = buildNotionProperties(mapping, {});

    expect(payload).toEqual({});
  });

  it('omits fields whose Notion property is absent from the mapping', () => {
    const mapping = resolvePropertyMapping(schema([prop('Name', 'title')]));
    const payload = buildNotionProperties(mapping, {
      title: 'T',
      status: 'in_progress',
      priority: 'high',
      category: 'home',
      due_date: '2026-10-10',
    });

    expect(payload).toEqual({ Name: { title: [{ text: { content: 'T' } }] } });
  });
});

describe('buildNotionPropertyValue — per-type shapes', () => {
  it('builds title, rich_text, url, checkbox and number values', () => {
    expect(buildNotionPropertyValue('title', 'Hi')).toEqual({
      title: [{ text: { content: 'Hi' } }],
    });
    expect(buildNotionPropertyValue('rich_text', 'Body')).toEqual({
      rich_text: [{ text: { content: 'Body' } }],
    });
    expect(buildNotionPropertyValue('url', 'https://x')).toEqual({ url: 'https://x' });
    expect(buildNotionPropertyValue('checkbox', true)).toEqual({ checkbox: true });
    expect(buildNotionPropertyValue('checkbox', false)).toEqual({ checkbox: false });
    expect(buildNotionPropertyValue('number', '42')).toEqual({ number: 42 });
  });

  it('returns undefined for unrepresentable values', () => {
    expect(buildNotionPropertyValue('number', 'abc')).toBeUndefined();
    expect(buildNotionPropertyValue('title', null)).toBeUndefined();
    expect(buildNotionPropertyValue('checkbox', undefined)).toBeUndefined();
    expect(buildNotionPropertyValue('status', 'Done', [{ name: 'Todo' }])).toBeUndefined();
  });

  it('uses the existing option name for a case-insensitive select match', () => {
    expect(buildNotionPropertyValue('select', 'done', [{ name: 'Done' }])).toEqual({
      select: { name: 'Done' },
    });
    expect(buildNotionPropertyValue('multi_select', 'home', [{ name: 'Home' }])).toEqual({
      multi_select: [{ name: 'Home' }],
    });
  });
});
