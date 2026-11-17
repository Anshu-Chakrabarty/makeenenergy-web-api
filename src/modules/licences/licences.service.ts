import { HttpStatus, Injectable } from '@nestjs/common';
import {
  assertPlant,
  canOnPlant,
  plantFilter,
  type PlantNeed,
} from '../../common/access/plant-scope';
import { dayOf, isoDayOrNull, namesOf, personRef } from '../../common/db/people-names';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/security/request-context';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  LICENCE_STATUS_RANK,
  OPERATIONS_MESSAGES,
  istToday,
  licenceCategoryOf,
  licenceStatus,
  type LicenceCards,
  type LicenceDetail,
  type LicenceFilter,
  type LicenceItemOption,
  type LicencePage,
  type LicenceQuery,
  type LicenceRow,
  type LicenceSaveInput,
  type LicenceType,
  type PersonOption,
  type PersonRef,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import {
  AttachmentsService,
  type IncomingFile,
  type StoredFile,
} from '../attachments/attachments.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';

const MODULE = 'LICENCES' as const;
const NEED = {
  view: { module: MODULE, capability: 'VIEW' },
  submit: { module: MODULE, capability: 'SUBMIT' },
  download: { module: MODULE, capability: 'DOWNLOAD' },
} as const satisfies Record<string, PlantNeed>;

const notFound = (): AppError =>
  new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, OPERATIONS_MESSAGES.licenceNotFound);
const invalid = (path: string, message: string): AppError =>
  new AppError(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Some fields are not valid.', [
    { path, message },
  ]);

const licenceSelect = {
  id: true,
  plantId: true,
  category: true,
  licenceType: true,
  docRef: true,
  startDate: true,
  endDate: true,
  frequency: true,
  remindBeforeDays: true,
  item: { select: { id: true, title: true } },
  plant: { select: { id: true, name: true, code: true } },
} as const satisfies Prisma.LicenceSelect;
type LicenceRecord = Prisma.LicenceGetPayload<{ select: typeof licenceSelect }>;

export function toLicenceRow(r: LicenceRecord, today: string): LicenceRow {
  const startDate = isoDayOrNull(r.startDate);
  const endDate = isoDayOrNull(r.endDate);
  return {
    id: r.id,
    plant: r.plant,
    category: r.category,
    licenceType: r.licenceType,
    item: r.item,
    docRef: r.docRef,
    startDate,
    endDate,
    frequency: r.frequency,
    remindBeforeDays: r.remindBeforeDays,
    status: licenceStatus(
      { frequency: r.frequency, startDate, endDate, remindBeforeDays: r.remindBeforeDays },
      today,
    ),
  };
}

/**
 * Licences — Statutory and Mandatory / Internal testing (spec “Licences”, LIC-*). Status is never
 * stored: it comes from the shared `licenceStatus` on every read (LIC-S1). Expired and Due rows
 * come first (LIC-3).
 */
