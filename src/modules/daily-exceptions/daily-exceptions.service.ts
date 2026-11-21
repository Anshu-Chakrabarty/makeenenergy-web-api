import { HttpStatus, Injectable } from '@nestjs/common';
import { forbidden } from '../../common/access/access.guard';
import {
  assertPlant,
  canOnPlant,
  plantFilter,
  type PlantNeed,
  type PlantScope,
} from '../../common/access/plant-scope';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/security/request-context';
import { Prisma } from '../../generated/prisma/client';
import {
  DAILY_EXCEPTION_MESSAGES,
  addDays,
  cleanLines,
  exceptionSaveSchema,
  exceptionStatus,
  formExceptions,
  financialYearOf,
  financialYearRange,
  firstDayOfMonth,
  formatDate,
  formatMonthYear,
  istToday,
  monthOf,
  type DailyExceptionBody,
  type DailyExceptionCards,
  type DailyExceptionDetail,
  type DailyExceptionFilter,
  type DailyExceptionListRow,
  type DailyExceptionPage,
  type DailyExceptionQuery,
  type DailyExceptionSaveInput,
  type ExceptionDetailDef,
  type ExceptionDetailValue,
  type ExceptionLineDef,
  type FormException,
  type ExceptionLines,
  type ExceptionRowStatus,
  type ExceptionStatus,
  type LapseCounts,
  type LapseNoteInput,
  type PersonRef,
} from '../../shared';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { ResolvedAccess } from '../access/access.service';
import {
  AttachmentsService,
  type IncomingFile,
  type StoredFile,
} from '../attachments/attachments.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { keyHash } from '../notifications/daily-notices';
import { NotificationsService } from '../notifications/notifications.service';

const MODULE = 'DAILY_EXCEPTIONS' as const;
const NEED = {
  view: { module: MODULE, capability: 'VIEW' },
  submit: { module: MODULE, capability: 'SUBMIT' },
  download: { module: MODULE, capability: 'DOWNLOAD' },
} as const satisfies Record<string, PlantNeed>;

/** Most rows one download may hold (≈ 22 plants × 366 days, with room). */
export const EXPORT_MAX_ROWS = 20_000;

const err = (status: HttpStatus, code: string, message: string): AppError =>
  new AppError(status, code, message);
const notFound = (): AppError =>
  err(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, DAILY_EXCEPTION_MESSAGES.notFound);
const conflict = (message: string): AppError =>
  err(HttpStatus.CONFLICT, ErrorCode.CONFLICT, message);

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const dateOf = (v: string): Date => new Date(`${v}T00:00:00.000Z`);

interface RawRow {
  plant_id: string;
  plant_name: string;
  plant_code: string;
  day: Date;
  id: string | null;
  status: ExceptionRowStatus;
  problem_highlight: string | null;
  entered_by_id: string | null;
  updated_at: Date | null;
  note: string | null;
}

interface Locked {
  id: string;
  plantId: string;
  reportDate: string;
  status: ExceptionStatus;
  version: number;
}

/**
 * Daily Exceptions (spec “Daily Exceptions — table / form”). No Approve / Return (APPR-6): the
 * status follows the answers (DEX-S1…S3). “Not initiated” is never stored — it is every
 * plant-day with no row, from `generate_series` (DEX-S4, D-21). Plant scope is checked on the
 * role of THAT plant and again by row-level security.
 */
