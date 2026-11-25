import { Prisma } from '../../generated/prisma/client';
import {
  addDays,
  istStartOfDay,
  toScaled,
  type GridFieldMap,
  type GridFilter,
  type GridSort,
} from '../../shared';

/**
 * Turns the shared grid query (`shared/schemas/grid.ts`, already validated by Zod) into Prisma
 * `where` / `orderBy` fragments. Each module maps its grid fields to a Prisma path; values arrive
 * as checked strings and become Decimal / Int / Date here — never JS floats (CLAUDE.md).
 */

export interface GridColumn {
  /** Prisma path, e.g. `['plant', 'name']`. */
  path: readonly string[];
  /** The column allows NULL (enables blank / not blank and NULLS LAST sorting). */
  nullable?: boolean;
}

/** Columns a module can filter in SQL. Derived columns are left out and handled by the module. */
export type GridColumnMap = Readonly<Record<string, GridColumn>>;

type Where = Record<string, unknown>;

/** `['plant','name']` + cond → `{ plant: { name: cond } }`. */
function nest(path: readonly string[], cond: unknown): Where {
  let out: unknown = cond;
  for (let i = path.length - 1; i >= 0; i -= 1) out = { [path[i] ?? '']: out };
  return out as Where;
}

function numberValue(v: string, scale: number): Prisma.Decimal | number {
  return scale === 0 ? Number.parseInt(v, 10) : new Prisma.Decimal(v);
}

function textCond(f: GridFilter, col: GridColumn): Where {
  const v = f.value ?? '';
  switch (f.op) {
    case 'contains':
      return nest(col.path, { contains: v, mode: 'insensitive' });
    case 'equals':
      return nest(col.path, { equals: v, mode: 'insensitive' });
    case 'startsWith':
      return nest(col.path, { startsWith: v, mode: 'insensitive' });
    case 'blank':
      return col.nullable
        ? { OR: [nest(col.path, null), nest(col.path, { equals: '' })] }
        : nest(col.path, { equals: '' });
    default:
      return col.nullable
        ? { AND: [nest(col.path, { not: null }), nest(col.path, { not: '' })] }
        : nest(col.path, { not: '' });
  }
}

function numberCond(f: GridFilter, col: GridColumn, scale: number): Where {
  if (f.op === 'blank') return nest(col.path, null);
  if (f.op === 'notBlank') return nest(col.path, { not: null });
  const v = numberValue(f.value ?? '0', scale);
  switch (f.op) {
    case 'eq':
      return nest(col.path, { equals: v });
    case 'ne':
      return nest(col.path, { not: v });
    case 'gt':
      return nest(col.path, { gt: v });
    case 'gte':
      return nest(col.path, { gte: v });
    case 'lt':
      return nest(col.path, { lt: v });
    case 'lte':
      return nest(col.path, { lte: v });
    default:
      return nest(col.path, { gte: v, lte: numberValue(f.value2 ?? '0', scale) });
  }
}

const calendarDay = (v: string): Date => new Date(`${v}T00:00:00.000Z`);

function dateCond(f: GridFilter, col: GridColumn, instant: boolean): Where {
  const v = f.value ?? '';
  if (instant) {
    // An instant matches the IST calendar day it falls on.
    const start = (d: string): Date => istStartOfDay(d);
    switch (f.op) {
      case 'eq':
        return nest(col.path, { gte: start(v), lt: start(addDays(v, 1)) });
      case 'before':
        return nest(col.path, { lt: start(v) });
      case 'after':
        return nest(col.path, { gte: start(addDays(v, 1)) });
      default:
        return nest(col.path, { gte: start(v), lt: start(addDays(f.value2 ?? v, 1)) });
    }
  }
  switch (f.op) {
    case 'eq':
      return nest(col.path, { equals: calendarDay(v) });
    case 'before':
      return nest(col.path, { lt: calendarDay(v) });
    case 'after':
      return nest(col.path, { gt: calendarDay(v) });
    default:
      return nest(col.path, { gte: calendarDay(v), lte: calendarDay(f.value2 ?? v) });
  }
}

/**
 * One AND-ed list of conditions for the filters whose field is in `columns`. Filters on fields
 * outside `columns` (derived values) are skipped — the caller applies those itself.
 */
export function gridWhere(
  filters: readonly GridFilter[],
  fields: GridFieldMap,
  columns: GridColumnMap,
): Where[] {
  const out: Where[] = [];
  for (const f of filters) {
    const def = Object.hasOwn(fields, f.field) ? fields[f.field] : undefined;
    const col = Object.hasOwn(columns, f.field) ? columns[f.field] : undefined;
    if (!def || !col) continue;
    switch (def.kind) {
      case 'text':
        out.push(textCond(f, col));
        break;
      case 'number':
        out.push(numberCond(f, col, def.scale ?? 0));
        break;
      case 'date':
        out.push(dateCond(f, col, def.instant === true));
        break;
      case 'enum':
        out.push(nest(col.path, { in: f.values ?? [] }));
        break;
    }
  }
  return out;
}

/**
 * The same number test in memory, for a value the module derives (e.g. a sum of two columns).
 * Exact: both sides are scaled BigInts.
 */
export function gridNumberMatches(value: string | null, f: GridFilter, scale: number): boolean {
  if (f.op === 'blank') return value === null;
  if (f.op === 'notBlank') return value !== null;
  if (value === null) return false;
  const x = toScaled(value, scale) ?? 0n;
  const a = toScaled(f.value ?? '0', scale) ?? 0n;
  switch (f.op) {
    case 'eq':
      return x === a;
    case 'ne':
      return x !== a;
    case 'gt':
      return x > a;
    case 'gte':
      return x >= a;
    case 'lt':
      return x < a;
    case 'lte':
      return x <= a;
    case 'between':
      return x >= a && x <= (toScaled(f.value2 ?? '0', scale) ?? 0n);
    default:
      return false;
  }
}

/** Compare two nullable decimal strings for a sort; blanks always last. */
export function compareNullableDecimal(
  a: string | null,
  b: string | null,
  scale: number,
  dir: 'asc' | 'desc',
): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const x = toScaled(a, scale) ?? 0n;
  const y = toScaled(b, scale) ?? 0n;
  const c = x < y ? -1 : x > y ? 1 : 0;
  return dir === 'asc' ? c : -c;
}

/**
 * The sort first, then the module's default order as the tie-breaker (stable paging). Returns
 * null when the sort field is not an SQL column (the caller sorts that derived value itself).
 */
export function gridOrderBy<T>(
  sort: GridSort | undefined,
  columns: GridColumnMap,
  defaultOrder: readonly T[],
): T[] | null {
  if (!sort) return [...defaultOrder];
  const col = Object.hasOwn(columns, sort.field) ? columns[sort.field] : undefined;
  if (!col) return null;
  const leaf = col.nullable ? { sort: sort.dir, nulls: 'last' } : sort.dir;
  return [nest(col.path, leaf) as T, ...defaultOrder];
}
