// MAKEEN domain contract — identical copy in api/src/shared and web/src/shared.
// Edit both copies together; CI (contract.yml) fails if they differ. See DECISIONS D-49.

import { z } from 'zod';
import { dailyMisExportSchema, dailyMisQuerySchema } from './daily-mis';
import {
  describeGridFilter,
  GRID_MESSAGES,
  gridFilterIssue,
  gridQueryShape,
  serializeGridFilters,
  serializeGridSort,
  type GridFieldMap,
  type GridFilter,
} from './grid';

const FIELDS: GridFieldMap = {
  name: { kind: 'text' },
  qty: { kind: 'number', scale: 3 },
  count: { kind: 'number', scale: 0 },
  day: { kind: 'date' },
  state: { kind: 'enum', options: ['A', 'B'] },
  note: { kind: 'text', sortable: false },
};
const schema = z.object(gridQueryShape(FIELDS));
const parse = (filters: GridFilter[]) =>
  schema.safeParse({ filters: serializeGridFilters(filters) });

describe('gridFilterIssue', () => {
  it('accepts each kind with a valid value', () => {
    expect(gridFilterIssue({ field: 'name', op: 'contains', value: 'Kol' }, FIELDS)).toBeNull();
    expect(gridFilterIssue({ field: 'qty', op: 'gt', value: '10.125' }, FIELDS)).toBeNull();
    expect(gridFilterIssue({ field: 'qty', op: 'lte', value: '-4' }, FIELDS)).toBeNull();
    expect(
      gridFilterIssue(
        { field: 'day', op: 'between', value: '2026-05-01', value2: '2026-05-31' },
        FIELDS,
      ),
    ).toBeNull();
    expect(gridFilterIssue({ field: 'state', op: 'in', values: ['A'] }, FIELDS)).toBeNull();
    expect(gridFilterIssue({ field: 'qty', op: 'blank' }, FIELDS)).toBeNull();
  });

  it('rejects unknown fields, wrong operators and bad values', () => {
    expect(gridFilterIssue({ field: 'secret', op: 'eq', value: '1' }, FIELDS)).toBe(
      GRID_MESSAGES.unknownField('secret'),
    );
    expect(gridFilterIssue({ field: 'toString', op: 'eq', value: '1' }, FIELDS)).toBe(
      GRID_MESSAGES.unknownField('toString'),
    );
    expect(gridFilterIssue({ field: 'name', op: 'gt', value: 'a' }, FIELDS)).toBe(
      GRID_MESSAGES.badOp('name'),
    );
    expect(gridFilterIssue({ field: 'qty', op: 'gt', value: 'abc' }, FIELDS)).toBe(
      GRID_MESSAGES.badNumber('qty'),
    );
    expect(gridFilterIssue({ field: 'qty', op: 'gt', value: '1.0001' }, FIELDS)).toBe(
      GRID_MESSAGES.badNumber('qty'),
    );
    expect(gridFilterIssue({ field: 'count', op: 'eq', value: '1.5' }, FIELDS)).toBe(
      GRID_MESSAGES.badNumber('count'),
    );
    expect(gridFilterIssue({ field: 'qty', op: 'gt', value: '1e5' }, FIELDS)).toBe(
      GRID_MESSAGES.badNumber('qty'),
    );
    expect(gridFilterIssue({ field: 'day', op: 'eq', value: '2026-02-30' }, FIELDS)).toBe(
      GRID_MESSAGES.badDate('day'),
    );
    expect(gridFilterIssue({ field: 'state', op: 'in', values: ['C'] }, FIELDS)).toBe(
      GRID_MESSAGES.badOption('state'),
    );
    expect(gridFilterIssue({ field: 'name', op: 'contains', value: '  ' }, FIELDS)).toBe(
      GRID_MESSAGES.valueRequired('name'),
    );
  });

  it('checks the order of a between range numerically', () => {
    expect(
      gridFilterIssue({ field: 'qty', op: 'between', value: '9', value2: '10' }, FIELDS),
    ).toBeNull();
    expect(gridFilterIssue({ field: 'qty', op: 'between', value: '10', value2: '9' }, FIELDS)).toBe(
      GRID_MESSAGES.betweenOrder('qty'),
    );
    expect(gridFilterIssue({ field: 'qty', op: 'between', value: '1' }, FIELDS)).toBe(
      GRID_MESSAGES.valueRequired('qty'),
    );
  });
});

