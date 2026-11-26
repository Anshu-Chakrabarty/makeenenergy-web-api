import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { forbidden } from '../../common/access/access.guard';
import {
  assertPlant,
  canOnPlant,
  plantFilter,
  type PlantNeed,
  type PlantScope,
} from '../../common/access/plant-scope';
import type { RequestContext } from '../../common/security/request-context';
import { Prisma } from '../../generated/prisma/client';
import {
  MONTHLY_MIS_MESSAGES,
  daysBetween,
  firstDayOfMonth,
  formatMonthYear,
  hoursBetween,
  istCurrentMonth,
  lastDayOfMonth,
  sumDecimals,
  type ApprovalQueueItem,
  type CumulativeDailySummary,
  type MonthlyMisCards,
  type MonthlyMisDetail,
  type MonthlyMisFilter,
  type MonthlyMisListRow,
  type MonthlyMisPage,
  type MonthlyMisQuery,
  type MonthlyMisSaveInput,
  type MonthlyMisTotals,
  type MonthlySummaryView,
  type PersonRef,
  type ReportStatus,
} from '../../shared';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  SUMMARY_DAILY_KEYS,
  completeValues,
  gridFromRows,
  gridRows,
  inventoryFromRows,
  inventoryRows,
  recordData,
  summaryFromJson,
  summaryOf,
  valuesFromRecord,
} from './monthly-mis.mapper';

const MODULE = 'MONTHLY_MIS' as const;
const NEED = {
  view: { module: MODULE, capability: 'VIEW' },
  submit: { module: MODULE, capability: 'SUBMIT' },
  download: { module: MODULE, capability: 'DOWNLOAD' },
  approve: { module: MODULE, capability: 'APPROVE' },
  return: { module: MODULE, capability: 'APPROVE', action: 'RETURN' },
  reopen: { module: MODULE, capability: 'VIEW', action: 'REOPEN_APPROVED' },
} as const satisfies Record<string, PlantNeed>;

const err = (status: HttpStatus, code: string, message: string): AppError =>
  new AppError(status, code, message);
const notFound = (): AppError =>
  err(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, MONTHLY_MIS_MESSAGES.notFound);
const conflict = (message: string): AppError =>
  err(HttpStatus.CONFLICT, ErrorCode.CONFLICT, message);

/** Hours rounded to one decimal (D-30). */
const waiting = (from: Date, to: Date): number => Math.round(hoursBetween(from, to) * 10) / 10;

const monthKey = (d: Date): string => d.toISOString().slice(0, 7);
const dateOf = (v: string): Date => new Date(`${v}T00:00:00.000Z`);
const monthDate = (month: string): Date => dateOf(firstDayOfMonth(month));

