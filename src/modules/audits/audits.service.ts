import { HttpStatus, Injectable } from '@nestjs/common';
import {
  assertPlant,
  canOnPlant,
  plantFilter,
  type PlantNeed,
} from '../../common/access/plant-scope';
import { dayOf, isoDay, isoDayOrNull, namesOf, personRef } from '../../common/db/people-names';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/security/request-context';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  OBSERVATION_URGENCY_RANK,
  OPERATIONS_MESSAGES,
  istToday,
  observationUrgency,
  type AuditCards,
  type AuditDetail,
  type AuditFilter,
  type AuditPage,
  type AuditQuery,
  type AuditRow,
  type AuditSaveInput,
  type ObservationCounts,
  type ObservationUrgency,
  type ObservationView,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import {
  AttachmentsService,
  type IncomingFile,
  type StoredFile,
} from '../attachments/attachments.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';

const MODULE = 'AUDIT' as const;
const NEED = {
  view: { module: MODULE, capability: 'VIEW' },
  submit: { module: MODULE, capability: 'SUBMIT' },
  download: { module: MODULE, capability: 'DOWNLOAD' },
} as const satisfies Record<string, PlantNeed>;

const notFound = (): AppError =>
  new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, OPERATIONS_MESSAGES.auditNotFound);
const conflict = (message: string): AppError =>
  new AppError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, message);

interface ObsDates {
  status: 'PENDING' | 'COMPLIED';
  targetDate: Date | null;
  revisedTargetDate: Date | null;
}

const urgencyOf = (o: ObsDates, today: string): ObservationUrgency =>
  observationUrgency(
    {
      status: o.status,
      targetDate: isoDayOrNull(o.targetDate),
      revisedTargetDate: isoDayOrNull(o.revisedTargetDate),
    },
    today,
  );

/** Complied / Pending (incl. due soon) / Due soon / Overdue counts of some observations. */
export function countObservations(obs: readonly ObsDates[], today: string): ObservationCounts {
  const c: ObservationCounts = { complied: 0, pending: 0, dueSoon: 0, overdue: 0 };
  for (const o of obs) {
    const u = urgencyOf(o, today);
    if (u === 'COMPLIED') c.complied += 1;
    else if (u === 'OVERDUE') c.overdue += 1;
    else {
      c.pending += 1;
      if (u === 'DUE_SOON') c.dueSoon += 1;
    }
  }
  return c;
}

const auditSelect = {
  id: true,
  plantId: true,
  auditType: true,
  frequency: true,
  fy: true,
  totalRecommendations: true,
  startDate: true,
  endDate: true,
  plant: { select: { id: true, name: true, code: true } },
  observations: { select: { status: true, targetDate: true, revisedTargetDate: true } },
} as const satisfies Prisma.AuditSelect;

/**
 * Audit (spec “Audit”, AUD-*). One audit per plant visit with its observations; every row is
 * coloured and sorted by urgency (AUD-3) from the shared rule, using the revised target date
 * when entered (AUD-4). Observation Ids come from the database (`next_observation_code()`).
 */
