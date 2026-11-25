import { Prisma } from '../../generated/prisma/client';
import { istStartOfDay, type GridFieldMap } from '../../shared';
import {
  compareNullableDecimal,
  gridNumberMatches,
  gridOrderBy,
  gridWhere,
  type GridColumnMap,
} from './prisma-grid';

const FIELDS: GridFieldMap = {
  plant: { kind: 'text' },
  code: { kind: 'text' },
  qty: { kind: 'number', scale: 3 },
  count: { kind: 'number', scale: 0 },
  day: { kind: 'date' },
  at: { kind: 'date', instant: true },
  status: { kind: 'enum', options: ['A', 'B'] },
  derived: { kind: 'number', scale: 3 },
};
const COLUMNS: GridColumnMap = {
  plant: { path: ['plant', 'name'] },
  code: { path: ['code'], nullable: true },
  qty: { path: ['qty'], nullable: true },
  count: { path: ['count'], nullable: true },
  day: { path: ['day'] },
  at: { path: ['at'] },
  status: { path: ['status'] },
};

describe('gridWhere', () => {
  it('maps text filters to case-insensitive conditions on the nested path', () => {
    expect(gridWhere([{ field: 'plant', op: 'contains', value: 'Kol' }], FIELDS, COLUMNS)).toEqual([
      { plant: { name: { contains: 'Kol', mode: 'insensitive' } } },
    ]);
    expect(gridWhere([{ field: 'code', op: 'blank' }], FIELDS, COLUMNS)).toEqual([
      { OR: [{ code: null }, { code: { equals: '' } }] },
    ]);
  });

  it('uses Decimal for decimals and whole numbers for counts', () => {
    const [qty, count, between] = gridWhere(
      [
        { field: 'qty', op: 'gt', value: '100.5' },
        { field: 'count', op: 'lte', value: '7' },
        { field: 'qty', op: 'between', value: '1', value2: '2.25' },
      ],
      FIELDS,
      COLUMNS,
    );
    const gt = (qty as { qty: { gt: unknown } }).qty.gt;
    expect(gt).toBeInstanceOf(Prisma.Decimal);
    expect(String(gt)).toBe('100.5');
    expect(count).toEqual({ count: { lte: 7 } });
    const range = (between as { qty: { gte: Prisma.Decimal; lte: Prisma.Decimal } }).qty;
    expect([range.gte.toString(), range.lte.toString()]).toEqual(['1', '2.25']);
    expect(gridWhere([{ field: 'qty', op: 'notBlank' }], FIELDS, COLUMNS)).toEqual([
      { qty: { not: null } },
    ]);
  });

  it('compares business dates as calendar days and instants as IST days', () => {
    expect(gridWhere([{ field: 'day', op: 'eq', value: '2026-05-04' }], FIELDS, COLUMNS)).toEqual([
      { day: { equals: new Date('2026-05-04T00:00:00.000Z') } },
    ]);
    expect(gridWhere([{ field: 'at', op: 'eq', value: '2026-05-04' }], FIELDS, COLUMNS)).toEqual([
      { at: { gte: istStartOfDay('2026-05-04'), lt: istStartOfDay('2026-05-05') } },
    ]);
    expect(gridWhere([{ field: 'at', op: 'after', value: '2026-05-04' }], FIELDS, COLUMNS)).toEqual(
      [{ at: { gte: istStartOfDay('2026-05-05') } }],
    );
  });

  it('maps enums to IN and skips fields with no SQL column', () => {
    expect(
      gridWhere(
        [
          { field: 'status', op: 'in', values: ['A', 'B'] },
          { field: 'derived', op: 'gt', value: '1' },
          { field: 'unknown', op: 'eq', value: '1' },
        ],
        FIELDS,
        COLUMNS,
      ),
    ).toEqual([{ status: { in: ['A', 'B'] } }]);
  });
});

describe('gridOrderBy', () => {
  const DEFAULT = [{ day: 'desc' }];
  it('puts the chosen sort before the default order', () => {
    expect(gridOrderBy(undefined, COLUMNS, DEFAULT)).toEqual(DEFAULT);
    expect(gridOrderBy({ field: 'plant', dir: 'asc' }, COLUMNS, DEFAULT)).toEqual([
      { plant: { name: 'asc' } },
      { day: 'desc' },
    ]);
    expect(gridOrderBy({ field: 'qty', dir: 'desc' }, COLUMNS, DEFAULT)).toEqual([
      { qty: { sort: 'desc', nulls: 'last' } },
      { day: 'desc' },
    ]);
  });

  it('returns null for a derived field', () => {
    expect(gridOrderBy({ field: 'derived', dir: 'asc' }, COLUMNS, DEFAULT)).toBeNull();
  });
});

describe('in-memory number filter and sort', () => {
  it('matches exactly at the column scale', () => {
    expect(gridNumberMatches('100.001', { field: 'd', op: 'gt', value: '100' }, 3)).toBe(true);
    expect(gridNumberMatches('100.000', { field: 'd', op: 'gt', value: '100' }, 3)).toBe(false);
    expect(gridNumberMatches('5', { field: 'd', op: 'between', value: '5', value2: '6' }, 3)).toBe(
      true,
    );
    expect(gridNumberMatches(null, { field: 'd', op: 'lt', value: '1' }, 3)).toBe(false);
    expect(gridNumberMatches(null, { field: 'd', op: 'blank' }, 3)).toBe(true);
    expect(gridNumberMatches('0.000', { field: 'd', op: 'ne', value: '0' }, 3)).toBe(false);
  });

  it('sorts numerically with blanks last in both directions', () => {
    const values = ['10.000', null, '9.500', '-1.000'];
    expect([...values].sort((a, b) => compareNullableDecimal(a, b, 3, 'asc'))).toEqual([
      '-1.000',
      '9.500',
      '10.000',
      null,
    ]);
    expect([...values].sort((a, b) => compareNullableDecimal(a, b, 3, 'desc'))).toEqual([
      '10.000',
      '9.500',
      '-1.000',
      null,
    ]);
  });
});
