import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  assertPlant,
  canOnPlant,
  plantScope,
  type PlantNeed,
} from '../../common/access/plant-scope';
import { dayOf, isoDay, namesOf, personRef } from '../../common/db/people-names';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/security/request-context';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  EQUIPMENT_TYPES,
  OPERATIONS_MESSAGES,
  contractEndingSoon,
  istToday,
  plantEndDate,
  type EquipmentType,
  type PersonOption,
  type PlantDetailView,
  type PlantDetailsInput,
  type PlantPage,
  type PlantQuery,
  type PlantRow,
  type PlantSaveInput,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import {
  AttachmentsService,
  type IncomingFile,
  type StoredFile,
} from '../attachments/attachments.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';

const MODULE = 'PLANT_MASTER' as const;
const NEED = {
  view: { module: MODULE, capability: 'VIEW' },
  submit: { module: MODULE, capability: 'SUBMIT' },
  download: { module: MODULE, capability: 'DOWNLOAD' },
} as const satisfies Record<string, PlantNeed>;

const IMAGES = ['image/jpeg', 'image/png'] as const;

const notFound = (): AppError =>
  new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, OPERATIONS_MESSAGES.plantNotFound);
const invalid = (path: string, message: string): AppError =>
  new AppError(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Some fields are not valid.', [
    { path, message },
  ]);

const plantSelect = {
  id: true,
  name: true,
  address: true,
  code: true,
  contractDate: true,
  startDate: true,
  endDate: true,
  periodYears: true,
  extensionYears: true,
  status: true,
  plantKey: true,
  managerId: true,
} as const satisfies Prisma.PlantSelect;
type PlantRecord = Prisma.PlantGetPayload<{ select: typeof plantSelect }>;

/** e.g. PK-7F3A21 (D-35). */
const newPlantKey = (): string => `PK-${randomBytes(3).toString('hex').toUpperCase()}`;

/**
 * Plant master and details (spec “Plant master”, PLT-*). Admin creates, edits the contract and
 * deletes (with the DELETE_PLANT switch and a reason); the Plant Manager — Submit on Plant master
 * for that plant — keeps the details, activities and contract files. Row-level security limits
 * every read to assigned plants.
 */