describe('describeGridFilter', () => {
  it('reads like a sentence for every operator shape', () => {
    expect(describeGridFilter({ field: 'qty', op: 'gt', value: '100' }, 'Qty')).toBe('Qty > 100');
    expect(describeGridFilter({ field: 'name', op: 'contains', value: 'Kol' }, 'Plant')).toBe(
      'Plant contains Kol',
    );
    expect(describeGridFilter({ field: 'qty', op: 'blank' }, 'Qty')).toBe('Qty is blank');
    expect(
      describeGridFilter({ field: 'qty', op: 'between', value: '1', value2: '5' }, 'Qty'),
    ).toBe('Qty between 1 and 5');
    expect(
      describeGridFilter({ field: 'state', op: 'in', values: ['A', 'B'] }, 'State', (v) =>
        v.toLowerCase(),
      ),
    ).toBe('State: a, b');
  });
});

describe('gridQueryShape', () => {
  it('parses the JSON filters and cleans them', () => {
    const r = parse([
      { field: 'name', op: 'contains', value: ' Kol ', value2: 'x' },
      { field: 'qty', op: 'blank', value: '5' },
      { field: 'state', op: 'in', values: ['A', 'A', 'B'] },
    ]);
    expect(r.success).toBe(true);
    expect(r.data?.filters).toEqual([
      { field: 'name', op: 'contains', value: 'Kol' },
      { field: 'qty', op: 'blank' },
      { field: 'state', op: 'in', values: ['A', 'B'] },
    ]);
  });

  it('treats a missing or empty filter as none', () => {
    expect(schema.parse({}).filters).toEqual([]);
    expect(schema.parse({ filters: '' }).filters).toEqual([]);
    expect(serializeGridFilters([])).toBeUndefined();
  });

  it('rejects broken JSON, wrong shapes and too many filters', () => {
    expect(schema.safeParse({ filters: '{bad' }).success).toBe(false);
    expect(schema.safeParse({ filters: '{"field":"name"}' }).success).toBe(false);
    const many = Array.from({ length: 21 }, () => ({
      field: 'name',
      op: 'contains' as const,
      value: 'a',
    }));
    expect(parse(many).success).toBe(false);
    expect(parse([{ field: 'qty', op: 'gt', value: 'x' }]).success).toBe(false);
  });

  it('parses the sort and refuses columns that cannot be sorted', () => {
    expect(schema.parse({ sort: 'qty:desc' }).sort).toEqual({ field: 'qty', dir: 'desc' });
    expect(schema.parse({ sort: serializeGridSort({ field: 'day', dir: 'asc' }) }).sort).toEqual({
      field: 'day',
      dir: 'asc',
    });
    expect(schema.safeParse({ sort: 'note:asc' }).success).toBe(false);
    expect(schema.safeParse({ sort: 'qty:up' }).success).toBe(false);
    expect(schema.safeParse({ sort: 'nope:asc' }).success).toBe(false);
    expect(serializeGridSort(null)).toBeUndefined();
  });

  it('trims the search and drops an empty one', () => {
    expect(schema.parse({ q: '  Kolkata ' }).q).toBe('Kolkata');
    expect(schema.parse({ q: '   ' }).q).toBeUndefined();
  });
});

describe('Daily MIS grid query', () => {
  it('the list and its download accept the same grid parameters', () => {
    const params = {
      filters: serializeGridFilters([
        { field: 'physicalStock', op: 'gt', value: '100' },
        { field: 'status', op: 'in', values: ['PENDING'] },
      ]),
      q: 'Kol',
      sort: 'accuracyZero:desc',
    };
    const list = dailyMisQuerySchema.parse(params);
    const file = dailyMisExportSchema.parse({ ...params, format: 'xlsx' });
    expect(file.filters).toEqual(list.filters);
    expect(file.sort).toEqual(list.sort);
    expect(file.q).toBe(list.q);
  });

  it('refuses a column the Daily MIS grid does not have', () => {
    const r = dailyMisQuerySchema.safeParse({
      filters: serializeGridFilters([{ field: 'enteredById', op: 'equals', value: 'x' }]),
    });
    expect(r.success).toBe(false);
  });
});