@Injectable()
export class LicencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly files: AttachmentsService,
  ) {}

  private asActor<T>(access: ResolvedAccess, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, fn);
  }

  /** Title / item dropdown for a licence type (item master, D-26). */
  async items(access: ResolvedAccess, type?: LicenceType): Promise<LicenceItemOption[]> {
    return this.asActor(access, async (tx) =>
      tx.licenceItem.findMany({
        where: type ? { licenceType: type } : {},
        select: { id: true, licenceType: true, title: true },
        orderBy: [{ licenceType: 'asc' }, { title: 'asc' }],
      }),
    );
  }

  /** People who can be reminded about a plant's licence: its people and the Admins. */
  async remindOptions(access: ResolvedAccess, plantId: string): Promise<PersonOption[]> {
    assertPlant(access, plantId, NEED.view);
    return this.asActor(access, async (tx) => {
      const users = await tx.user.findMany({
        where: {
          workingStatus: 'WORKING',
          OR: [{ assignments: { some: { plantId } } }, { baseRole: { isAdmin: true } }],
        },
        select: { id: true, name: true, designation: true },
        orderBy: { name: 'asc' },
      });
      return users.map((u) => ({ id: u.id, name: u.name, designation: u.designation }));
    });
  }

  /** The one query behind the table, its cards and its download. */
  private async rows(
    tx: Tx,
    access: ResolvedAccess,
    f: LicenceFilter,
    need: PlantNeed,
  ): Promise<{ rows: LicenceRow[]; cards: LicenceCards }> {
    const scope = plantFilter(access, f.plantId, need);
    const records = await tx.licence.findMany({
      where: {
        category: f.category,
        ...(scope.all ? {} : { plantId: { in: scope.plantIds } }),
        plant: { deletedAt: null },
        ...(f.licenceType ? { licenceType: f.licenceType } : {}),
      },
      select: licenceSelect,
    });
    const today = istToday();
    const all = records.map((r) => toLicenceRow(r, today));
    const n = (s: LicenceRow['status']): number => all.filter((r) => r.status === s).length;
    const cards: LicenceCards = {
      total: all.length,
      active: n('ACTIVE'),
      expired: n('EXPIRED'),
      due: n('DUE'),
      na: n('NA'),
      notInitiated: n('NOT_INITIATED'),
    };
    const rows = (f.status ? all.filter((r) => r.status === f.status) : all).sort(
      (a, b) =>
        LICENCE_STATUS_RANK[a.status] - LICENCE_STATUS_RANK[b.status] ||
        (a.endDate ?? '9999').localeCompare(b.endDate ?? '9999') ||
        a.plant.name.localeCompare(b.plant.name) ||
        a.item.title.localeCompare(b.item.title),
    );
    return { rows, cards };
  }

  async list(access: ResolvedAccess, q: LicenceQuery): Promise<LicencePage> {
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
    f: LicenceFilter,
  ): Promise<{ rows: LicenceRow[]; cards: LicenceCards }> {
    return this.asActor(access, (tx) => this.rows(tx, access, f, NEED.download));
  }

  async get(access: ResolvedAccess, id: string): Promise<LicenceDetail> {
    return this.asActor(access, (tx) => this.detail(tx, access, id));
  }

  private async detail(tx: Tx, access: ResolvedAccess, id: string): Promise<LicenceDetail> {
    const r = await tx.licence.findUnique({
      where: { id },
      select: {
        ...licenceSelect,
        version: true,
        notes: true,
        updatedAt: true,
        remindUsers: { select: { userId: true } },
        plant: { select: { id: true, name: true, code: true, deletedAt: true } },
      },
    });
    if (!r || r.plant.deletedAt !== null) throw notFound();
    assertPlant(access, r.plantId, NEED.view);
    const names = await namesOf(
      tx,
      r.remindUsers.map((u) => u.userId),
    );
    const canSubmit = canOnPlant(access, r.plantId, NEED.submit);
    return {
      ...toLicenceRow(
        { ...r, plant: { id: r.plant.id, name: r.plant.name, code: r.plant.code } },
        istToday(),
      ),
      version: r.version,
      notes: r.notes,
      remindUsers: r.remindUsers
        .map((u) => personRef(names, u.userId))
        .filter((p): p is PersonRef => p !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
      files: await this.files.list(tx, 'LICENCE', r.id),
      updatedAt: r.updatedAt.toISOString(),
      can: { edit: canSubmit, upload: canSubmit },
    };
  }

  /** Item must belong to the type; remind people must be working people. */
  private async check(tx: Tx, input: LicenceSaveInput): Promise<void> {
    const p = await tx.plant.findFirst({
      where: { id: input.plantId, deletedAt: null },
      select: { id: true },
    });
    if (!p)
      throw new AppError(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'You do not have access to this plant.',
      );
    const item = await tx.licenceItem.findUnique({ where: { id: input.itemId } });
    if (!item) throw invalid('itemId', OPERATIONS_MESSAGES.itemRequired);
    if (item.licenceType !== input.licenceType)
      throw invalid('itemId', OPERATIONS_MESSAGES.itemWrongType);
    const people = await tx.user.count({
      where: { id: { in: input.remindUserIds }, workingStatus: 'WORKING' },
    });
    if (people !== input.remindUserIds.length)
      throw invalid('remindUserIds', OPERATIONS_MESSAGES.remindUsersRequired);
  }

  private data(input: LicenceSaveInput) {
    return {
      plantId: input.plantId,
      category: licenceCategoryOf(input.licenceType),
      licenceType: input.licenceType,
      itemId: input.itemId,
      docRef: input.docRef,
      notes: input.notes,
      startDate: input.startDate ? dayOf(input.startDate) : null,
      endDate: input.endDate ? dayOf(input.endDate) : null,
      frequency: input.frequency,
      remindBeforeDays: input.remindBeforeDays,
    };
  }

  async create(
    access: ResolvedAccess,
    input: LicenceSaveInput,
    ctx: RequestContext,
  ): Promise<LicenceDetail> {
    assertPlant(access, input.plantId, NEED.submit);
    return this.asActor(access, async (tx) => {
      await this.check(tx, input);
      const l = await tx.licence.create({
        data: {
          ...this.data(input),
          createdById: access.userId,
          remindUsers: {
            create: input.remindUserIds.map((userId) => ({ userId, plantId: input.plantId })),
          },
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          action: AuditAction.CREATE,
          entity: 'licence',
          entityId: l.id,
          plantId: input.plantId,
          actorId: access.userId,
          after: { ...this.data(input), remindUserIds: input.remindUserIds },
          ctx,
        },
        tx,
      );
      return this.detail(tx, access, l.id);
    });
  }

  /** Edit (title and type included, LIC-4); optimistic locking by `version`. */
  async update(
    access: ResolvedAccess,
    id: string,
    input: LicenceSaveInput,
    ctx: RequestContext,
  ): Promise<LicenceDetail> {
    return this.asActor(access, async (tx) => {
      const rows = await tx.$queryRaw<{ plant_id: string; version: number }[]>`
        SELECT plant_id, version FROM licences WHERE id = ${id}::uuid FOR UPDATE`;
      const row = rows[0];
      if (!row) throw notFound();
      assertPlant(access, row.plant_id, NEED.submit);
      if (input.plantId !== row.plant_id) assertPlant(access, input.plantId, NEED.submit);
      if (input.version === undefined || input.version !== row.version)
        throw new AppError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, OPERATIONS_MESSAGES.stale);
      await this.check(tx, input);
      await tx.licence.update({
        where: { id },
        data: { ...this.data(input), version: { increment: 1 } },
      });
      await tx.licenceRemindUser.deleteMany({ where: { licenceId: id } });
      await tx.licenceRemindUser.createMany({
        data: input.remindUserIds.map((userId) => ({
          licenceId: id,
          userId,
          plantId: input.plantId,
        })),
      });
      await this.audit.record(
        {
          action: AuditAction.UPDATE,
          entity: 'licence',
          entityId: id,
          plantId: input.plantId,
          actorId: access.userId,
          before: { version: row.version },
          after: { ...this.data(input), remindUserIds: input.remindUserIds },
          ctx,
        },
        tx,
      );
      return this.detail(tx, access, id);
    });
  }

  private async owned(tx: Tx, id: string): Promise<string> {
    const l = await tx.licence.findUnique({ where: { id }, select: { plantId: true } });
    if (!l) throw notFound();
    return l.plantId;
  }

  async addFile(
    access: ResolvedAccess,
    id: string,
    file: IncomingFile,
    ctx: RequestContext,
  ): Promise<LicenceDetail> {
    return this.asActor(access, async (tx) => {
      const plantId = await this.owned(tx, id);
      assertPlant(access, plantId, NEED.submit);
      await this.files.add(
        tx,
        { type: 'LICENCE', id, plantId },
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
  ): Promise<LicenceDetail> {
    return this.asActor(access, async (tx) => {
      const plantId = await this.owned(tx, id);
      assertPlant(access, plantId, NEED.submit);
      await this.files.remove(tx, 'LICENCE', id, fileId, access.userId, ctx);
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
      return this.files.read(tx, 'LICENCE', id, fileId, access.userId, ctx);
    });
  }
}