@Injectable()
export class AuditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly files: AttachmentsService,
  ) {}

  private asActor<T>(access: ResolvedAccess, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, fn);
  }

  /** The one query behind the table, its cards and its download. Worst first (WF-7). */
  private async rows(
    tx: Tx,
    access: ResolvedAccess,
    f: AuditFilter,
    need: PlantNeed,
  ): Promise<{ rows: AuditRow[]; cards: AuditCards }> {
    const scope = plantFilter(access, f.plantId, need);
    const records = await tx.audit.findMany({
      where: {
        ...(scope.all ? {} : { plantId: { in: scope.plantIds } }),
        plant: { deletedAt: null },
        ...(f.auditType ? { auditType: f.auditType } : {}),
        ...(f.fy ? { fy: f.fy } : {}),
      },
      select: auditSelect,
      orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
    });
    const today = istToday();
    const files = await this.files.listMany(
      tx,
      'AUDIT',
      records.map((r) => r.id),
    );
    let rows: AuditRow[] = records.map((r) => {
      const counts = countObservations(r.observations, today);
      const worst = r.observations
        .map((o) => urgencyOf(o, today))
        .sort((a, b) => OBSERVATION_URGENCY_RANK[a] - OBSERVATION_URGENCY_RANK[b])[0];
      return {
        id: r.id,
        plant: r.plant,
        auditType: r.auditType,
        fy: r.fy,
        frequency: r.frequency,
        startDate: isoDay(r.startDate),
        endDate: isoDay(r.endDate),
        attachment: files.get(r.id)?.[0] ?? null,
        counts,
        urgency: worst ?? null,
      };
    });
    if (f.status === 'COMPLIED') rows = rows.filter((r) => r.counts.complied > 0);
    if (f.status === 'PENDING') rows = rows.filter((r) => r.counts.pending > 0);
    if (f.status === 'OVERDUE') rows = rows.filter((r) => r.counts.overdue > 0);
    const rank = (r: AuditRow): number => (r.urgency ? OBSERVATION_URGENCY_RANK[r.urgency] : 4);
    rows.sort((a, b) => rank(a) - rank(b));
    const ids = new Set(rows.map((r) => r.id));
    const cards: AuditCards = {
      totalRecommendations: records
        .filter((r) => ids.has(r.id))
        .reduce((a, r) => a + r.totalRecommendations, 0),
      complied: rows.reduce((a, r) => a + r.counts.complied, 0),
      pending: rows.reduce((a, r) => a + r.counts.pending, 0),
      overdue: rows.reduce((a, r) => a + r.counts.overdue, 0),
    };
    return { rows, cards };
  }

  async list(access: ResolvedAccess, q: AuditQuery): Promise<AuditPage> {
    return this.asActor(access, async (tx) => {
      const { rows, cards } = await this.rows(tx, access, q, NEED.view);
      const start = (q.page - 1) * q.pageSize;
      return {
        rows: rows.slice(start, start + q.pageSize),
        total: rows.length,
        page: q.page,
        pageSize: q.pageSize,
        cards,
      };
    });
  }

  async exportRows(
    access: ResolvedAccess,
    f: AuditFilter,
  ): Promise<{ rows: AuditRow[]; cards: AuditCards }> {
    return this.asActor(access, (tx) => this.rows(tx, access, f, NEED.download));
  }

  async get(access: ResolvedAccess, id: string): Promise<AuditDetail> {
    return this.asActor(access, (tx) => this.detail(tx, access, id));
  }

  private async detail(tx: Tx, access: ResolvedAccess, id: string): Promise<AuditDetail> {
    const a = await tx.audit.findUnique({
      where: { id },
      include: {
        plant: { select: { id: true, name: true, code: true, deletedAt: true } },
        observations: true,
      },
    });
    if (!a || a.plant.deletedAt !== null) throw notFound();
    assertPlant(access, a.plantId, NEED.view);
    const today = istToday();
    const names = await namesOf(tx, [a.createdById]);
    const observations: ObservationView[] = a.observations
      .map((o) => ({
        id: o.id,
        code: o.observationCode,
        subGroupCode: o.subGroupCode,
        checklistRef: o.checklistRef,
        particular: o.particular,
        observation: o.observation,
        recommendation: o.recommendation,
        actionPlan: o.actionPlan,
        targetDate: isoDayOrNull(o.targetDate),
        revisedTargetDate: isoDayOrNull(o.revisedTargetDate),
        status: o.status,
        urgency: urgencyOf(o, today),
      }))
      .sort(
        (x, y) =>
          OBSERVATION_URGENCY_RANK[x.urgency] - OBSERVATION_URGENCY_RANK[y.urgency] ||
          x.code.localeCompare(y.code),
      );
    const canSubmit = canOnPlant(access, a.plantId, NEED.submit);
    return {
      id: a.id,
      version: a.version,
      plant: { id: a.plant.id, name: a.plant.name, code: a.plant.code },
      auditType: a.auditType,
      frequency: a.frequency,
      fy: a.fy,
      totalRecommendations: a.totalRecommendations,
      startDate: isoDay(a.startDate),
      endDate: isoDay(a.endDate),
      legacyFileName: a.legacyFileName,
      files: await this.files.list(tx, 'AUDIT', a.id),
      observations,
      createdBy: personRef(names, a.createdById),
      updatedAt: a.updatedAt.toISOString(),
      can: { edit: canSubmit, upload: canSubmit },
    };
  }

  private async plantOk(tx: Tx, plantId: string): Promise<void> {
    const p = await tx.plant.findFirst({
      where: { id: plantId, deletedAt: null },
      select: { id: true },
    });
    if (!p)
      throw new AppError(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'You do not have access to this plant.',
      );
  }

  private header(input: AuditSaveInput) {
    return {
      plantId: input.plantId,
      auditType: input.auditType,
      frequency: input.frequency,
      fy: input.fy,
      totalRecommendations: input.totalRecommendations,
      startDate: dayOf(input.startDate),
      endDate: dayOf(input.endDate),
    };
  }

  private obsData(o: AuditSaveInput['observations'][number]) {
    return {
      subGroupCode: o.subGroupCode,
      checklistRef: o.checklistRef,
      particular: o.particular,
      observation: o.observation,
      recommendation: o.recommendation,
      actionPlan: o.actionPlan,
      targetDate: o.targetDate ? dayOf(o.targetDate) : null,
      revisedTargetDate: o.revisedTargetDate ? dayOf(o.revisedTargetDate) : null,
      status: o.status,
    };
  }

  /** New observations get their Id from the database (unique across plants, AUD-2). */
  private async addObservations(
    tx: Tx,
    auditId: string,
    plantId: string,
    list: AuditSaveInput['observations'],
  ): Promise<void> {
    for (const o of list) {
      const code = (
        await tx.$queryRaw<{ code: string }[]>`SELECT next_observation_code() AS code`
      )[0]?.code;
      if (!code) throw new Error('No observation code');
      await tx.auditObservation.create({
        data: { auditId, plantId, observationCode: code, ...this.obsData(o) },
      });
    }
  }

  async create(
    access: ResolvedAccess,
    input: AuditSaveInput,
    ctx: RequestContext,
  ): Promise<AuditDetail> {
    assertPlant(access, input.plantId, NEED.submit);
    return this.asActor(access, async (tx) => {
      await this.plantOk(tx, input.plantId);
      const a = await tx.audit.create({
        data: { ...this.header(input), createdById: access.userId },
        select: { id: true },
      });
      await this.addObservations(
        tx,
        a.id,
        input.plantId,
        input.observations.filter((o) => !o.id),
      );
      await this.audit.record(
        {
          action: AuditAction.CREATE,
          entity: 'audit',
          entityId: a.id,
          plantId: input.plantId,
          actorId: access.userId,
          after: {
            auditType: input.auditType,
            fy: input.fy,
            observations: input.observations.length,
          },
          ctx,
        },
        tx,
      );
      return this.detail(tx, access, a.id);
    });
  }

  /** Save the header and the observation rows (added, changed, removed) in one transaction. */
  async update(
    access: ResolvedAccess,
    id: string,
    input: AuditSaveInput,
    ctx: RequestContext,
  ): Promise<AuditDetail> {
    return this.asActor(access, async (tx) => {
      const rows = await tx.$queryRaw<{ plant_id: string; version: number }[]>`
        SELECT plant_id, version FROM audits WHERE id = ${id}::uuid FOR UPDATE`;
      const row = rows[0];
      if (!row) throw notFound();
      assertPlant(access, row.plant_id, NEED.submit);
      if (input.plantId !== row.plant_id) {
        assertPlant(access, input.plantId, NEED.submit);
        await this.plantOk(tx, input.plantId);
      }
      if (input.version === undefined || input.version !== row.version)
        throw conflict(OPERATIONS_MESSAGES.stale);
      const existing = await tx.auditObservation.findMany({
        where: { auditId: id },
        select: { id: true },
      });
      const known = new Set(existing.map((o) => o.id));
      const kept = input.observations.filter((o) => o.id !== undefined);
      if (kept.some((o) => !known.has(o.id ?? '')))
        throw conflict(OPERATIONS_MESSAGES.observationNotFound);
      const keepIds = new Set(kept.map((o) => o.id));
      const removed = existing.filter((o) => !keepIds.has(o.id)).map((o) => o.id);
      await tx.audit.update({
        where: { id },
        data: { ...this.header(input), version: { increment: 1 } },
      });
      if (removed.length > 0)
        await tx.auditObservation.deleteMany({ where: { id: { in: removed } } });
      for (const o of kept)
        await tx.auditObservation.update({
          where: { id: o.id },
          data: { ...this.obsData(o), plantId: input.plantId },
        });
      await this.addObservations(
        tx,
        id,
        input.plantId,
        input.observations.filter((o) => !o.id),
      );
      await this.audit.record(
        {
          action: AuditAction.UPDATE,
          entity: 'audit',
          entityId: id,
          plantId: input.plantId,
          actorId: access.userId,
          before: { version: row.version },
          after: {
            version: row.version + 1,
            observations: input.observations.length,
            removed: removed.length,
          },
          ctx,
        },
        tx,
      );
      return this.detail(tx, access, id);
    });
  }

  private async owned(tx: Tx, id: string): Promise<string> {
    const a = await tx.audit.findUnique({ where: { id }, select: { plantId: true } });
    if (!a) throw notFound();
    return a.plantId;
  }

  async addFile(
    access: ResolvedAccess,
    id: string,
    file: IncomingFile,
    ctx: RequestContext,
  ): Promise<AuditDetail> {
    return this.asActor(access, async (tx) => {
      const plantId = await this.owned(tx, id);
      assertPlant(access, plantId, NEED.submit);
      await this.files.add(
        tx,
        { type: 'AUDIT', id, plantId },
        file,
        access.userId,
        ctx,
        OPERATIONS_MESSAGES.fileType,
      );
      return this.detail(tx, access, id);
    });
  }

  async removeFile(
    access: ResolvedAccess,
    id: string,
    fileId: string,
    ctx: RequestContext,
  ): Promise<AuditDetail> {
    return this.asActor(access, async (tx) => {
      const plantId = await this.owned(tx, id);
      assertPlant(access, plantId, NEED.submit);
      await this.files.remove(tx, 'AUDIT', id, fileId, access.userId, ctx);
      return this.detail(tx, access, id);
    });
  }

  async readFile(
    access: ResolvedAccess,
    id: string,
    fileId: string,
    ctx: RequestContext,
  ): Promise<StoredFile> {
    return this.asActor(access, async (tx) => {
      const plantId = await this.owned(tx, id);
      assertPlant(access, plantId, NEED.view);
      return this.files.read(tx, 'AUDIT', id, fileId, access.userId, ctx);
    });
  }
}
