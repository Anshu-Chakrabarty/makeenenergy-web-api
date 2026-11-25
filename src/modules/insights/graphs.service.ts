import { Injectable } from '@nestjs/common';
import { assertPlant, type PlantNeed } from '../../common/access/plant-scope';
import { dayOf, isoDay } from '../../common/db/people-names';
import type { RequestContext } from '../../common/security/request-context';
import { Prisma } from '../../generated/prisma/client';
import {
  GRAPH_TREND_MONTHS,
  addDays,
  firstDayOfMonth,
  formatDate,
  formatMonthYear,
  lastDayOfMonth,
  manHourSettingSchema,
  monthsEnding,
  shortDayLabel,
  shortMonthLabel,
  sumDecimals,
  type GraphChart,
  type GraphsQuery,
  type GraphsView,
  type ManHourSetting,
} from '../../shared';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { summaryOf, SUMMARY_DAILY_KEYS } from '../monthly-mis/monthly-mis.mapper';
import { defaultMonth } from '../monthly-mis/monthly-mis.service';

const MODULE = 'GRAPHS' as const;
export const GRAPHS_NEED = {
  view: { module: MODULE, capability: 'VIEW' },
  download: { module: MODULE, capability: 'DOWNLOAD' },
} as const satisfies Record<string, PlantNeed>;

/** App setting holding the GR-4 switch (Off by default). */
export const MAN_HOUR_SETTING = 'graphs.manHour';
const MAN_HOUR_OFF: ManHourSetting = { enabled: false, hoursPerShift: null };

const fixed = (v: Prisma.Decimal | null, dp: number): string | null =>
  v === null ? null : v.toFixed(dp);
const decimalLike = (v: unknown): v is { toFixed: (dp: number) => string } =>
  v !== null && typeof v === 'object' && typeof Reflect.get(v, 'toFixed') === 'function';

const dailySelect = {
  reportDate: true,
  status: true,
  physicalStock: true,
  bulkReceipts: true,
  accuracyBeyond100: true,
  cylFilled142: true,
  cylFilled19: true,
  cylFilledOther: true,
  ...Object.fromEntries(SUMMARY_DAILY_KEYS.map((k) => [k, true])),
} as Prisma.DailyMisSelect;

interface Series {
  key: string;
  label: string;
  unit?: string;
}

/** One chart plus its table: the table repeats the chart's numbers (GR-0). */
function chart(
  def: Omit<GraphChart, 'table' | 'points'> & {
    firstColumn: string;
    points: {
      label: string;
      tableLabel: string;
      values: Record<string, string | null>;
      pending?: boolean;
    }[];
    total?: boolean;
  },
): GraphChart {
  const { firstColumn, total, points, ...rest } = def;
  const columns = [firstColumn, ...def.series.map((s) => s.label), ...(total ? ['Total'] : [])];
  const rows = points.map((p) => {
    const cells = def.series.map((s) => p.values[s.key] ?? null);
    const present = cells.filter((c): c is string => c !== null);
    return [
      p.tableLabel,
      ...cells,
      ...(total ? [present.length === 0 ? null : sumDecimals(present, 2)] : []),
    ];
  });
  return {
    ...rest,
    points: points.map((p) => ({
      label: p.label,
      values: p.values,
      ...(p.pending ? { pending: true } : {}),
    })),
    table: { columns, rows },
  };
}

/**
 * Graphs (spec “Graphs”, GR-0…GR-8). Charts are made only from numbers already saved: Approved
 * Daily MIS and Approved Monthly MIS of one plant (D-125). Daily charts cover the chosen month;
 * trend charts the six months up to it. Nothing is typed here.
 */
