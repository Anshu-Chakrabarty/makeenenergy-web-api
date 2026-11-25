// MAKEEN domain contract — identical copy in api/src/shared and web/src/shared.
// Edit both copies together; CI (contract.yml) fails if they differ. See DECISIONS D-49.

import { z } from 'zod';
import { toScaled } from '../decimal';
import { isIsoDate } from '../ist';

/**
 * Data grid query (column filters, global search, sort) shared by a list and its download.
 * Filters travel as one JSON query parameter (`filters`) because Express 5 parses only flat
 * query strings. Every value is checked against the module's field map, so an unknown column,
 * a wrong operator or a float can never reach the database.
 */

export const GRID_FILTER_KINDS = ['text', 'number', 'date', 'enum'] as const;
export type GridFilterKind = (typeof GRID_FILTER_KINDS)[number];

export const GRID_OPS = {
  text: ['contains', 'equals', 'startsWith', 'blank', 'notBlank'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'blank', 'notBlank'],
  date: ['eq', 'before', 'after', 'between'],
  enum: ['in'],
} as const satisfies Record<GridFilterKind, readonly string[]>;
export type GridTextOp = (typeof GRID_OPS.text)[number];
export type GridNumberOp = (typeof GRID_OPS.number)[number];
export type GridDateOp = (typeof GRID_OPS.date)[number];
export type GridOp = GridTextOp | GridNumberOp | GridDateOp | 'in';

/** Operators that need no value. */
export const GRID_NO_VALUE_OPS: readonly GridOp[] = ['blank', 'notBlank'];

/** Visible operator labels (the filter row's dropdown). */
export const GRID_OP_LABELS: Readonly<Record<GridOp, string>> = {
  contains: 'Contains',
  equals: 'Equals',
  startsWith: 'Starts with',
  blank: 'Is blank',
  notBlank: 'Is not blank',
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'Between',
  before: 'Before',
  after: 'After',
  in: 'Is any of',
};

/** One filterable / sortable column. */
export interface GridFieldDef {
  kind: GridFilterKind;
  /** Column heading (filter labels, download header). */
  label?: string;
  /** Decimals allowed for a number (0 = whole numbers). */
  scale?: number;
  /** A date filter on an instant column compares IST calendar days. */
  instant?: boolean;
  /** Allowed values of an enum column. */
  options?: readonly string[];
  /** false = the column cannot be sorted. */
  sortable?: boolean;
}
export type GridFieldMap = Readonly<Record<string, GridFieldDef>>;

export interface GridFilter {
  field: string;
  op: GridOp;
  /** Text, decimal string or ISO date. */
  value?: string | undefined;
  /** Upper bound of `between`. */
  value2?: string | undefined;
  /** Values of an enum `in`. */
  values?: string[] | undefined;
}

export type GridSortDir = 'asc' | 'desc';
export interface GridSort {
  field: string;
  dir: GridSortDir;
}

export const GRID_MESSAGES = {
  badFilters: 'The column filters could not be read.',
  unknownField: (f: string) => `“${f}” cannot be filtered.`,
  badOp: (f: string) => `That condition does not apply to “${f}”.`,
  valueRequired: (f: string) => `Type a value for “${f}”.`,
  badNumber: (f: string) => `“${f}” needs a number.`,
  badDate: (f: string) => `“${f}” needs a valid date.`,
  badOption: (f: string) => `Choose a listed value for “${f}”.`,
  betweenOrder: (f: string) => `For “${f}”, the second value must not be below the first.`,
  badSort: 'That column cannot be sorted.',
  tooMany: 'Use at most 20 column filters.',
} as const;

export const GRID_PAGE_SIZES = [25, 50, 100, 200] as const;
const MAX_FILTERS = 20;
const MAX_TEXT = 100;
const MAX_NUMBER_CHARS = 20;

const rawFilterSchema = z.object({
  field: z.string().max(60),
  op: z.string().max(20),
  value: z.string().max(MAX_TEXT).optional(),
  value2: z.string().max(MAX_TEXT).optional(),
  values: z.array(z.string().max(60)).max(50).optional(),
});

function numberOk(v: string, scale: number): boolean {
  if (v.length > MAX_NUMBER_CHARS) return false;
  try {
    return toScaled(v, scale) !== null;
  } catch {
    return false;
  }
}

