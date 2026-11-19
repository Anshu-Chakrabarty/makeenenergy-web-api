import { HttpStatus, Injectable } from '@nestjs/common';
import {
  assertPlant,
  canOnPlant,
  plantFilter,
  type PlantNeed,
  type PlantScope,
} from '../../common/access/plant-scope';
import { lapseDaysByPlant, lapseStartDate } from '../../common/db/lapse';
import { dayOf, isoDay, isoDayOrNull } from '../../common/db/people-names';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { Prisma } from '../../generated/prisma/client';
import {
  DAILY_EXCEPTION_LINE_COUNT,
  addDays,
  breakdownMinutes,
  financialYearOf,
  financialYearRange,
  firstDayOfMonth,
  formatDate,
  istToday,
  lastDayOfMonth,
  licenceStatus,
  monthOf,
  sumDecimals,
  type Comparison,
  type ComparisonQuery,
  type CumulativeDailySummary,
  type DailyHighlight,
  type ExceptionRowStatus,
  type MonthlyHighlight,
  type PlantRef,
  type ReviewFile,
  type ReviewPack,
  type ReviewPackQuery,
  type ReviewPackRow,
} from '../../shared';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { ResolvedAccess } from '../access/access.service';
import { summaryFromJson, summaryOf, SUMMARY_DAILY_KEYS } from '../monthly-mis/monthly-mis.mapper';

const MODULE = 'MANAGEMENT_REVIEW' as const;
export const REVIEW_NEED = {
  view: { module: MODULE, capability: 'VIEW' },
  download: { module: MODULE, capability: 'DOWNLOAD' },
} as const satisfies Record<string, PlantNeed>;
const EXCEPTION_VIEW: PlantNeed = { module: 'DAILY_EXCEPTIONS', capability: 'VIEW' };

/** Most files listed on one pack (newest first). */
export const REVIEW_MAX_FILES = 200;

export const EXCEPTION_TEXT = {
  notSubmitted: 'report not submitted',
  clean: 'Clean — no Yes line',
} as const;

const fixed = (v: Prisma.Decimal | null, dp: number): string | null =>
  v === null ? null : v.toFixed(dp);
const pair = (a: Prisma.Decimal | null, b: Prisma.Decimal | null): string | null =>
  a === null && b === null ? null : sumDecimals([fixed(a, 2), fixed(b, 2)], 2);

const dailySelect = {
  plantId: true,
  reportDate: true,
  status: true,
  stockGainLoss: true,
  eldTestedPct: true,
  oldTestedPct: true,
  lossMechanicalTotal: true,
  lossElectricalTotal: true,
  mrTotal: true,
  accuracyZero: true,
} as const satisfies Prisma.DailyMisSelect;
type DailyRecord = Prisma.DailyMisGetPayload<{ select: typeof dailySelect }>;

const exceptionSelect = {
  id: true,
  plantId: true,
  reportDate: true,
  status: true,
  problemHighlight: true,
  lines: {
    where: { answer: { not: null } },
    select: { lineNo: true, answer: true },
    orderBy: { lineNo: 'asc' },
  },
} as const satisfies Prisma.DailyExceptionSelect;
type ExceptionRecord = Prisma.DailyExceptionGetPayload<{ select: typeof exceptionSelect }>;

/** Daily columns the Cumulative Daily Summary reads, plus the plant. */
const summarySelect = {
  plantId: true,
  ...Object.fromEntries(SUMMARY_DAILY_KEYS.map((k) => [k, true])),
} as Prisma.DailyMisSelect;

const key = (plantId: string, day: string): string => `${plantId}|${day}`;

export function dailyHighlight(r: DailyRecord): DailyHighlight {
  return {
    stockGainLoss: fixed(r.stockGainLoss, 3),
    eldPct: fixed(r.eldTestedPct, 2),
    oldPct: fixed(r.oldTestedPct, 2),
    breakdownMinutes: breakdownMinutes(r.lossMechanicalTotal, r.lossElectricalTotal),
    marketReturns: r.mrTotal,
    accuracyZero: fixed(r.accuracyZero, 2),
  };
}