@Injectable()
export class GraphsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  private asActor<T>(access: ResolvedAccess, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, fn);
  }

  async manHour(tx: Tx): Promise<ManHourSetting> {
    const s = await tx.appSetting.findUnique({ where: { key: MAN_HOUR_SETTING } });
    const parsed = manHourSettingSchema.safeParse(s?.value);
    return parsed.success ? parsed.data : MAN_HOUR_OFF;
  }

  /** GR-4: Admin switches the man-hour formula On once hours per shift are given. */
  async setManHour(
    access: ResolvedAccess,
    input: ManHourSetting,
    ctx: RequestContext,
  ): Promise<ManHourSetting> {
    return this.asActor(access, async (tx) => {
      const before = await this.manHour(tx);
      const value = { enabled: input.enabled, hoursPerShift: input.hoursPerShift };
      await tx.appSetting.upsert({
        where: { key: MAN_HOUR_SETTING },
        create: { key: MAN_HOUR_SETTING, value, updatedById: access.userId },
        update: { value, updatedById: access.userId },
      });
      await this.audit.record(
        {
          action: AuditAction.UPDATE,
          entity: 'app_setting',
          entityId: MAN_HOUR_SETTING,
          actorId: access.userId,
          before: { ...before },
          after: value,
          ctx,
        },
        tx,
      );
      return value;
    });
  }

  async view(access: ResolvedAccess, q: GraphsQuery): Promise<GraphsView> {
    assertPlant(access, q.plantId, GRAPHS_NEED.view);
    const month = q.month ?? defaultMonth();
    const months = monthsEnding(month, GRAPH_TREND_MONTHS);
    const first = months[0] ?? month;
    return this.asActor(access, async (tx) => {
      const plant = await tx.plant.findFirst({
        where: { id: q.plantId, deletedAt: null },
        select: { id: true, name: true, code: true },
      });
      const manHour = await this.manHour(tx);
      const daily = await tx.dailyMis.findMany({
        where: {
          plantId: q.plantId,
          status: { in: ['APPROVED', 'PENDING', 'RETURNED'] },
          reportDate: {
            gte: dayOf(firstDayOfMonth(first)),
            lte: dayOf(lastDayOfMonth(month)),
          },
        },
        select: dailySelect,
        orderBy: { reportDate: 'asc' },
      });
      const monthly = await tx.monthlyMis.findMany({
        where: {
          plantId: q.plantId,
          month: { gte: dayOf(firstDayOfMonth(first)), lte: dayOf(firstDayOfMonth(month)) },
        },
        select: {
          status: true,
          month: true,
          ebUnits: true,
          dgUnits: true,
          dieselDg: true,
          dieselFireEngine: true,
          operatingCostPerMt: true,
          tenderCostPerMt: true,
          capsUsedPct: true,
          sealsUsedPct: true,
          oRingsReplacedPct: true,
          valvesReplacedPct: true,
        },
      });
      return {
        plant: plant ?? { id: q.plantId, name: '—', code: '' },
        month,
        months,
        charts: this.charts(month, months, daily, monthly, manHour),
        manHour,
      };
    });
  }

  private charts(
    month: string,
    months: string[],
    daily: object[],
    monthly: {
      status: string;
      month: Date;
      ebUnits: Prisma.Decimal | null;
      dgUnits: Prisma.Decimal | null;
      dieselDg: Prisma.Decimal | null;
      dieselFireEngine: Prisma.Decimal | null;
      operatingCostPerMt: Prisma.Decimal | null;
      tenderCostPerMt: Prisma.Decimal | null;
      capsUsedPct: Prisma.Decimal | null;
      sealsUsedPct: Prisma.Decimal | null;
      oRingsReplacedPct: Prisma.Decimal | null;
      valvesReplacedPct: Prisma.Decimal | null;
    }[],
    manHour: ManHourSetting,
  ): GraphChart[] {
    const dec = (r: object, k: string, dp: number): string | null => {
      const v: unknown = Reflect.get(r, k);
      return decimalLike(v) ? v.toFixed(dp) : null;
    };
    const dayOfRow = (r: object): string => {
      const v: unknown = Reflect.get(r, 'reportDate');
      return v instanceof Date ? isoDay(v) : '';
    };
    const days: string[] = [];
    for (let d = firstDayOfMonth(month); d <= lastDayOfMonth(month); d = addDays(d, 1))
      days.push(d);
    const inMonth = new Map(
      daily.filter((r) => dayOfRow(r).startsWith(month)).map((r) => [dayOfRow(r), r]),
    );
    const approved = (r: object): boolean => Reflect.get(r, 'status') === 'APPROVED';
    const perDay = (
      values: (r: object) => Record<string, string | null>,
      series: Series[],
    ): {
      label: string;
      tableLabel: string;
      values: Record<string, string | null>;
      pending?: boolean;
    }[] =>
      days.map((d) => {
        const r = inMonth.get(d);
        const ok = r !== undefined && approved(r);
        return {
          label: shortDayLabel(d),
          tableLabel: formatDate(d),
          pending: r !== undefined && !ok,
          values: ok && r ? values(r) : Object.fromEntries(series.map((s) => [s.key, null])),
        };
      });
    const monthlyOf = new Map(monthly.map((m) => [isoDay(m.month).slice(0, 7), m]));
    const dailyByMonth = new Map(
      months.map((m) => [m, daily.filter((r) => approved(r) && dayOfRow(r).startsWith(m))]),
    );
    const perMonth = (
      values: (m: string) => Record<string, string | null>,
    ): { label: string; tableLabel: string; values: Record<string, string | null> }[] =>
      months.map((m) => ({
        label: shortMonthLabel(m),
        tableLabel: formatMonthYear(m),
        values: values(m),
      }));
    const monthCols = (
      pick: (m: (typeof monthly)[number]) => Record<string, string | null>,
      series: Series[],
    ) =>
      months.map((m) => {
        const row = monthlyOf.get(m);
        const pending = row !== undefined && row.status !== 'APPROVED';
        return {
          label: shortMonthLabel(m),
          tableLabel: formatMonthYear(m),
          pending,
          values: row ? pick(row) : Object.fromEntries(series.map((s) => [s.key, null])),
        };
      });

    const s1: Series[] = [{ key: 'gainLoss', label: 'Stock gain / loss (MT)' }];
    const s2: Series[] = [
      { key: 'dg', label: 'DG (litres)' },
      { key: 'fireEngine', label: 'Fire engine (litres)' },
    ];
    const s3: Series[] = [
      { key: 'eb', label: 'EB units (kWh)' },
      { key: 'dg', label: 'DG units (kWh)' },
    ];
    const shiftHours = manHour.hoursPerShift ?? 8;
    const s4: Series[] = [
      // Three different units: each is drawn in its own panel (no second y-axis, D-128).
      { key: 'production', label: 'Production (MT)', unit: 'MT' },
      { key: 'otHours', label: 'OT hours', unit: 'hours' },
      { key: 'perManHour', label: 'MT per man hour', unit: 'MT per man hour' },
    ];
    const s5: Series[] = [
      { key: 'operating', label: 'Operating cost / MT (Rs.)' },
      { key: 'tender', label: 'Tender cost / MT (Rs.)' },
    ];
    const s6: Series[] = [
      { key: 'caps', label: 'Caps %' },
      { key: 'seals', label: 'Seals %' },
      { key: 'oRings', label: 'O-rings %' },
      { key: 'valves', label: 'Valves %' },
    ];
    const s7: Series[] = [
      { key: 'zero', label: '0 gms %' },
      { key: 'p50', label: '±50 gms %' },
      { key: 'p100', label: '±100 gms %' },
      { key: 'beyond', label: 'Beyond ±100 gms %' },
    ];
    const s8: Series[] = [
      { key: 'stock', label: 'Physical stock (MT)' },
      { key: 'receipts', label: 'Receipts (MT)' },
      { key: 'despatch', label: 'Despatch (MT)' },
    ];
    const monthLabel = formatMonthYear(month);
    const trend = `${formatMonthYear(months[0] ?? month)} to ${monthLabel}`;

    return [
      chart({
        id: 1,
        title: 'Monthly stock loss / gain',
        source: `Approved Daily MIS, stock gain or loss · ${monthLabel}`,
        kind: 'bar',
        unit: 'MT',
        series: s1,
        firstColumn: 'Date',
        points: perDay((r) => ({ gainLoss: dec(r, 'stockGainLoss', 3) }), s1),
        total: true,
        note: 'A blank day has no approved Daily MIS. 0 is a saved zero. A day that is saved but not approved is marked.',
      }),
      chart({
        id: 2,
        title: 'Diesel consumed',
        source: `Monthly MIS diesel · ${trend}`,
        kind: 'stacked',
        unit: 'litres',
        series: s2,
        firstColumn: 'Month',
        points: monthCols(
          (m) => ({ dg: fixed(m.dieselDg, 2), fireEngine: fixed(m.dieselFireEngine, 2) }),
          s2,
        ),
        total: true,
        note: null,
      }),
      chart({
        id: 3,
        title: 'Electricity units',
        source: `Monthly MIS electricity · ${trend}`,
        kind: 'stacked',
        unit: 'kWh',
        series: s3,
        firstColumn: 'Month',
        points: monthCols((m) => ({ eb: fixed(m.ebUnits, 2), dg: fixed(m.dgUnits, 2) }), s3),
        total: true,
        note: 'Unit is kWh. A month that is saved but not approved yet is shown and marked. A blank month has no Monthly MIS.',
      }),
      chart({
        id: 4,
        title: 'Production per man hour',
        source: `Approved Daily MIS, production and OT hours · ${trend}`,
        kind: 'line',
        unit: 'MT / hours',
        series: s4,
        firstColumn: 'Month',
        points: perMonth((m) => {
          const rows = dailyByMonth.get(m) ?? [];
          if (rows.length === 0) return Object.fromEntries(s4.map((s) => [s.key, null]));
          const s = summaryOf(rows);
          const shifts = Number(s.totalShifts);
          const ot = Number(s.totalOtHours);
          const denom = shifts * shiftHours + (Number.isFinite(ot) ? ot : 0);
          const out: Record<string, string | null> = {
            production: s.totalProduction,
            otHours: s.totalOtHours,
            perManHour:
              denom > 0
                ? new Prisma.Decimal(s.totalProduction).div(denom).toFixed(3)
                : null,
          };
          return out;
        }),
        note: `MT per man hour = production MT ÷ (shifts × ${String(shiftHours)} hours per shift + OT hours).`,
      }),
      chart({
        id: 5,
        title: 'Cost per MT',
        source: `Monthly MIS operating cost and tender cost per MT · ${trend}`,
        kind: 'line',
        unit: 'Rs. / MT',
        series: s5,
        firstColumn: 'Month',
        points: monthCols(
          (m) => ({
            operating: fixed(m.operatingCostPerMt, 2),
            tender: fixed(m.tenderCostPerMt, 2),
          }),
          s5,
        ),
        note: null,
      }),
      chart({
        id: 6,
        title: 'Spare usage',
        source: `Monthly MIS spare usage · ${trend}`,
        kind: 'grouped',
        unit: '%',
        series: s6,
        firstColumn: 'Month',
        points: monthCols(
          (m) => ({
            caps: fixed(m.capsUsedPct, 2),
            seals: fixed(m.sealsUsedPct, 2),
            oRings: fixed(m.oRingsReplacedPct, 2),
            valves: fixed(m.valvesReplacedPct, 2),
          }),
          s6,
        ),
        note: null,
      }),
      chart({
        id: 7,
        title: 'Filling accuracy',
        source: `Approved Daily MIS filling accuracy, weighted by cylinders filled · ${trend}`,
        kind: 'stacked100',
        unit: '%',
        series: s7,
        firstColumn: 'Month',
        points: perMonth((m) => {
          const rows = dailyByMonth.get(m) ?? [];
          if (rows.length === 0) return Object.fromEntries(s7.map((s) => [s.key, null]));
          const weight = (r: object): number => {
            const n = (k: string): number => {
              const v = dec(r, k, 0);
              return v === null ? 0 : Number(v);
            };
            return n('cylFilled142') + n('cylFilled19') + n('cylFilledOther');
          };
          const weighted = (key: string): string | null => {
            let num = 0;
            let den = 0;
            for (const r of rows) {
              const pct = dec(r, key, 2);
              const w = weight(r);
              if (pct === null || w <= 0) continue;
              num += Number(pct) * w;
              den += w;
            }
            return den === 0 ? null : (num / den).toFixed(2);
          };
          return {
            zero: weighted('accuracyZero'),
            p50: weighted('accuracy50'),
            p100: weighted('accuracy100'),
            beyond: weighted('accuracyBeyond100'),
          };
        }),
        note: 'Each day is weighted by the cylinders filled that day. A blank month has no approved Daily MIS.',
      }),
      chart({
        id: 8,
        title: 'Productivity — stock, receipt, dispatch',
        source: `Approved Daily MIS, physical stock, receipts and despatch · ${monthLabel}`,
        kind: 'line',
        unit: 'MT',
        series: s8,
        firstColumn: 'Date',
        points: perDay(
          (r) => ({
            stock: dec(r, 'physicalStock', 3),
            receipts: dec(r, 'bulkReceipts', 3),
            despatch: sumDecimals(
              [
                'normalCylinderDespatch',
                'normalTtLoading',
                'otCylinderDespatch',
                'otTtLoading',
              ].map((k) => dec(r, k, 3)),
              3,
            ),
          }),
          s8,
        ),
        note: 'A blank is a day with no approved Daily MIS. 0 is a saved zero.',
      }),
    ];
  }
}