@Injectable()
export class DailyExceptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly files: AttachmentsService,
    private readonly notices: NotificationsService,
  ) {}

  /**
   * Events 1 and 2 (D-33): a Pending report notifies the Plant Manager of its problem — again
   * whenever the highlight changes, never twice for the same one; a Completed submit notifies
   * once. A Partial (Save draft) sends nothing.
   */
  private async announce(
    tx: Tx,
    access: ResolvedAccess,
    id: string,
    plantId: string,
    reportDate: string,
    c: { status: ExceptionStatus; highlight: string | null },
  ): Promise<void> {
    if (c.status === 'PENDING' && c.highlight) {
      const plant = await tx.plant.findUnique({ where: { id: plantId }, select: { name: true } });
      const name = plant?.name ?? 'the plant';
      await this.notices.notify(tx, {
        category: 'SYSTEM',
        event: 'EXCEPTION_RAISED',
        title: `Exception — ${name}: ${c.highlight}`.slice(0, 200),
        body: `Daily Exception for ${name}, ${formatDate(reportDate)}: ${c.highlight}`,
        senderId: access.userId,
        plantId,
        link: { entity: 'daily_exception', id },
        recipients: await this.notices.plantManagers(tx, plantId),
        canAcknowledge: true,
        dedupeKey: `exception-raised:${id}:${keyHash(c.highlight)}`,
        sentTo: `Plant Manager, ${name}`,
      });
    } else if (c.status === 'COMPLETED') {
      await this.notices.reportSubmitted(tx, {
        what: 'Daily Exception',
        entity: 'daily_exception',
        id,
        plantId,
        period: formatDate(reportDate),
        senderId: access.userId,
        detail: 'All 13 lines No, plant Operational.',
        dedupeKey: `exception-submitted:${id}`,
      });
    }
  }

  private asActor<T>(access: ResolvedAccess, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, fn);
  }

  /** Default range: today (India time), as on the mockup (16-10-2026 to 16-10-2026). */
  range(f: DailyExceptionFilter): { from: string; to: string } {
    const today = istToday();
    const to = f.to ?? (f.from && f.from > today ? f.from : today);
    const from = f.from ?? (to < today ? to : today);
    return { from, to };
  }

  private ids(scope: PlantScope): string[] | null {
    return scope.all ? null : scope.plantIds;
  }

  /**
   * Every plant-day of the range (up to today) for WORKING plants from their start date, with its
   * report, if any. The contract end date does not stop it: a WORKING plant past its end date is
   * running on an extension (extensions are stored, never added to the end date — D-15).
   */
  private rowsSql(scope: PlantScope, from: string, to: string): Prisma.Sql {
    const end = to < istToday() ? to : istToday();
    const ids = this.ids(scope);
    return Prisma.sql`
      SELECT p.id AS plant_id, p.name::text AS plant_name, p.code::text AS plant_code, d.day::date AS day,
             e.id, COALESCE(e.status::text, 'NOT_INITIATED') AS status, e.problem_highlight,
             e.entered_by_id, e.updated_at, n.note
        FROM plants p
        CROSS JOIN LATERAL generate_series(GREATEST(${from}::date, p.start_date), ${end}::date,
                                           interval '1 day') AS d(day)
        LEFT JOIN daily_exceptions e ON e.plant_id = p.id AND e.report_date = d.day::date
        LEFT JOIN lapse_notes n ON n.plant_id = p.id AND n.date = d.day::date AND e.id IS NULL
       WHERE p.deleted_at IS NULL AND p.status = 'WORKING'
         AND (${ids}::uuid[] IS NULL OR p.id = ANY(${ids}::uuid[]))`;
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

  private toRow(r: RawRow, names: Map<string, string>): DailyExceptionListRow {
    return {
      id: r.id,
      plant: { id: r.plant_id, name: r.plant_name, code: r.plant_code },
      reportDate: iso(r.day),
      problemHighlight: r.problem_highlight,
      status: r.status,
      enteredBy: r.entered_by_id ? (names.get(r.entered_by_id) ?? '—') : null,
      updatedAt: r.updated_at?.toISOString() ?? null,
      lapseNote: r.note,
    };
  }

  private async page(
    tx: Tx,
    scope: PlantScope,
    f: DailyExceptionFilter,
    limit: number,
    offset: number,
  ): Promise<{ rows: DailyExceptionListRow[]; total: number; cards: DailyExceptionCards }> {
    const { from, to } = this.range(f);
    const base = this.rowsSql(scope, from, to);
    const status = f.status ?? null;
    const counts = await tx.$queryRaw<{ status: ExceptionRowStatus; n: number }[]>`
      SELECT status, count(*)::int AS n FROM (${base}) r GROUP BY status`;
    const n = (s: ExceptionRowStatus): number => counts.find((c) => c.status === s)?.n ?? 0;
    const raw = await tx.$queryRaw<RawRow[]>`
      SELECT * FROM (${base}) r
       WHERE (${status}::text IS NULL OR r.status = ${status}::text)
       ORDER BY r.day DESC,
                CASE r.status WHEN 'PENDING' THEN 0 WHEN 'PARTIAL' THEN 1 WHEN 'NOT_INITIATED' THEN 2 ELSE 3 END,
                r.plant_name ASC
       LIMIT ${limit} OFFSET ${offset}`;
    const names = await this.names(
      tx,
      raw.map((r) => r.entered_by_id),
    );
    return {
      rows: raw.map((r) => this.toRow(r, names)),
      total: status ? n(status) : counts.reduce((a, c) => a + c.n, 0),
      cards: {
        completed: n('COMPLETED'),
        submitted: n('COMPLETED') + n('PENDING'),
        pending: n('PENDING'),
        partial: n('PARTIAL'),
        notInitiated: n('NOT_INITIATED'),
      },
    };
  }

  /** Go-live date for Lapse (app setting `lapse.startDate`, D-21); null = each plant's start. */
  private async lapseStart(tx: Tx): Promise<string | null> {
    const s = await tx.appSetting.findUnique({ where: { key: 'lapse.startDate' } });
    return typeof s?.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.value) ? s.value : null;
  }

  private async notInitiatedDays(
    tx: Tx,
    scope: PlantScope,
    from: string,
    to: string,
  ): Promise<number> {
    if (to < from) return 0;
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (${this.rowsSql(scope, from, to)}) r
       WHERE r.status = 'NOT_INITIATED'`;
    return rows[0]?.n ?? 0;
  }

  /** Lapse (DEX-S6, D-21): today's missing plants; month and FY days up to yesterday. */
  private async lapse(tx: Tx, scope: PlantScope): Promise<LapseCounts> {
    const today = istToday();
    const yesterday = addDays(today, -1);
    const start = await this.lapseStart(tx);
    const from = (d: string): string => (start && start > d ? start : d);
    const fy = financialYearOf(today);
    return {
      today: await this.notInitiatedDays(tx, scope, today, today),
      month: {
        label: formatMonthYear(monthOf(today)),
        days: await this.notInitiatedDays(
          tx,
          scope,
          from(firstDayOfMonth(monthOf(today))),
          yesterday,
        ),
      },
      fy: {
        label: `FY ${fy}`,
        days: await this.notInitiatedDays(tx, scope, from(financialYearRange(fy).start), yesterday),
      },
    };
  }

  async list(access: ResolvedAccess, q: DailyExceptionQuery): Promise<DailyExceptionPage> {
    const scope = plantFilter(access, q.plantId, NEED.view);
    const { from, to } = this.range(q);
    return this.asActor(access, async (tx) => {
      const p = await this.page(tx, scope, q, q.pageSize, (q.page - 1) * q.pageSize);
      return {
        rows: p.rows,
        total: p.total,
        page: q.page,
        pageSize: q.pageSize,
        from,
        to,
        cards: p.cards,
        lapse: await this.lapse(tx, scope),
      };
    });
  }

  /** Every row of the filter, for a download (the same query as the table). */
  async exportRows(
    access: ResolvedAccess,
    f: DailyExceptionFilter,
  ): Promise<{
    rows: DailyExceptionListRow[];
    cards: DailyExceptionCards;
    from: string;
    to: string;
    plantName: string | null;
  }> {
    const scope = plantFilter(access, f.plantId, NEED.download);
    const { from, to } = this.range(f);
    return this.asActor(access, async (tx) => {
      const p = await this.page(tx, scope, f, EXPORT_MAX_ROWS + 1, 0);
      if (p.rows.length > EXPORT_MAX_ROWS) {
        throw new AppError(
          HttpStatus.PAYLOAD_TOO_LARGE,
          ErrorCode.PAYLOAD_TOO_LARGE,
          'Too many rows for one download. Choose a shorter date range or one plant.',
        );
      }
      const plant = f.plantId
        ? await tx.plant.findUnique({ where: { id: f.plantId }, select: { name: true } })
        : null;
      return { rows: p.rows, cards: p.cards, from, to, plantName: plant?.name ?? null };
    });
  }

  async get(access: ResolvedAccess, id: string): Promise<DailyExceptionDetail> {
    return this.asActor(access, (tx) => this.detail(tx, access, id));
  }

  private async detail(tx: Tx, access: ResolvedAccess, id: string): Promise<DailyExceptionDetail> {
    const r = await tx.dailyException.findUnique({
      where: { id },
      include: {
        plant: { select: { id: true, name: true, code: true, deletedAt: true } },
        lines: { orderBy: { lineNo: 'asc' } },
      },
    });
    if (!r || r.plant.deletedAt !== null) throw notFound();
    assertPlant(access, r.plantId, NEED.view);
    const names = await this.names(tx, [r.enteredById, r.lastModifiedById]);
    const ref = (userId: string | null): PersonRef | null =>
      userId === null ? null : { id: userId, name: names.get(userId) ?? '—' };
    const defs = await this.catalog(tx);
    const lines: ExceptionLines = {};
    for (const def of defs) {
      const l = r.lines.find((x) => x.lineNo === def.lineNo);
      lines[String(def.lineNo)] = {
        answer: l?.answer ?? null,
        details:
          l && l.details !== null && typeof l.details === 'object' && !Array.isArray(l.details)
            ? (l.details as Record<string, ExceptionDetailValue>)
            : {},
      };
    }
    const canSubmit = canOnPlant(access, r.plantId, NEED.submit);
    return {
      id: r.id,
      version: r.version,
      plant: { id: r.plant.id, name: r.plant.name, code: r.plant.code },
      reportDate: iso(r.reportDate),
      plantStatus: r.plantStatus,
      status: r.status,
      problemHighlight: r.problemHighlight,
      legacyFileName: r.legacyFileName,
      lines,
      attachments: await this.files.list(tx, 'DAILY_EXCEPTION', r.id),
      enteredBy: ref(r.enteredById) ?? { id: r.enteredById, name: '—' },
      lastModifiedBy: ref(r.lastModifiedById),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      can: {
        edit: canSubmit,
        upload: canSubmit,
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

  /** The Daily Exception form. Checks are fields; a Yes on a check raises an exception. */
  async form(access: ResolvedAccess): Promise<ExceptionLineDef[]> {
    return this.asActor(access, (tx) => this.catalog(tx));
  }

  private async catalog(tx: Tx): Promise<ExceptionLineDef[]> {
    const fields = await tx.exceptionFormField.findMany({
      where: { form: { code: 'DAILY', active: true } },
      orderBy: { sortOrder: 'asc' },
    });
    const checks = fields.filter((f) => f.kind === 'yes_no');
    if (checks.length === 0) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_UNAVAILABLE,
        'The daily exception form is not set up.',
      );
    }
    return checks.map((check) => ({
      lineNo: check.lineNo,
      answerNo: check.fieldNo,
      question: check.label,
      ...(check.incident ? { incident: true as const } : {}),
      details: fields
        .filter((f) => f.parentKey === check.fieldKey)
        .map((f): ExceptionDetailDef => {
          const options = Array.isArray(f.options)
            ? f.options.filter((o): o is string => typeof o === 'string')
            : undefined;
          return {
            no: f.fieldNo,
            key: f.valueKey ?? f.fieldKey,
            label: f.label,
            kind: f.kind as ExceptionDetailDef['kind'],
            ...(f.unit ? { unit: f.unit } : {}),
            ...(f.decimals !== null ? { decimals: f.decimals } : {}),
            ...(options && options.length > 0 ? { options } : {}),
            ...(f.minTanks !== null ? { minTanks: f.minTanks } : {}),
          };
        }),
    }));
  }

  /** Apply the database checklist, then derive status and the highlight. */
  private async prepare(tx: Tx, raw: DailyExceptionBody) {
    const defs = await this.catalog(tx);
    const parsed = exceptionSaveSchema(defs).safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Some fields are not valid.',
        parsed.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      );
    }
    return { input: parsed.data, computed: this.compute(parsed.data, defs) };
  }

  /** Status, highlight and the clean lines, from the shared rules (never from the client). */
  private compute(input: DailyExceptionSaveInput, defs: readonly ExceptionLineDef[]) {
    const lines = cleanLines(input.lines, defs);
    const plantStatus = input.plantStatus ?? null;
    const status = exceptionStatus(input.action, plantStatus, lines, defs);
    const raised = formExceptions(status, plantStatus, lines, defs);
    return {
      lines,
      plantStatus,
      status,
      highlight: raised[0]?.summary ?? null,
      raised,
    };
  }

  /** Replace the exceptions this form produced. A draft or a clean day leaves none. */
  private async writeRaised(tx: Tx, id: string, raised: readonly FormException[]): Promise<void> {
    await tx.formException.deleteMany({ where: { dailyExceptionId: id } });
    if (raised.length === 0) return;
    await tx.formException.createMany({
      data: raised.map((r) => ({
        dailyExceptionId: id,
        fieldKey: r.fieldKey,
        lineNo: r.lineNo,
        summary: r.summary,
      })),
    });
  }

  private async writeLines(tx: Tx, id: string, lines: ExceptionLines): Promise<void> {
    await tx.dailyExceptionLine.deleteMany({ where: { exceptionId: id } });
    await tx.dailyExceptionLine.createMany({
      data: Object.entries(lines).map(([no, l]) => ({
        exceptionId: id,
        lineNo: Number(no),
        answer: l.answer,
        details: l.details,
      })),
    });
  }

  private uniqueViolation(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw conflict(DAILY_EXCEPTION_MESSAGES.alreadyExists);
    throw e;
  }

  /** Save draft → Partial (DEX-R2); Submit → Completed / Pending (DEX-R3). One per plant + date. */
  async create(
    access: ResolvedAccess,
    raw: DailyExceptionBody,
    ctx: RequestContext,
  ): Promise<DailyExceptionDetail> {
    assertPlant(access, raw.plantId, NEED.submit);
    try {
      return await this.asActor(access, async (tx) => {
        const { input, computed: c } = await this.prepare(tx, raw);
        await this.plantExists(tx, input.plantId);
        const exists = await tx.dailyException.count({
          where: { plantId: input.plantId, reportDate: dateOf(input.reportDate) },
        });
        if (exists > 0) throw conflict(DAILY_EXCEPTION_MESSAGES.alreadyExists);
        const row = await tx.dailyException.create({
          data: {
            plantId: input.plantId,
            reportDate: dateOf(input.reportDate),
            plantStatus: c.plantStatus,
            status: c.status,
            problemHighlight: c.highlight,
            enteredById: access.userId,
            lastModifiedById: access.userId,
          },
          select: { id: true, plantId: true },
        });
        await this.writeLines(tx, row.id, c.lines);
        await this.writeRaised(tx, row.id, c.raised);
        // A missed-day note no longer applies once the day has a report.
        await tx.lapseNote.deleteMany({
          where: { plantId: input.plantId, date: dateOf(input.reportDate) },
        });
        await this.audit.record(
          {
            action: input.action === 'submit' ? AuditAction.SUBMIT : AuditAction.CREATE,
            entity: 'daily_exception',
            entityId: row.id,
            plantId: row.plantId,
            actorId: access.userId,
            after: { reportDate: input.reportDate, status: c.status },
            ctx,
          },
          tx,
        );
        await this.announce(tx, access, row.id, input.plantId, input.reportDate, c);
        return this.detail(tx, access, row.id);
      });
    } catch (e: unknown) {
      return this.uniqueViolation(e);
    }
  }

  private async lock(tx: Tx, id: string): Promise<Locked> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        plant_id: string;
        report_date: Date;
        status: ExceptionStatus;
        version: number;
      }[]
    >`SELECT id, plant_id, report_date, status, version FROM daily_exceptions WHERE id = ${id}::uuid FOR UPDATE`;
    const r = rows[0];
    if (!r) throw notFound();
    return {
      id: r.id,
      plantId: r.plant_id,
      reportDate: iso(r.report_date),
      status: r.status,
      version: r.version,
    };
  }

  /**
   * Edit any time — there is no Approve lock (APPR-6). The status is recomputed from the answers;
   * plant and date may change only while Partial. Optimistic locking by `version`.
   */
  async update(
    access: ResolvedAccess,
    id: string,
    raw: DailyExceptionBody,
    ctx: RequestContext,
  ): Promise<DailyExceptionDetail> {
    try {
      return await this.asActor(access, async (tx) => {
        const { input, computed: c } = await this.prepare(tx, raw);
        const row = await this.lock(tx, id);
        assertPlant(access, row.plantId, NEED.submit);
        if (input.version === undefined || row.version !== input.version)
          throw conflict(DAILY_EXCEPTION_MESSAGES.stale);
        const moved = row.plantId !== input.plantId || row.reportDate !== input.reportDate;
        if (moved) {
          if (row.status !== 'PARTIAL')
            throw new AppError(
              HttpStatus.BAD_REQUEST,
              ErrorCode.VALIDATION_FAILED,
              'Some fields are not valid.',
              [{ path: 'reportDate', message: DAILY_EXCEPTION_MESSAGES.plantDateFixed }],
            );
          assertPlant(access, input.plantId, NEED.submit);
          await this.plantExists(tx, input.plantId);
        }
        const updated = await tx.dailyException.update({
          where: { id },
          data: {
            plantId: input.plantId,
            reportDate: dateOf(input.reportDate),
            plantStatus: c.plantStatus,
            status: c.status,
            problemHighlight: c.highlight,
            lastModifiedById: access.userId,
            version: { increment: 1 },
          },
          select: { plantId: true, version: true },
        });
        await this.writeLines(tx, id, c.lines);
        await this.writeRaised(tx, id, c.raised);
        await this.audit.record(
          {
            action: input.action === 'submit' ? AuditAction.SUBMIT : AuditAction.UPDATE,
            entity: 'daily_exception',
            entityId: id,
            plantId: updated.plantId,
            actorId: access.userId,
            before: { status: row.status, version: row.version },
            after: { status: c.status, version: updated.version },
            ctx,
          },
          tx,
        );
        await this.announce(tx, access, id, updated.plantId, input.reportDate, c);
        return this.detail(tx, access, id);
      });
    } catch (e: unknown) {
      return this.uniqueViolation(e);
    }
  }

  /** Upload an SQC report to a saved Daily Exception (DEX-F47). */
  async addFile(
    access: ResolvedAccess,
    id: string,
    file: IncomingFile,
    ctx: RequestContext,
  ): Promise<DailyExceptionDetail> {
    return this.asActor(access, async (tx) => {
      const row = await this.lock(tx, id);
      assertPlant(access, row.plantId, NEED.submit);
      await this.files.add(
        tx,
        { type: 'DAILY_EXCEPTION', id, plantId: row.plantId },
        file,
        access.userId,
        ctx,
        DAILY_EXCEPTION_MESSAGES.fileType,
      );
      return this.detail(tx, access, id);
    });
  }

  async removeFile(
    access: ResolvedAccess,
    id: string,
    fileId: string,
    ctx: RequestContext,
  ): Promise<DailyExceptionDetail> {
    return this.asActor(access, async (tx) => {
      const row = await this.lock(tx, id);
      assertPlant(access, row.plantId, NEED.submit);
      await this.files.remove(tx, 'DAILY_EXCEPTION', id, fileId, access.userId, ctx);
      return this.detail(tx, access, id);
    });
  }

  /** Authorised download of one file (`attachment`, nosniff), audited. */
  async readFile(
    access: ResolvedAccess,
    id: string,
    fileId: string,
    ctx: RequestContext,
  ): Promise<StoredFile> {
    return this.asActor(access, async (tx) => {
      const row = await tx.dailyException.findUnique({
        where: { id },
        select: { plantId: true },
      });
      if (!row) throw notFound();
      // Anyone who may open the record may open its files (spec File uploads, D-103).
      assertPlant(access, row.plantId, NEED.view);
      return this.files.read(tx, 'DAILY_EXCEPTION', id, fileId, access.userId, ctx);
    });
  }

  /** Optional short note for a missed day (DEX-S7): only for a plant-day with no report. */
  async saveLapseNote(
    access: ResolvedAccess,
    input: LapseNoteInput,
    ctx: RequestContext,
  ): Promise<{ plantId: string; date: string; note: string }> {
    assertPlant(access, input.plantId, NEED.submit);
    return this.asActor(access, async (tx) => {
      await this.plantExists(tx, input.plantId);
      const date = dateOf(input.date);
      const report = await tx.dailyException.count({
        where: { plantId: input.plantId, reportDate: date },
      });
      if (report > 0) throw conflict(DAILY_EXCEPTION_MESSAGES.noteNotMissed);
      const note = await tx.lapseNote.upsert({
        where: { plantId_date: { plantId: input.plantId, date } },
        create: { plantId: input.plantId, date, note: input.note, createdById: access.userId },
        update: { note: input.note },
      });
      await this.audit.record(
        {
          action: AuditAction.UPDATE,
          entity: 'lapse_note',
          entityId: `${input.plantId}:${input.date}`,
          plantId: input.plantId,
          actorId: access.userId,
          after: { note: input.note },
          ctx,
        },
        tx,
      );
      return { plantId: note.plantId, date: iso(note.date), note: note.note };
    });
  }
}