/** Month pack: the same measures from the month's Cumulative Daily Summary (MMIS mapping). */
export function summaryHighlight(s: CumulativeDailySummary): DailyHighlight {
  return {
    stockGainLoss: s.stockGainLoss,
    eldPct: s.eldAvg,
    oldPct: s.oldAvg,
    breakdownMinutes: Number(s.lossMechanical) + Number(s.lossElectrical),
    marketReturns: Number(s.marketReturns),
    accuracyZero: s.accuracyZeroAvg,
  };
}

/** MR-5: the first Yes remark (stored highlight, D-22) or “report not submitted”. */
export function exceptionText(e: ExceptionRecord | undefined, lineCount = DAILY_EXCEPTION_LINE_COUNT): {
  text: string;
  status: ExceptionRowStatus;
  id: string | null;
} {
  if (!e) return { text: EXCEPTION_TEXT.notSubmitted, status: 'NOT_INITIATED', id: null };
  if (e.status === 'COMPLETED')
    return { text: EXCEPTION_TEXT.clean, status: 'COMPLETED', id: e.id };
  if (e.status === 'PARTIAL')
    return {
      text:
        e.problemHighlight ??
        `Partial — ${String(e.lines.length)} of ${String(lineCount)} lines answered`,
      status: 'PARTIAL',
      id: e.id,
    };
  const firstYes = e.lines.find((l) => l.answer === 'YES');
  return {
    text:
      e.problemHighlight ??
      (firstYes ? `Yes — line ${String(firstYes.lineNo)}` : 'Plant not operational'),
    status: 'PENDING',
    id: e.id,
  };
}

/** Plant Comparison: the short form of the same rule. */
function exceptionShort(e: ExceptionRecord | undefined): string {
  if (!e) return 'Not submitted';
  if (e.status === 'COMPLETED') return 'Clean';
  if (e.status === 'PARTIAL') return 'Partial';
  const firstYes = e.lines.find((l) => l.answer === 'YES');
  return firstYes ? `Yes — line ${String(firstYes.lineNo)}` : 'Not operational';
}

const invalid = (path: string, message: string): AppError =>
  new AppError(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Some fields are not valid.', [
    { path, message },
  ]);

/**
 * Management Review (spec “Management Review”, MR-1…12). Read only: every number is read from
 * Daily MIS, Daily Exception and Monthly MIS rows already saved, for the plants the login's role
 * there may open Management Review on (Hidden elsewhere — ROLE-D7).
 */
@Injectable()
export class ReviewService {
  constructor(private readonly prisma: PrismaService) {}