function compare(a: string, b: string, def: GridFieldDef): number {
  if (def.kind === 'number') {
    const s = def.scale ?? 0;
    const x = toScaled(a, s) ?? 0n;
    const y = toScaled(b, s) ?? 0n;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Check one filter against its field; returns the issue text or null. */
export function gridFilterIssue(f: GridFilter, fields: GridFieldMap): string | null {
  const def = Object.hasOwn(fields, f.field) ? fields[f.field] : undefined;
  if (!def) return GRID_MESSAGES.unknownField(f.field);
  const ops: readonly string[] = GRID_OPS[def.kind];
  if (!ops.includes(f.op)) return GRID_MESSAGES.badOp(f.field);
  if (def.kind === 'enum') {
    const opts = def.options ?? [];
    if (!f.values || f.values.length === 0) return GRID_MESSAGES.valueRequired(f.field);
    return f.values.every((v) => opts.includes(v)) ? null : GRID_MESSAGES.badOption(f.field);
  }
  if (GRID_NO_VALUE_OPS.includes(f.op)) return null;
  const v = f.value?.trim() ?? '';
  if (v === '') return GRID_MESSAGES.valueRequired(f.field);
  const needs2 = f.op === 'between';
  const v2 = f.value2?.trim() ?? '';
  if (needs2 && v2 === '') return GRID_MESSAGES.valueRequired(f.field);
  if (def.kind === 'number') {
    const s = def.scale ?? 0;
    if (!numberOk(v, s) || (needs2 && !numberOk(v2, s))) return GRID_MESSAGES.badNumber(f.field);
  }
  if (def.kind === 'date' && (!isIsoDate(v) || (needs2 && !isIsoDate(v2)))) {
    return GRID_MESSAGES.badDate(f.field);
  }
  if (needs2 && compare(v, v2, def) > 0) return GRID_MESSAGES.betweenOrder(f.field);
  return null;
}

/** Normalise a valid filter: trimmed values, no stray keys for its operator. */
function cleanFilter(f: GridFilter): GridFilter {
  if (f.op === 'in') return { field: f.field, op: f.op, values: [...new Set(f.values ?? [])] };
  if (GRID_NO_VALUE_OPS.includes(f.op)) return { field: f.field, op: f.op };
  const value = f.value?.trim();
  if (f.op === 'between') return { field: f.field, op: f.op, value, value2: f.value2?.trim() };
  return { field: f.field, op: f.op, value };
}

/**
 * Plain-text form of one filter, e.g. `Physical stock (MT) > 100` (download header, chips).
 * `show` formats a value for display (dates as dd-mm-yyyy, enum keys as labels).
 */
export function describeGridFilter(
  f: GridFilter,
  label: string,
  show: (value: string) => string = (v) => v,
): string {
  if (f.op === 'in') return `${label}: ${(f.values ?? []).map(show).join(', ')}`;
  const op = GRID_OP_LABELS[f.op];
  if (GRID_NO_VALUE_OPS.includes(f.op)) return `${label} ${op.toLowerCase()}`;
  if (f.op === 'between') {
    return `${label} between ${show(f.value ?? '')} and ${show(f.value2 ?? '')}`;
  }
  const word = /^[A-Za-z]/.test(op) ? op.toLowerCase() : op;
  return `${label} ${word} ${show(f.value ?? '')}`;
}

/** The JSON text the browser sends as `filters` (empty filters → undefined, so it is left out). */
export function serializeGridFilters(filters: readonly GridFilter[]): string | undefined {
  return filters.length === 0 ? undefined : JSON.stringify(filters.map(cleanFilter));
}

/** `field:dir` text for the `sort` parameter. */
export function serializeGridSort(sort: GridSort | null | undefined): string | undefined {
  return sort ? `${sort.field}:${sort.dir}` : undefined;
}

/**
 * Zod shape for `filters`, `q` and `sort`. Spread it into a module's filter object so the list
 * and its download validate exactly the same way.
 */
export function gridQueryShape(fields: GridFieldMap) {
  return {
    filters: z
      .string()
      .max(4000, GRID_MESSAGES.badFilters)
      .optional()
      .transform((text, ctx): GridFilter[] => {
        if (text === undefined || text === '') return [];
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          ctx.addIssue({ code: 'custom', message: GRID_MESSAGES.badFilters });
          return z.NEVER;
        }
        const list = z.array(rawFilterSchema).safeParse(parsed);
        if (!list.success) {
          ctx.addIssue({ code: 'custom', message: GRID_MESSAGES.badFilters });
          return z.NEVER;
        }
        if (list.data.length > MAX_FILTERS) {
          ctx.addIssue({ code: 'custom', message: GRID_MESSAGES.tooMany });
          return z.NEVER;
        }
        const out: GridFilter[] = [];
        for (const raw of list.data) {
          const f = raw as GridFilter;
          const issue = gridFilterIssue(f, fields);
          if (issue) {
            ctx.addIssue({ code: 'custom', message: issue });
            return z.NEVER;
          }
          out.push(cleanFilter(f));
        }
        return out;
      }),
    q: z
      .string()
      .trim()
      .max(MAX_TEXT)
      .optional()
      .transform((v) => (v ? v : undefined)),
    sort: z
      .string()
      .max(80)
      .optional()
      .transform((text, ctx): GridSort | undefined => {
        if (text === undefined || text === '') return undefined;
        const i = text.lastIndexOf(':');
        const field = i > 0 ? text.slice(0, i) : '';
        const dir = text.slice(i + 1);
        const def = Object.hasOwn(fields, field) ? fields[field] : undefined;
        if (!def || def.sortable === false || (dir !== 'asc' && dir !== 'desc')) {
          ctx.addIssue({ code: 'custom', message: GRID_MESSAGES.badSort });
          return z.NEVER;
        }
        return { field, dir };
      }),
  };
}