@Injectable()
export class PlantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly files: AttachmentsService,
    private readonly notices: NotificationsService,
  ) {}

  private asActor<T>(access: ResolvedAccess, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, fn);
  }

  private toRow(p: PlantRecord, names: Map<string, string>): PlantRow {
    return {
      id: p.id,
      name: p.name,
      address: p.address,
      code: p.code,
      contractDate: isoDay(p.contractDate),
      startDate: isoDay(p.startDate),
      endDate: isoDay(p.endDate),
      periodYears: p.periodYears,
      extensionYears: p.extensionYears,
      status: p.status,
      plantKey: p.plantKey,
      manager: personRef(names, p.managerId) ?? { id: p.managerId, name: '—' },
    };
  }

  private where(access: ResolvedAccess, f: Omit<PlantQuery, 'page' | 'pageSize'>) {
    const scope = plantScope(access, NEED.view);
    return {
      deletedAt: null,
      ...(scope.all ? {} : { id: { in: scope.plantIds } }),
      ...(f.q ? { name: { contains: f.q, mode: 'insensitive' as const } } : {}),
      ...(f.status ? { status: f.status } : {}),
    } satisfies Prisma.PlantWhereInput;
  }

  /** Plant master table (PLT-T1…T9) with CARD-8; the download uses the same filter. */
  async list(access: ResolvedAccess, q: PlantQuery): Promise<PlantPage> {
    return this.asActor(access, async (tx) => {
      const where = this.where(access, q);
      const all = await tx.plant.findMany({ where, select: plantSelect, orderBy: { name: 'asc' } });
      const today = istToday();
      const ending = all.filter((p) => contractEndingSoon(isoDay(p.endDate), today));
      const page = all.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
      const names = await namesOf(
        tx,
        page.map((p) => p.managerId),
      );
      return {
        rows: page.map((p) => this.toRow(p, names)),
        total: all.length,
        page: q.page,
        pageSize: q.pageSize,
        cards: {
          working: all.filter((p) => p.status === 'WORKING').length,
          new: all.filter((p) => p.status === 'NEW').length,
          endingSoon: ending.length,
          endingSoonNames: ending.map((p) => p.name),
        },
      };
    });
  }

  async exportRows(
    access: ResolvedAccess,
    f: Omit<PlantQuery, 'page' | 'pageSize'>,
  ): Promise<PlantRow[]> {
    return this.asActor(access, async (tx) => {
      const all = await tx.plant.findMany({
        where: this.where(access, f),
        select: plantSelect,
        orderBy: { name: 'asc' },
      });
      const names = await namesOf(
        tx,
        all.map((p) => p.managerId),
      );
      return all.map((p) => this.toRow(p, names));
    });
  }

  /** People Admin may pick as manager / users (working people), A–Z. */
  async peopleOptions(access: ResolvedAccess): Promise<PersonOption[]> {
    return this.asActor(access, async (tx) => {
      const users = await tx.user.findMany({
        where: { workingStatus: 'WORKING' },
        select: { id: true, name: true, designation: true },
        orderBy: { name: 'asc' },
      });
      return users.map((u) => ({ id: u.id, name: u.name, designation: u.designation }));
    });
  }

  async get(access: ResolvedAccess, id: string): Promise<PlantDetailView> {
    return this.asActor(access, (tx) => this.detail(tx, access, id));
  }

  private async detail(tx: Tx, access: ResolvedAccess, id: string): Promise<PlantDetailView> {
    const p = await tx.plant.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...plantSelect,
        details: true,
        equipment: true,
        volumes: { orderBy: [{ type: 'asc' }, { fy: 'asc' }] },
        activities: { orderBy: { createdAt: 'desc' } },
        assignments: { select: { userId: true } },
      },
    });
    if (!p) throw notFound();
    assertPlant(access, p.id, NEED.view);
    const names = await namesOf(tx, [
      p.managerId,
      p.details?.updatedById ?? null,
      ...p.activities.map((a) => a.createdById),
      ...p.assignments.map((a) => a.userId),
    ]);
    const images = await this.files.listMany(
      tx,
      'PLANT_ACTIVITY',
      p.activities.map((a) => a.id),
    );
    const equipment = Object.fromEntries(
      EQUIPMENT_TYPES.map((e) => {
        const row = p.equipment.find((x) => x.equipment === e);
        return [e, { quantity: row?.quantity ?? 0, note: row?.note ?? null }];
      }),
    ) as Record<EquipmentType, { quantity: number; note: string | null }>;
    return {
      plant: this.toRow(p, names),
      users: p.assignments
        .map((a) => personRef(names, a.userId))
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
      details: {
        capacity: p.details?.capacity?.toFixed(3) ?? null,
        production: p.details?.production?.toFixed(3) ?? null,
        volumes: p.volumes.map((v) => ({
          type: v.type,
          fy: v.fy,
          volumeMt: v.volumeMt.toFixed(3),
        })),
        equipment,
        updatedBy: personRef(names, p.details?.updatedById ?? null),
        updatedAt: p.details?.updatedAt.toISOString() ?? null,
      },
      activities: p.activities.map((a) => ({
        id: a.id,
        heading: a.heading,
        description: a.description,
        createdAt: a.createdAt.toISOString(),
        createdBy: personRef(names, a.createdById),
        images: images.get(a.id) ?? [],
      })),
      contractFiles: await this.files.list(tx, 'PLANT_CONTRACT', p.id),
      can: {
        editMaster: access.isAdmin,
        editDetails: canOnPlant(access, p.id, NEED.submit),
        delete: access.actions.includes('DELETE_PLANT'),
      },
    };
  }

  private uniqueViolation(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = JSON.stringify(e.meta ?? {});
      // The violated fields appear as "code" / "name" (or the index plants_code_key / _name_key).
      if (/"code"|plants_code_key/.test(target))
        throw invalid('code', OPERATIONS_MESSAGES.plantCodeTaken);
      if (/"name"|plants_name_key/.test(target))
        throw invalid('name', OPERATIONS_MESSAGES.plantNameTaken);
    }
    throw e;
  }

  /** Give people a seat on the plant: the manager as Plant Manager, others with their base role. */
  private async seat(
    tx: Tx,
    access: ResolvedAccess,
    plantId: string,
    managerId: string,
    userIds: readonly string[],
  ): Promise<void> {
    const pm = await tx.role.findFirst({ where: { name: 'Plant Manager' }, select: { id: true } });
    if (!pm) throw new Error('Standard role Plant Manager is missing');
    const people = await tx.user.findMany({
      where: { id: { in: [managerId, ...userIds] } },
      select: { id: true, baseRoleId: true, workingStatus: true },
    });
    const manager = people.find((u) => u.id === managerId);
    if (!manager || manager.workingStatus !== 'WORKING')
      throw invalid('managerId', OPERATIONS_MESSAGES.managerRequired);
    const plantName =
      (await tx.plant.findUnique({ where: { id: plantId }, select: { name: true } }))?.name ??
      'the plant';
    const wasManager = await tx.plantAssignment.findUnique({
      where: { userId_plantId: { userId: managerId, plantId } },
      select: { roleId: true },
    });
    await tx.plantAssignment.upsert({
      where: { userId_plantId: { userId: managerId, plantId } },
      create: { userId: managerId, plantId, roleId: pm.id, assignedById: access.userId },
      update: { roleId: pm.id, assignedById: access.userId },
    });
    if (wasManager?.roleId !== pm.id)
      await this.notices.accessChanged(tx, {
        userId: managerId,
        actorId: access.userId,
        changes: [`Added to ${plantName} as Plant Manager.`],
        plantIds: [plantId],
      });
    for (const id of new Set(userIds)) {
      if (id === managerId) continue;
      const u = people.find((x) => x.id === id);
      if (!u || u.workingStatus !== 'WORKING')
        throw invalid('userIds', OPERATIONS_MESSAGES.managerRequired);
      const existing = await tx.plantAssignment.findUnique({
        where: { userId_plantId: { userId: id, plantId } },
        select: { id: true },
      });
      if (existing) continue;
      if (!u.baseRoleId) throw invalid('userIds', OPERATIONS_MESSAGES.userHasNoRole);
      const seat = await tx.plantAssignment.create({
        data: { userId: id, plantId, roleId: u.baseRoleId, assignedById: access.userId },
        select: { role: { select: { name: true } } },
      });
      await this.notices.accessChanged(tx, {
        userId: id,
        actorId: access.userId,
        changes: [`Added to ${plantName} as ${seat.role.name}.`],
        plantIds: [plantId],
      });
    }
  }

  /** Create a plant (Admin, PLT-C1…C12): start = contract date; end = D-15; key shown after. */
  async create(
    access: ResolvedAccess,
    input: PlantSaveInput,
    ctx: RequestContext,
  ): Promise<PlantDetailView> {
    try {
      return await this.asActor(access, async (tx) => {
        let plantId = '';
        for (let attempt = 0; attempt < 5 && plantId === ''; attempt += 1) {
          const key = newPlantKey();
          if (await tx.plant.count({ where: { plantKey: key } })) continue;
          const p = await tx.plant.create({
            data: {
              name: input.name,
              address: input.address,
              code: input.code,
              plantKey: key,
              managerId: input.managerId,
              contractDate: dayOf(input.contractDate),
              periodYears: input.periodYears,
              extensionYears: input.extensionYears,
              startDate: dayOf(input.contractDate),
              endDate: dayOf(plantEndDate(input.contractDate, input.periodYears)),
              status: input.status,
              createdById: access.userId,
            },
            select: { id: true },
          });
          plantId = p.id;
        }
        if (!plantId) throw new Error('Could not draw a free plant key');
        await this.seat(tx, access, plantId, input.managerId, input.userIds);
        await this.audit.record(
          {
            action: AuditAction.CREATE,
            entity: 'plant',
            entityId: plantId,
            plantId,
            actorId: access.userId,
            after: { ...input },
            ctx,
          },
          tx,
        );
        return this.detail(tx, access, plantId);
      });
    } catch (e: unknown) {
      return this.uniqueViolation(e);
    }
  }

  /**
   * Edit the contract (Admin). A new period recomputes the end date; extension years stay stored
   * only (PLT-C8, D-15). “Select users” adds people to the plant; removing is done in People.
   */
  async update(
    access: ResolvedAccess,
    id: string,
    input: PlantSaveInput,
    ctx: RequestContext,
  ): Promise<PlantDetailView> {
    try {
      return await this.asActor(access, async (tx) => {
        const before = await tx.plant.findFirst({
          where: { id, deletedAt: null },
          select: plantSelect,
        });
        if (!before) throw notFound();
        await tx.plant.update({
          where: { id },
          data: {
            name: input.name,
            address: input.address,
            code: input.code,
            managerId: input.managerId,
            contractDate: dayOf(input.contractDate),
            periodYears: input.periodYears,
            extensionYears: input.extensionYears,
            startDate: dayOf(input.contractDate),
            endDate: dayOf(plantEndDate(input.contractDate, input.periodYears)),
            status: input.status,
          },
        });
        await this.seat(tx, access, id, input.managerId, input.userIds);
        await this.audit.record(
          {
            action: AuditAction.UPDATE,
            entity: 'plant',
            entityId: id,
            plantId: id,
            actorId: access.userId,
            before: { ...before, contractDate: isoDay(before.contractDate) },
            after: { ...input },
            ctx,
          },
          tx,
        );
        return this.detail(tx, access, id);
      });
    } catch (e: unknown) {
      return this.uniqueViolation(e);
    }
  }

  /** Delete (soft) with a mandatory reason — DELETE_PLANT switch, audited (ACT-3). */
  async remove(
    access: ResolvedAccess,
    id: string,
    reason: string,
    ctx: RequestContext,
  ): Promise<void> {
    await this.asActor(access, async (tx) => {
      const p = await tx.plant.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!p) throw notFound();
      await tx.plant.update({
        where: { id },
        data: { deletedAt: new Date(), deletedById: access.userId, deleteReason: reason },
      });
      await this.audit.record(
        {
          action: AuditAction.DELETE,
          entity: 'plant',
          entityId: id,
          plantId: id,
          actorId: access.userId,
          before: { name: p.name },
          reason,
          ctx,
        },
        tx,
      );
    });
  }

  private async open(tx: Tx, access: ResolvedAccess, id: string, need: PlantNeed): Promise<void> {
    const p = await tx.plant.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!p) throw notFound();
    assertPlant(access, id, need);
  }

  /** Plant details (PLT-D1…D18) — Plant Manager. Volumes are replaced; equipment upserted. */
  async saveDetails(
    access: ResolvedAccess,
    id: string,
    input: PlantDetailsInput,
    ctx: RequestContext,
  ): Promise<PlantDetailView> {
    return this.asActor(access, async (tx) => {
      await this.open(tx, access, id, NEED.submit);
      await tx.plantDetail.upsert({
        where: { plantId: id },
        create: {
          plantId: id,
          capacity: input.capacity,
          production: input.production,
          updatedById: access.userId,
        },
        update: {
          capacity: input.capacity,
          production: input.production,
          updatedById: access.userId,
        },
      });
      await tx.plantYearVolume.deleteMany({ where: { plantId: id } });
      if (input.volumes.length > 0)
        await tx.plantYearVolume.createMany({
          data: input.volumes.map((v) => ({
            plantId: id,
            type: v.type,
            fy: v.fy,
            volumeMt: v.volumeMt,
          })),
        });
      for (const e of EQUIPMENT_TYPES) {
        const row = input.equipment[e];
        await tx.plantEquipment.upsert({
          where: { plantId_equipment: { plantId: id, equipment: e } },
          create: { plantId: id, equipment: e, quantity: row.quantity, note: row.note },
          update: { quantity: row.quantity, note: row.note },
        });
      }
      await this.audit.record(
        {
          action: AuditAction.UPDATE,
          entity: 'plant_details',
          entityId: id,
          plantId: id,
          actorId: access.userId,
          after: {
            capacity: input.capacity,
            production: input.production,
            volumes: input.volumes.length,
          },
          ctx,
        },
        tx,
      );
      return this.detail(tx, access, id);
    });
  }

  async addActivity(
    access: ResolvedAccess,
    id: string,
    input: { heading: string; description: string | null },
    ctx: RequestContext,
  ): Promise<PlantDetailView> {
    return this.asActor(access, async (tx) => {
      await this.open(tx, access, id, NEED.submit);
      const a = await tx.plantActivity.create({
        data: {
          plantId: id,
          heading: input.heading,
          description: input.description,
          createdById: access.userId,
        },
      });
      await this.audit.record(
        {
          action: AuditAction.CREATE,
          entity: 'plant_activity',
          entityId: a.id,
          plantId: id,
          actorId: access.userId,
          after: { heading: input.heading },
          ctx,
        },
        tx,
      );
      return this.detail(tx, access, id);
    });
  }

  private async activity(tx: Tx, plantId: string, activityId: string) {
    const a = await tx.plantActivity.findFirst({ where: { id: activityId, plantId } });
    if (!a) throw new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Activity not found.');
    return a;
  }

  async removeActivity(
    access: ResolvedAccess,
    id: string,
    activityId: string,
    ctx: RequestContext,
  ): Promise<PlantDetailView> {
    return this.asActor(access, async (tx) => {
      await this.open(tx, access, id, NEED.submit);
      const a = await this.activity(tx, id, activityId);
      for (const img of await this.files.list(tx, 'PLANT_ACTIVITY', a.id))
        await this.files.remove(tx, 'PLANT_ACTIVITY', a.id, img.id, access.userId, ctx);
      await tx.plantActivity.delete({ where: { id: a.id } });
      await this.audit.record(
        {
          action: AuditAction.DELETE,
          entity: 'plant_activity',
          entityId: a.id,
          plantId: id,
          actorId: access.userId,
          before: { heading: a.heading },
          ctx,
        },
        tx,
      );
      return this.detail(tx, access, id);
    });
  }

  /** Image for an activity (JPG / PNG) or a contract file (PDF / JPG / PNG / XLSX). */
  async addFile(
    access: ResolvedAccess,
    id: string,
    target: { activityId: string } | 'contract',
    file: IncomingFile,
    ctx: RequestContext,
  ): Promise<PlantDetailView> {
    return this.asActor(access, async (tx) => {
      await this.open(tx, access, id, NEED.submit);
      if (target === 'contract') {
        await this.files.add(
          tx,
          { type: 'PLANT_CONTRACT', id, plantId: id },
          file,
          access.userId,
          ctx,
          OPERATIONS_MESSAGES.fileType,
        );
      } else {
        const a = await this.activity(tx, id, target.activityId);
        await this.files.add(
          tx,
          { type: 'PLANT_ACTIVITY', id: a.id, plantId: id },
          file,
          access.userId,
          ctx,
          OPERATIONS_MESSAGES.imageType,
          IMAGES,
        );
      }
      return this.detail(tx, access, id);
    });
  }

  async removeFile(
    access: ResolvedAccess,
    id: string,
    target: { activityId: string } | 'contract',
    fileId: string,
    ctx: RequestContext,
  ): Promise<PlantDetailView> {
    return this.asActor(access, async (tx) => {
      await this.open(tx, access, id, NEED.submit);
      const owner =
        target === 'contract' ? id : (await this.activity(tx, id, target.activityId)).id;
      await this.files.remove(
        tx,
        target === 'contract' ? 'PLANT_CONTRACT' : 'PLANT_ACTIVITY',
        owner,
        fileId,
        access.userId,
        ctx,
      );
      return this.detail(tx, access, id);
    });
  }

  /** Anyone who may open the plant may open its files (D-103). */
  async readFile(
    access: ResolvedAccess,
    id: string,
    target: { activityId: string } | 'contract',
    fileId: string,
    ctx: RequestContext,
  ): Promise<StoredFile> {
    return this.asActor(access, async (tx) => {
      await this.open(tx, access, id, NEED.view);
      const owner =
        target === 'contract' ? id : (await this.activity(tx, id, target.activityId)).id;
      return this.files.read(
        tx,
        target === 'contract' ? 'PLANT_CONTRACT' : 'PLANT_ACTIVITY',
        owner,
        fileId,
        access.userId,
        ctx,
      );
    });
  }
}