  private asActor<T>(access: ResolvedAccess, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, fn);
  }

  /** Default day pack: yesterday (India time), the last full day (D-127). */
  defaultDate(): string {
    return addDays(istToday(), -1);
  }

  private async plants(tx: Tx, scope: PlantScope, upTo: string): Promise<PlantRef[]> {
    return tx.plant.findMany({
      where: {
        deletedAt: null,
        status: 'WORKING',
        startDate: { lte: dayOf(upTo) },
        ...(scope.all ? {} : { id: { in: scope.plantIds } }),
      },
      select: { id: true, name: true, code: true },
      orderBy: { name: 'asc' },
    });
  }

  private async lapse(
    tx: Tx,
    plantIds: string[],
    asOf: string,
  ): Promise<(plantId: string) => ReviewPackRow['lapse']> {
    const start = await lapseStartDate(tx);
    const [day, month, year] = await Promise.all([
      lapseDaysByPlant(tx, plantIds, asOf, asOf, start),
      lapseDaysByPlant(tx, plantIds, firstDayOfMonth(monthOf(asOf)), asOf, start),
      lapseDaysByPlant(tx, plantIds, financialYearRange(financialYearOf(asOf)).start, asOf, start),
    ]);
    return (id) => ({ day: day.get(id) ?? 0, month: month.get(id) ?? 0, year: year.get(id) ?? 0 });
  }

  async pack(access: ResolvedAccess, q: ReviewPackQuery): Promise<ReviewPack> {
    const scope = plantFilter(access, q.plantId, REVIEW_NEED.view);
    const kind = q.month ? 'MONTH' : 'DAY';
    const today = istToday();
    const from = q.month ? firstDayOfMonth(q.month) : (q.date ?? this.defaultDate());
    const monthEnd = q.month ? lastDayOfMonth(q.month) : from;
    const to = monthEnd < today ? monthEnd : today;
    return this.asActor(access, async (tx) => {
      const lineCount = await tx.exceptionFormField.count({
        where: { kind: 'yes_no', form: { code: 'DAILY', active: true } },
      });
      const plants = await this.plants(tx, scope, to);
      const ids = plants.map((p) => p.id);
      const range = { gte: dayOf(from), lte: dayOf(to) };
      const exceptions = await tx.dailyException.findMany({
        where: { plantId: { in: ids }, reportDate: range },
        select: exceptionSelect,
        orderBy: [{ reportDate: 'desc' }],
      });
      const lapseOf = await this.lapse(tx, ids, to);

      let rows: ReviewPackRow[];
      let filed: number;
      if (kind === 'DAY') {
        const daily = await tx.dailyMis.findMany({
          where: { plantId: { in: ids }, reportDate: dayOf(from), status: { not: 'DRAFT' } },
          select: dailySelect,
        });
        const dailyOf = new Map(daily.map((d) => [d.plantId, d]));
        const exOf = new Map(exceptions.map((e) => [e.plantId, e]));
        rows = plants.map((p) => {
          const d = dailyOf.get(p.id);
          return {
            plant: p,
            status: d?.status ?? null,
            daily: d ? dailyHighlight(d) : null,
            exception: exceptionText(exOf.get(p.id), lineCount),
            lapse: lapseOf(p.id),
            monthly: null,
          };
        });
        filed = daily.length;
      } else {
        const month = q.month ?? monthOf(from);
        rows = await this.monthRows(tx, plants, month, from, to, exceptions, lapseOf, lineCount);
        filed = rows.filter((r) => r.status !== null).length;
      }

      const licences = await tx.licence.findMany({
        where: { plantId: { in: ids } },
        select: { frequency: true, startDate: true, endDate: true, remindBeforeDays: true },
      });
      let licencesDue = 0;
      let licencesExpired = 0;
      for (const l of licences) {
        const s = licenceStatus(
          {
            frequency: l.frequency,
            startDate: isoDayOrNull(l.startDate),
            endDate: isoDayOrNull(l.endDate),
            remindBeforeDays: l.remindBeforeDays,
          },
          to,
        );
        if (s === 'DUE') licencesDue += 1;
        else if (s === 'EXPIRED') licencesExpired += 1;
      }

      const summaryFrom = firstDayOfMonth(monthOf(to));
      const approved = await tx.dailyMis.findMany({
        where: {
          plantId: { in: ids },
          status: 'APPROVED',
          reportDate: { gte: dayOf(summaryFrom), lte: dayOf(to) },
        },
        select: summarySelect,
      });

      return {
        kind,
        period: kind === 'DAY' ? from : (q.month ?? monthOf(from)),
        cards: {
          filed,
          total: plants.length,
          notFiled: plants.length - filed,
          openExceptions: exceptions.filter((e) => e.status !== 'COMPLETED').length,
          licencesDue,
          licencesExpired,
        },
        rows,
        summary: {
          from: summaryFrom,
          to,
          approvedDays: approved.length,
          items: summaryOf(approved),
        },
        files: await this.files(tx, access, exceptions),
      };
    });
  }

  /** Month pack rows: Monthly MIS status + highlight, and the month's daily figures (MR-6). */
  private async monthRows(
    tx: Tx,
    plants: PlantRef[],
    month: string,
    from: string,
    to: string,
    exceptions: ExceptionRecord[],
    lapseOf: (plantId: string) => ReviewPackRow['lapse'],
    lineCount: number,
  ): Promise<ReviewPackRow[]> {
    const ids = plants.map((p) => p.id);
    const [monthly, approved] = await Promise.all([
      tx.monthlyMis.findMany({
        where: {
          plantId: { in: ids },
          month: dayOf(firstDayOfMonth(month)),
          status: { not: 'DRAFT' },
        },
        select: {
          plantId: true,
          status: true,
          ebUnits: true,
          dgUnits: true,
          dieselDg: true,
          dieselFireEngine: true,
          operatingCostPerMt: true,
          tenderCostPerMt: true,
          summarySnapshot: true,
        },
      }),
      tx.dailyMis.findMany({
        where: {
          plantId: { in: ids },
          status: 'APPROVED',
          reportDate: { gte: dayOf(from), lte: dayOf(to) },
        },
        select: summarySelect,
      }),
    ]);
    const monthlyOf = new Map(monthly.map((m) => [m.plantId, m]));
    return plants.map((p) => {
      const mine = approved.filter((r) => Reflect.get(r, 'plantId') === p.id);
      const live = summaryOf(mine);
      const m = monthlyOf.get(p.id);
      const frozen = m?.status === 'APPROVED' ? summaryFromJson(m.summarySnapshot) : null;
      const summary = frozen ?? live;
      const open = exceptions.find((e) => e.plantId === p.id && e.status !== 'COMPLETED');
      const lapse = lapseOf(p.id);
      const exception = open
        ? exceptionText(open, lineCount)
        : lapse.month > 0
          ? {
              text: `${EXCEPTION_TEXT.notSubmitted} on ${String(lapse.month)} day${lapse.month === 1 ? '' : 's'}`,
              status: 'NOT_INITIATED' as const,
              id: null,
            }
          : { text: EXCEPTION_TEXT.clean, status: 'COMPLETED' as const, id: null };
      const monthlyHighlight: MonthlyHighlight | null = m
        ? {
            production: summary.totalProduction,
            electricity: pair(m.ebUnits, m.dgUnits),
            diesel: pair(m.dieselDg, m.dieselFireEngine),
            costPerMt: fixed(m.operatingCostPerMt, 2),
            tenderCostPerMt: fixed(m.tenderCostPerMt, 2),
            status: m.status,
          }
        : null;
      return {
        plant: p,
        status: m?.status ?? null,
        daily: mine.length > 0 || frozen ? summaryHighlight(summary) : null,
        exception,
        lapse,
        monthly: monthlyHighlight,
      };
    });
  }

  /** MR-10 / FILE-2: files on the Daily Exceptions shown, for plants whose role may open them. */
  private async files(
    tx: Tx,
    access: ResolvedAccess,
    exceptions: ExceptionRecord[],
  ): Promise<ReviewFile[]> {
    const visible = exceptions.filter((e) => canOnPlant(access, e.plantId, EXCEPTION_VIEW));
    if (visible.length === 0) return [];
    const byId = new Map(visible.map((e) => [e.id, e]));
    const files = await tx.attachment.findMany({
      where: { ownerType: 'DAILY_EXCEPTION', ownerId: { in: [...byId.keys()] }, replacedAt: null },
      select: { id: true, ownerId: true, fileName: true },
      orderBy: { uploadedAt: 'desc' },
      take: REVIEW_MAX_FILES,
    });
    const plants = await tx.plant.findMany({
      where: { id: { in: [...new Set(visible.map((e) => e.plantId))] } },
      select: { id: true, name: true, code: true },
    });
    const plantOf = new Map(plants.map((p) => [p.id, p]));
    return files.flatMap((f) => {
      const e = byId.get(f.ownerId);
      const plant = e ? plantOf.get(e.plantId) : undefined;
      if (!e || !plant) return [];
      return [
        {
          id: f.id,
          fileName: f.fileName,
          url: `/api/daily-exceptions/${e.id}/files/${f.id}`,
          plant,
          what: `Daily Exception ${formatDate(isoDay(e.reportDate))}`,
        },
      ];
    });
  }

  /** MR-2 / MR-9: a table only — the same date across plants, or dates on one plant. */
  async comparison(access: ResolvedAccess, q: ComparisonQuery): Promise<Comparison> {
    if (q.mode === 'DATES') {
      const plantId = q.plantId ?? '';
      assertPlant(access, plantId, REVIEW_NEED.view);
      const to = q.to ?? this.defaultDate();
      const from = q.from ?? addDays(to, -6);
      if (from > to) throw invalid('to', 'The end date is before the start date.');
      const days: string[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
      return this.asActor(access, async (tx) => {
        const plant = await tx.plant.findFirst({
          where: { id: plantId, deletedAt: null },
          select: { id: true, name: true, code: true },
        });
        const data = await this.measures(tx, [plantId], from, to);
        return {
          mode: 'DATES',
          title: `${plant?.name ?? 'Plant'} · ${formatDate(from)} to ${formatDate(to)}`,
          columns: days.map((d) => ({ key: d, label: formatDate(d) })),
          rows: this.measureRows(days.map((d) => data(plantId, d))),
        };
      });
    }
    const date = q.date ?? this.defaultDate();
    const scope = plantFilter(access, undefined, REVIEW_NEED.view);
    return this.asActor(access, async (tx) => {
      const plants = await this.plants(tx, scope, date);
      const data = await this.measures(
        tx,
        plants.map((p) => p.id),
        date,
        date,
      );
      return {
        mode: 'PLANTS',
        title: `Same date across plants · ${formatDate(date)}`,
        columns: plants.map((p) => ({ key: p.id, label: p.name })),
        rows: this.measureRows(plants.map((p) => data(p.id, date))),
      };
    });
  }

  /** Figures per plant-day for the comparison table. */
  private async measures(
    tx: Tx,
    plantIds: string[],
    from: string,
    to: string,
  ): Promise<
    (
      plantId: string,
      day: string,
    ) => { daily: DailyHighlight | null; exception: string; lapseMonth: number }
  > {
    const range = { gte: dayOf(from), lte: dayOf(to) };
    const [daily, exceptions, start] = await Promise.all([
      tx.dailyMis.findMany({
        where: { plantId: { in: plantIds }, reportDate: range, status: { not: 'DRAFT' } },
        select: dailySelect,
      }),
      tx.dailyException.findMany({
        where: { plantId: { in: plantIds }, reportDate: range },
        select: exceptionSelect,
      }),
      lapseStartDate(tx),
    ]);
    const dailyOf = new Map(daily.map((d) => [key(d.plantId, isoDay(d.reportDate)), d]));
    const exOf = new Map(exceptions.map((e) => [key(e.plantId, isoDay(e.reportDate)), e]));
    // Lapse in the month up to each day: the month's missing days on or before that day.
    const missing = await tx.$queryRaw<{ plant_id: string; day: string }[]>(Prisma.sql`
      SELECT p.id AS plant_id, d.day::date::text AS day
        FROM plants p
        CROSS JOIN LATERAL generate_series(
          GREATEST(${firstDayOfMonth(monthOf(from))}::date, p.start_date, COALESCE(${start}::date, p.start_date)),
          LEAST(${to}::date, ${istToday()}::date), interval '1 day') AS d(day)
        LEFT JOIN daily_exceptions e ON e.plant_id = p.id AND e.report_date = d.day::date
       WHERE p.deleted_at IS NULL AND p.status = 'WORKING' AND e.id IS NULL
         AND p.id = ANY(${plantIds}::uuid[])`);
    return (plantId, day) => {
      const d = dailyOf.get(key(plantId, day));
      const monthStart = firstDayOfMonth(monthOf(day));
      return {
        daily: d ? dailyHighlight(d) : null,
        exception: exceptionShort(exOf.get(key(plantId, day))),
        lapseMonth: missing.filter(
          (m) => m.plant_id === plantId && m.day >= monthStart && m.day <= day,
        ).length,
      };
    };
  }

  private measureRows(
    cols: { daily: DailyHighlight | null; exception: string; lapseMonth: number }[],
  ): Comparison['rows'] {
    const val = (f: (h: DailyHighlight) => string | number | null): (string | null)[] =>
      cols.map((c) => {
        const v = c.daily ? f(c.daily) : null;
        return v === null ? null : String(v);
      });
    return [
      { measure: 'Stock gain / loss (MT)', values: val((h) => h.stockGainLoss) },
      {
        measure: 'Sort-out ELD / OLD %',
        values: val((h) =>
          h.eldPct === null && h.oldPct === null ? null : `${h.eldPct ?? '—'} / ${h.oldPct ?? '—'}`,
        ),
      },
      { measure: 'Breakdown minutes', values: val((h) => h.breakdownMinutes) },
      { measure: 'Market returns', values: val((h) => h.marketReturns) },
      { measure: 'Accuracy — 0 gms %', values: val((h) => h.accuracyZero) },
      { measure: 'Exception', values: cols.map((c) => c.exception) },
      { measure: 'Lapse (month)', values: cols.map((c) => String(c.lapseMonth)) },
    ];
  }
}