/** The month before the current India month (the mockup shows Sep 2026 on 16-10-2026, D-93). */
export function defaultMonth(now: Date = new Date()): string {
  const [y, m] = istCurrentMonth(now).split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const fixed = (v: Prisma.Decimal | null, dp: number): string | null =>
  v === null ? null : v.toFixed(dp);

/** a + b, or null when neither is entered (MMIS-T5 / T6). */
const pair = (a: Prisma.Decimal | null, b: Prisma.Decimal | null): string | null =>
  a === null && b === null ? null : sumDecimals([fixed(a, 2), fixed(b, 2)], 2);

const listSelect = {
  id: true,
  plantId: true,
  month: true,
  status: true,
  ebUnits: true,
  dgUnits: true,
  dieselDg: true,
  dieselFireEngine: true,
  summarySnapshot: true,
  enteredById: true,
  updatedAt: true,
  plant: { select: { id: true, name: true, code: true } },
} as const satisfies Prisma.MonthlyMisSelect;
type ListRecord = Prisma.MonthlyMisGetPayload<{ select: typeof listSelect }>;

const dailySelect = {
  plantId: true,
  ...Object.fromEntries(SUMMARY_DAILY_KEYS.map((k) => [k, true])),
} as Prisma.DailyMisSelect;

interface Locked {
  id: string;
  plantId: string;
  month: string;
  status: ReportStatus;
  version: number;
}

interface Summarised {
  items: CumulativeDailySummary;
  approvedDays: number;
}

/**
 * Monthly MIS (spec “Monthly MIS”). Section A (items 1–25) is never typed: it is computed from the
 * APPROVED Daily MIS rows of the same plant + month (MMIS-R4) and frozen into `summary_snapshot`
 * when the Monthly MIS is approved; a reopen clears the snapshot so it is live again (D-94).
 * One row per plant + month (BEV-4, D-31). Same Approve / Return / Reopen flow as Daily MIS.
 */
@Injectable()
export class MonthlyMisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly notices: NotificationsService,
  ) {}

  /** Event 3 for this month (in the transition's transaction). */
  private async decided(
    tx: Tx,
    access: ResolvedAccess,
    id: string,
    decision: 'Approved' | 'Returned',
    reason?: string,
  ): Promise<void> {
    const r = await tx.monthlyMis.findUniqueOrThrow({
      where: { id },
      select: { plantId: true, month: true, enteredById: true },
    });
    await this.notices.reportDecided(tx, {
      what: 'Monthly MIS',
      entity: 'monthly_mis',
      id,
      plantId: r.plantId,
      period: formatMonthYear(monthKey(r.month)),
      enteredById: r.enteredById,
      deciderId: access.userId,
      decision,
      ...(reason ? { reason } : {}),
    });
  }

  private asActor<T>(access: ResolvedAccess, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, fn);
  }

  monthOf(f: MonthlyMisFilter): string {
    return f.month ?? defaultMonth();
  }

  /** The one query object behind the table AND its download (BEV-6). */
  private where(
    scope: PlantScope,
    f: MonthlyMisFilter,
    withStatus: boolean,
  ): Prisma.MonthlyMisWhereInput {
    return {
      ...(scope.all ? {} : { plantId: { in: scope.plantIds } }),
      ...(f.month ? { month: monthDate(f.month) } : {}),
      plant: { deletedAt: null },
      ...(withStatus && f.status ? { status: f.status } : {}),
    };
  }

  private async names(tx: Tx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((i): i is string => i !== null))];
    if (unique.length === 0) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  /** Items 1–25 from the Approved Daily rows of each plant in one month (one query). */
  private async liveSummaries(
    tx: Tx,
    plantIds: readonly string[],
    month: string,
  ): Promise<Map<string, Summarised>> {
    const out = new Map<string, Summarised>();
    if (plantIds.length === 0) return out;
    const rows = await tx.dailyMis.findMany({
      where: {
        plantId: { in: [...plantIds] },
        status: 'APPROVED',
        reportDate: { gte: dateOf(firstDayOfMonth(month)), lte: dateOf(lastDayOfMonth(month)) },
      },
      select: dailySelect,
    });
    for (const id of new Set(plantIds)) {
      const mine = rows.filter((r) => Reflect.get(r, 'plantId') === id);
      out.set(id, { items: summaryOf(mine), approvedDays: mine.length });
    }
    return out;
  }

  /** Items 1–25 from the Approved Daily rows of each plant + month in records (one query). */
  private async liveSummariesForRecords(
    tx: Tx,
    records: readonly { plantId: string; month: Date }[],
  ): Promise<Map<string, Summarised>> {
    const out = new Map<string, Summarised>();
    if (records.length === 0) return out;
    const plantIds = [...new Set(records.map((r) => r.plantId))];
    const months = [...new Set(records.map((r) => monthKey(r.month)))].sort();
    const firstMonth = months[0];
    const lastMonth = months[months.length - 1];
    if (!firstMonth || !lastMonth) return out;
    const rows = await tx.dailyMis.findMany({
      where: {
        plantId: { in: plantIds },
        status: 'APPROVED',
        reportDate: {
          gte: dateOf(firstDayOfMonth(firstMonth)),
          lte: dateOf(lastDayOfMonth(lastMonth)),
        },
      },
      select: {
        plantId: true,
        reportDate: true,
        ...Object.fromEntries(SUMMARY_DAILY_KEYS.map((k) => [k, true])),
      },
    });

    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.plantId}:${monthKey(row.reportDate)}`;
      const list = grouped.get(key);
      if (list) {
        list.push(row);
      } else {
        grouped.set(key, [row]);
      }
    }

    for (const r of records) {
      const key = `${r.plantId}:${monthKey(r.month)}`;
      if (!out.has(key)) {
        const mine = grouped.get(key) ?? [];
        out.set(key, { items: summaryOf(mine), approvedDays: mine.length });
      }
    }
    return out;
  }

  /** Frozen figures for an Approved row with a snapshot; live figures otherwise. */
  private summaryFor(
    r: { status: ReportStatus; summarySnapshot: Prisma.JsonValue; plantId: string; month: Date },
    live: Map<string, Summarised>,
  ): Summarised & { frozen: boolean } {
    const key = `${r.plantId}:${monthKey(r.month)}`;
    const live1 = live.get(key) ?? live.get(r.plantId) ?? { items: summaryOf([]), approvedDays: 0 };
    const frozen = r.status === 'APPROVED' ? summaryFromJson(r.summarySnapshot) : null;
    if (!frozen) return { ...live1, frozen: false };
    const days: unknown =
      r.summarySnapshot !== null && typeof r.summarySnapshot === 'object'
        ? Reflect.get(r.summarySnapshot, 'approvedDays')
        : undefined;
    return {
      items: frozen,
      approvedDays: typeof days === 'number' ? days : live1.approvedDays,
      frozen: true,
    };
  }

  private toListRow(r: ListRecord, s: Summarised, names: Map<string, string>): MonthlyMisListRow {
    return {
      id: r.id,
      plant: r.plant,
      month: monthKey(r.month),
      totalProduction: s.items.totalProduction,
      totalShifts: Number(s.items.totalShifts),
      electricityUnits: pair(r.ebUnits, r.dgUnits),
      dieselConsumed: pair(r.dieselDg, r.dieselFireEngine),
      cylinderDespatches: s.items.totalCylinderDespatch,
      ttLoading: s.items.totalTtLoading,
      status: r.status,
      enteredBy: names.get(r.enteredById) ?? '—',
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  /** Every row of the filter with its summary figures, plant A–Z (bounded: one row per plant). */
  private async filterRows(
    tx: Tx,
    scope: PlantScope,
    f: MonthlyMisFilter,
  ): Promise<{ rows: MonthlyMisListRow[]; totals: MonthlyMisTotals }> {
    const records = await tx.monthlyMis.findMany({
      where: this.where(scope, f, true),
      select: listSelect,
      orderBy: [{ month: 'desc' }, { plant: { name: 'asc' } }],
    });
    const live = await this.liveSummariesForRecords(tx, records);
    const names = await this.names(
      tx,
      records.map((r) => r.enteredById),
    );
    const rows = records.map((r) => this.toListRow(r, this.summaryFor(r, live), names));
    return { rows, totals: totalsOf(rows) };
  }

  /** CARD-3 “Not started”: plants in scope running that month with no Monthly MIS row (D-18). */
  private async notStarted(tx: Tx, scope: PlantScope, month?: string): Promise<number> {
    if (!scope.all && scope.plantIds.length === 0) return 0;
    const targetMonth = month ?? defaultMonth();
    return tx.plant.count({
      where: {
        deletedAt: null,
        ...(scope.all ? {} : { id: { in: scope.plantIds } }),
        // WORKING plants from their start; a past contract end means an extension (D-15).
        status: 'WORKING',
        startDate: { lte: dateOf(lastDayOfMonth(targetMonth)) },
        monthlyMis: { none: { month: monthDate(targetMonth) } },
      },
    });
  }

  async list(access: ResolvedAccess, q: MonthlyMisQuery): Promise<MonthlyMisPage> {
    const scope = plantFilter(access, q.plantId, NEED.view);
    const month = this.monthOf(q);
    return this.asActor(access, async (tx) => {
      const { rows, totals } = await this.filterRows(tx, scope, q);
      const byStatus = await tx.monthlyMis.groupBy({
        by: ['status'],
        where: this.where(scope, q, false),
        _count: { _all: true },
      });
      const count = (s: ReportStatus): number =>
        byStatus.find((b) => b.status === s)?._count._all ?? 0;
      const cards: MonthlyMisCards = {
        pending: count('PENDING'),
        approved: count('APPROVED'),
        returned: count('RETURNED'),
        draft: count('DRAFT'),
        notStarted: await this.notStarted(tx, scope, q.month),
      };
      const start = (q.page - 1) * q.pageSize;
      return {
        rows: rows.slice(start, start + q.pageSize),
        total: rows.length,
        page: q.page,
        pageSize: q.pageSize,
        month,
        cards,
        totals,
      };
    });
  }

  /** Every row of the filter + its totals, for a download (same query as the table). */
  async exportRows(
    access: ResolvedAccess,
    f: MonthlyMisFilter,
  ): Promise<{
    rows: MonthlyMisListRow[];
    totals: MonthlyMisTotals;
    month: string;
    plantName: string | null;
  }> {
    const scope = plantFilter(access, f.plantId, NEED.download);
    return this.asActor(access, async (tx) => {
      const { rows, totals } = await this.filterRows(tx, scope, f);
      const plant = f.plantId
        ? await tx.plant.findUnique({ where: { id: f.plantId }, select: { name: true } })
        : null;
      return { rows, totals, month: this.monthOf(f), plantName: plant?.name ?? null };
    });
  }

  /** Live Section A for the new form (before the first save): plant scope checked first. */
  async summary(
    access: ResolvedAccess,
    plantId: string,
    month: string,
  ): Promise<MonthlySummaryView> {
    assertPlant(access, plantId, NEED.view);
    return this.asActor(access, async (tx) => {
      await this.plantExists(tx, plantId);
      const s = (await this.liveSummaries(tx, [plantId], month)).get(plantId);
      return {
        items: s?.items ?? summaryOf([]),
        approvedDays: s?.approvedDays ?? 0,
        daysInMonth: daysInMonth(month),
        frozen: false,
      };
    });
  }

  async get(access: ResolvedAccess, id: string): Promise<MonthlyMisDetail> {
    return this.asActor(access, (tx) => this.detail(tx, access, id));
  }

  private async detail(tx: Tx, access: ResolvedAccess, id: string): Promise<MonthlyMisDetail> {
    const r = await tx.monthlyMis.findUnique({
      where: { id },
      include: {
        plant: { select: { id: true, name: true, code: true, deletedAt: true } },
        cylinderStats: { select: { category: true, size: true, quantity: true } },
        inventoryItems: { select: { item: true, quantity: true } },
      },
    });
    if (!r || r.plant.deletedAt !== null) throw notFound();
    assertPlant(access, r.plantId, NEED.view);
    const month = monthKey(r.month);
    const s = this.summaryFor(r, await this.liveSummaries(tx, [r.plantId], month));
    const names = await this.names(tx, [
      r.enteredById,
      r.lastModifiedById,
      r.approvedById,
      r.returnedById,
      r.reopenedById,
    ]);
    const ref = (userId: string | null): PersonRef | null =>
      userId === null ? null : { id: userId, name: names.get(userId) ?? '—' };
    const stamp = (d: Date | null): string | null => d?.toISOString() ?? null;
    const status = r.status;
    return {
      id: r.id,
      version: r.version,
      plant: { id: r.plant.id, name: r.plant.name, code: r.plant.code },
      month,
      status,
      summary: {
        items: s.items,
        approvedDays: s.approvedDays,
        daysInMonth: daysInMonth(month),
        frozen: s.frozen,
      },
      values: valuesFromRecord(r),
      trainingTotal: r.trainingTotal,
      cylinders: gridFromRows(r.cylinderStats),
      inventory: inventoryFromRows(r.inventoryItems),
      enteredBy: ref(r.enteredById) ?? { id: r.enteredById, name: '—' },
      lastModifiedBy: ref(r.lastModifiedById),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      submittedAt: stamp(r.submittedAt),
      approvedBy: ref(r.approvedById),
      approvedAt: stamp(r.approvedAt),
      returnedBy: ref(r.returnedById),
      returnedAt: stamp(r.returnedAt),
      returnReason: r.returnReason,
      reopenedBy: ref(r.reopenedById),
      reopenedAt: stamp(r.reopenedAt),
      reopenReason: r.reopenReason,
      waitingHours: waiting(r.createdAt, r.approvedAt ?? new Date()),
      can: {
        edit: status !== 'APPROVED' && canOnPlant(access, r.plantId, NEED.submit),
        approve: status === 'PENDING' && canOnPlant(access, r.plantId, NEED.approve),
        return: status === 'PENDING' && canOnPlant(access, r.plantId, NEED.return),
        reopen: status === 'APPROVED' && canOnPlant(access, r.plantId, NEED.reopen),
        download: canOnPlant(access, r.plantId, NEED.download),
      },
    };
  }

  private async plantExists(tx: Tx, plantId: string): Promise<void> {
    const p = await tx.plant.findFirst({
      where: { id: plantId, deletedAt: null },
      select: { id: true },
    });
    if (!p) throw forbidden('You do not have access to this plant.');
  }

  private uniqueViolation(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw conflict(MONTHLY_MIS_MESSAGES.alreadyExists);
    throw e;
  }

  /** Replace the cylinder grid (70–104) and inventory (105–121) child rows. */
  private async writeChildren(tx: Tx, id: string, input: MonthlyMisSaveInput): Promise<void> {
    await tx.monthlyCylinderStat.deleteMany({ where: { monthlyMisId: id } });
    await tx.monthlyInventoryItem.deleteMany({ where: { monthlyMisId: id } });
    const cells = gridRows(input.cylinders);
    if (cells.length > 0)
      await tx.monthlyCylinderStat.createMany({
        data: cells.map((c) => ({ ...c, monthlyMisId: id })),
      });
    const items = inventoryRows(input.inventory);
    if (items.length > 0)
      await tx.monthlyInventoryItem.createMany({
        data: items.map((i) => ({ ...i, monthlyMisId: id })),
      });
  }

  /** Save draft / Submit for approval on a new row (MMIS-R1). One row per plant + month (D-31). */
  async create(
    access: ResolvedAccess,
    input: MonthlyMisSaveInput,
    ctx: RequestContext,
  ): Promise<MonthlyMisDetail> {
    assertPlant(access, input.plantId, NEED.submit);
    const data = recordData(completeValues(input.values));
    const submit = input.action === 'submit';
    try {
      return await this.asActor(access, async (tx) => {
        await this.plantExists(tx, input.plantId);
        const exists = await tx.monthlyMis.count({
          where: { plantId: input.plantId, month: monthDate(input.month) },
        });
        if (exists > 0) throw conflict(MONTHLY_MIS_MESSAGES.alreadyExists);
        const status: ReportStatus = submit ? 'PENDING' : 'DRAFT';
        const row = await tx.monthlyMis.create({
          data: {
            ...(data as Omit<
              Prisma.MonthlyMisUncheckedCreateInput,
              'plantId' | 'month' | 'enteredById'
            >),
            plantId: input.plantId,
            month: monthDate(input.month),
            status,
            enteredById: access.userId,
            lastModifiedById: access.userId,
            submittedAt: submit ? new Date() : null,
          },
          select: { id: true, plantId: true },
        });
        await this.writeChildren(tx, row.id, input);
        await this.audit.record(
          {
            action: submit ? AuditAction.SUBMIT : AuditAction.CREATE,
            entity: 'monthly_mis',
            entityId: row.id,
            plantId: row.plantId,
            actorId: access.userId,
            after: { month: input.month, status },
            ctx,
          },
          tx,
        );
        if (submit)
          await this.notices.reportSubmitted(tx, {
            what: 'Monthly MIS',
            entity: 'monthly_mis',
            id: row.id,
            plantId: row.plantId,
            period: formatMonthYear(input.month),
            senderId: access.userId,
          });
        return this.detail(tx, access, row.id);
      });
    } catch (e: unknown) {
      return this.uniqueViolation(e);
    }
  }

  private async lock(tx: Tx, id: string): Promise<Locked> {
    const rows = await tx.$queryRaw<
      { id: string; plant_id: string; month: Date; status: ReportStatus; version: number }[]
    >`SELECT id, plant_id, month, status, version FROM monthly_mis WHERE id = ${id}::uuid FOR UPDATE`;
    const r = rows[0];
    if (!r) throw notFound();
    return {
      id: r.id,
      plantId: r.plant_id,
      month: monthKey(r.month),
      status: r.status,
      version: r.version,
    };
  }

  private checkVersion(row: Locked, version: number | undefined): void {
    if (version === undefined || row.version !== version)
      throw conflict(MONTHLY_MIS_MESSAGES.stale);
  }

  /**
   * Edit a Draft / Pending / Returned row — the same rules as Daily MIS (D-29, D-32, D-85):
   * Save keeps the status (Draft / Pending / Returned); Submit → Pending; Approved is locked.
   * Plant and month may change only while Draft.
   */
  async update(
    access: ResolvedAccess,
    id: string,
    input: MonthlyMisSaveInput,
    ctx: RequestContext,
  ): Promise<MonthlyMisDetail> {
    const data = recordData(completeValues(input.values));
    const submit = input.action === 'submit';
    try {
      return await this.asActor(access, async (tx) => {
        const row = await this.lock(tx, id);
        assertPlant(access, row.plantId, NEED.submit);
        if (row.status === 'APPROVED') throw conflict(MONTHLY_MIS_MESSAGES.locked);
        this.checkVersion(row, input.version);
        const moved = row.plantId !== input.plantId || row.month !== input.month;
        if (moved) {
          if (row.status !== 'DRAFT')
            throw new AppError(
              HttpStatus.BAD_REQUEST,
              ErrorCode.VALIDATION_FAILED,
              'Some fields are not valid.',
              [{ path: 'month', message: MONTHLY_MIS_MESSAGES.plantMonthFixed }],
            );
          assertPlant(access, input.plantId, NEED.submit);
          await this.plantExists(tx, input.plantId);
        }
        const next: ReportStatus = submit ? 'PENDING' : row.status;
        const updated = await tx.monthlyMis.update({
          where: { id },
          data: {
            ...(data as Prisma.MonthlyMisUncheckedUpdateInput),
            plantId: input.plantId,
            month: monthDate(input.month),
            status: next,
            lastModifiedById: access.userId,
            version: { increment: 1 },
            ...(submit ? { submittedAt: new Date() } : {}),
          },
          select: { plantId: true, version: true },
        });
        await this.writeChildren(tx, id, input);
        await this.audit.record(
          {
            action: submit ? AuditAction.SUBMIT : AuditAction.UPDATE,
            entity: 'monthly_mis',
            entityId: id,
            plantId: updated.plantId,
            actorId: access.userId,
            before: { status: row.status, version: row.version },
            after: { status: next, version: updated.version },
            ctx,
          },
          tx,
        );
        if (submit && row.status !== 'PENDING')
          await this.notices.reportSubmitted(tx, {
            what: 'Monthly MIS',
            entity: 'monthly_mis',
            id,
            plantId: updated.plantId,
            period: formatMonthYear(input.month),
            senderId: access.userId,
          });
        return this.detail(tx, access, id);
      });
    } catch (e: unknown) {
      return this.uniqueViolation(e);
    }
  }

  /** Approve → Approved and locked; Section A is frozen in the same transaction (MMIS-R4). */
  async approve(
    access: ResolvedAccess,
    id: string,
    version: number,
    ctx: RequestContext,
  ): Promise<MonthlyMisDetail> {
    return this.asActor(access, async (tx) => {
      const row = await this.lock(tx, id);
      assertPlant(access, row.plantId, NEED.approve);
      if (row.status !== 'PENDING') throw conflict(MONTHLY_MIS_MESSAGES.notPending);
      this.checkVersion(row, version);
      const s = (await this.liveSummaries(tx, [row.plantId], row.month)).get(row.plantId);
      const snapshot = { ...(s?.items ?? summaryOf([])), approvedDays: s?.approvedDays ?? 0 };
      await tx.monthlyMis.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedById: access.userId,
          approvedAt: new Date(),
          summarySnapshot: snapshot,
          version: { increment: 1 },
        },
      });
      await this.audit.record(
        {
          action: AuditAction.APPROVE,
          entity: 'monthly_mis',
          entityId: id,
          plantId: row.plantId,
          actorId: access.userId,
          before: { status: 'PENDING' },
          after: { status: 'APPROVED', summary: snapshot },
          ctx,
        },
        tx,
      );
      await this.decided(tx, access, id, 'Approved');
      return this.detail(tx, access, id);
    });
  }

  /** Return → Returned with a mandatory reason (APPR-3, UXV-8). */
  async returnRow(
    access: ResolvedAccess,
    id: string,
    version: number,
    reason: string,
    ctx: RequestContext,
  ): Promise<MonthlyMisDetail> {
    return this.asActor(access, async (tx) => {
      const row = await this.lock(tx, id);
      assertPlant(access, row.plantId, NEED.return);
      if (row.status !== 'PENDING') throw conflict(MONTHLY_MIS_MESSAGES.notPending);
      this.checkVersion(row, version);
      await tx.monthlyMis.update({
        where: { id },
        data: {
          status: 'RETURNED',
          returnedById: access.userId,
          returnedAt: new Date(),
          returnReason: reason,
          version: { increment: 1 },
        },
      });
      await this.audit.record(
        {
          action: AuditAction.RETURN,
          entity: 'monthly_mis',
          entityId: id,
          plantId: row.plantId,
          actorId: access.userId,
          before: { status: 'PENDING' },
          after: { status: 'RETURNED' },
          reason,
          ctx,
        },
        tx,
      );
      await this.decided(tx, access, id, 'Returned', reason);
      return this.detail(tx, access, id);
    });
  }

  /** Reopen an Approved row: reason mandatory; back to Pending, snapshot cleared (D-86, D-94). */
  async reopen(
    access: ResolvedAccess,
    id: string,
    version: number,
    reason: string,
    ctx: RequestContext,
  ): Promise<MonthlyMisDetail> {
    return this.asActor(access, async (tx) => {
      const row = await this.lock(tx, id);
      assertPlant(access, row.plantId, NEED.reopen);
      if (row.status !== 'APPROVED') throw conflict(MONTHLY_MIS_MESSAGES.notApproved);
      this.checkVersion(row, version);
      await tx.monthlyMis.update({
        where: { id },
        data: {
          status: 'PENDING',
          approvedById: null,
          approvedAt: null,
          summarySnapshot: Prisma.DbNull,
          reopenedById: access.userId,
          reopenedAt: new Date(),
          reopenReason: reason,
          version: { increment: 1 },
        },
      });
      await this.audit.record(
        {
          action: AuditAction.REOPEN,
          entity: 'monthly_mis',
          entityId: id,
          plantId: row.plantId,
          actorId: access.userId,
          before: { status: 'APPROVED' },
          after: { status: 'PENDING' },
          reason,
          ctx,
        },
        tx,
      );
      return this.detail(tx, access, id);
    });
  }

  /** Approval queue (APPR-Q1): Pending Monthly rows the person may approve, oldest first. */
  async queue(access: ResolvedAccess, plantId: string | undefined): Promise<ApprovalQueueItem[]> {
    const scope = plantFilter(access, plantId, NEED.approve);
    return this.asActor(access, async (tx) => {
      const rows = await tx.monthlyMis.findMany({
        where: {
          status: 'PENDING',
          plant: { deletedAt: null },
          ...(scope.all ? {} : { plantId: { in: scope.plantIds } }),
        },
        select: {
          id: true,
          month: true,
          enteredById: true,
          updatedAt: true,
          createdAt: true,
          version: true,
          plant: { select: { id: true, name: true, code: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 500,
      });
      const names = await this.names(
        tx,
        rows.map((r) => r.enteredById),
      );
      const now = new Date();
      return rows.map((r) => ({
        id: r.id,
        module: MODULE,
        plant: r.plant,
        period: monthKey(r.month),
        enteredBy: names.get(r.enteredById) ?? '—',
        lastSavedAt: r.updatedAt.toISOString(),
        waitingHours: waiting(r.createdAt, now),
        version: r.version,
      }));
    });
  }
}

export function daysInMonth(month: string): number {
  return daysBetween(firstDayOfMonth(month), lastDayOfMonth(month)) + 1;
}

/** Footer / download totals: Σ of the rows (blank cells count as 0). */
export function totalsOf(rows: readonly MonthlyMisListRow[]): MonthlyMisTotals {
  return {
    rows: rows.length,
    totalProduction: sumDecimals(
      rows.map((r) => r.totalProduction),
      3,
    ),
    totalShifts: rows.reduce((a, r) => a + r.totalShifts, 0),
    electricityUnits: sumDecimals(
      rows.map((r) => r.electricityUnits),
      2,
    ),
    dieselConsumed: sumDecimals(
      rows.map((r) => r.dieselConsumed),
      2,
    ),
    cylinderDespatches: sumDecimals(
      rows.map((r) => r.cylinderDespatches),
      3,
    ),
    ttLoading: sumDecimals(
      rows.map((r) => r.ttLoading),
      3,
    ),
  };
}
