import {
  CYLINDER_SIZES,
  CYLINDER_STAT_CATEGORIES,
  INVENTORY_ITEMS,
  MONTHLY_MIS_VALUE_FIELDS,
  MONTHLY_SUMMARY_ITEMS,
  cumulativeDailySummary,
  inventoryKind,
  trainingTotalOf,
  type CumulativeDailySummary,
  type CylinderGrid,
  type CylinderSize,
  type CylinderStatCategory,
  type FieldDef,
  type InventoryItem,
  type InventoryValues,
  type MonthlyMisValueKey,
  type MonthlyMisValues,
} from '../../shared';

const DECIMAL_KINDS = new Set(['mt', 'percent', 'hours', 'rupees', 'litres', 'units', 'ratio']);
const INT_KINDS = new Set(['count', 'minutes']);
const FIELDS = MONTHLY_MIS_VALUE_FIELDS as readonly FieldDef<MonthlyMisValueKey>[];

function isDecimalLike(v: unknown): v is { toFixed: (dp: number) => string } {
  return v !== null && typeof v === 'object' && typeof Reflect.get(v, 'toFixed') === 'function';
}

/** Daily MIS columns the Cumulative Daily Summary reads (items 1–25). */
export const SUMMARY_DAILY_KEYS = [
  ...new Set(MONTHLY_SUMMARY_ITEMS.flatMap((i) => ('daily' in i ? [...i.daily] : []))),
];

/** A stored row → Block B values (decimals fixed, dates ISO, Yes/No text). */
export function valuesFromRecord(record: object): MonthlyMisValues {
  const out = {} as Record<MonthlyMisValueKey, string | number | null>;
  for (const f of FIELDS) {
    const raw: unknown = Reflect.get(record, f.key);
    if (raw instanceof Date) out[f.key] = raw.toISOString().slice(0, 10);
    else if (DECIMAL_KINDS.has(f.kind) && isDecimalLike(raw)) out[f.key] = raw.toFixed(f.decimals);
    else if (typeof raw === 'number')
      out[f.key] = INT_KINDS.has(f.kind) ? raw : raw.toFixed(f.decimals);
    else if (typeof raw === 'string') out[f.key] = raw;
    else out[f.key] = null;
  }
  return out;
}

/** Block B values → column data, with item 47 computed here and nowhere else. */
export function recordData(
  values: MonthlyMisValues,
): Record<string, string | number | Date | null> {
  const data: Record<string, string | number | Date | null> = {};
  for (const f of FIELDS) {
    const v = values[f.key];
    data[f.key] = f.kind === 'date' && typeof v === 'string' ? new Date(`${v}T00:00:00.000Z`) : v;
  }
  data['trainingTotal'] = trainingTotalOf(values);
  return data;
}

export function completeValues(partial: Partial<MonthlyMisValues>): MonthlyMisValues {
  const out = {} as Record<MonthlyMisValueKey, string | number | null>;
  for (const f of FIELDS) out[f.key] = partial[f.key] ?? null;
  return out;
}

export function emptyGrid(): CylinderGrid {
  return Object.fromEntries(
    CYLINDER_STAT_CATEGORIES.map((c) => [
      c,
      Object.fromEntries(CYLINDER_SIZES.map((s) => [s, null])),
    ]),
  ) as CylinderGrid;
}

export function gridFromRows(
  rows: readonly { category: CylinderStatCategory; size: CylinderSize; quantity: number }[],
): CylinderGrid {
  const grid = emptyGrid();
  for (const r of rows) grid[r.category][r.size] = r.quantity;
  return grid;
}

/** Only entered cells are stored (blank = no row). */
export function gridRows(
  grid: Partial<Record<CylinderStatCategory, Partial<Record<CylinderSize, number | null>>>>,
) {
  return CYLINDER_STAT_CATEGORIES.flatMap((category) =>
    CYLINDER_SIZES.flatMap((size) => {
      const q = grid[category]?.[size];
      return q === null || q === undefined ? [] : [{ category, size, quantity: q }];
    }),
  );
}

export function inventoryFromRows(
  rows: readonly { item: InventoryItem; quantity: { toFixed: (dp: number) => string } }[],
): InventoryValues {
  const out = Object.fromEntries(INVENTORY_ITEMS.map((i) => [i, null])) as InventoryValues;
  for (const r of rows) {
    out[r.item] =
      inventoryKind(r.item) === 'count' ? Number(r.quantity.toFixed(0)) : r.quantity.toFixed(2);
  }
  return out;
}

export function inventoryRows(values: Partial<Record<InventoryItem, string | number | null>>) {
  return INVENTORY_ITEMS.flatMap((item) => {
    const q = values[item];
    return q === null || q === undefined ? [] : [{ item, quantity: String(q) }];
  });
}

/** Approved Daily rows → items 1–25 (MT/counts SUM, % AVERAGE, 0 when none — MMIS-R4). */
export function summaryOf(rows: readonly object[]): CumulativeDailySummary {
  return cumulativeDailySummary(
    rows.map((r) =>
      Object.fromEntries(
        SUMMARY_DAILY_KEYS.map((k) => {
          const v: unknown = Reflect.get(r, k);
          return [k, isDecimalLike(v) ? v.toFixed(3) : typeof v === 'number' ? String(v) : null];
        }),
      ),
    ),
  );
}

/** A stored snapshot (JSON) → summary, or null when it is not a complete snapshot. */
export function summaryFromJson(json: unknown): CumulativeDailySummary | null {
  if (json === null || typeof json !== 'object') return null;
  const out: Record<string, string> = {};
  for (const item of MONTHLY_SUMMARY_ITEMS) {
    const v: unknown = Reflect.get(json, item.key);
    if (typeof v !== 'string') return null;
    out[item.key] = v;
  }
  return out as CumulativeDailySummary;
}
