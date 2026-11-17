import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/security/request-context';
import { Prisma } from '../../generated/prisma/client';
import {
  ACTIONS,
  DEFAULT_MODULE_SETTINGS,
  MODULES,
  PEOPLE_MESSAGES,
  STANDARD_ROLES,
  defaultActionAllowed,
  type Action,
  type CreateRoleInput,
  type DesignationMapInput,
  type Module,
  type ModuleSetting,
  type RoleAccessInput,
  type StandardRole,
} from '../../shared';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { rederiveBaseRoles } from './base-role';
import type { RoleSummary, RoleDetail, DesignationRow } from '../../shared';
export type { RoleSummary, RoleDetail, DesignationRow };

const STANDARD_ORDER = new Map<string, number>(STANDARD_ROLES.map((r, i) => [r.toLowerCase(), i]));

function isStandardName(name: string): name is StandardRole {
  return STANDARD_ORDER.has(name.toLowerCase());
}

function notFound(): AppError {
  return new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, PEOPLE_MESSAGES.roleNotFound);
}

/** Stored settings of a (non-Admin) role; anything missing counts as Hidden / No. */
async function readAccess(
  tx: Tx,
  roleId: string,
): Promise<{ modules: Record<Module, ModuleSetting>; actions: Record<Action, boolean> }> {
  const mods = await tx.roleModulePermission.findMany({
    where: { roleId },
    select: { module: true, setting: true },
  });
  const acts = await tx.roleActionPermission.findMany({
    where: { roleId },
    select: { action: true, allowed: true },
  });
  const m = new Map(mods.map((x) => [x.module, x.setting]));
  const a = new Map(acts.map((x) => [x.action, x.allowed]));
  return {
    modules: Object.fromEntries(MODULES.map((k) => [k, m.get(k) ?? 'HIDDEN'])) as Record<
      Module,
      ModuleSetting
    >,
    actions: Object.fromEntries(ACTIONS.map((k) => [k, a.get(k) ?? false])) as Record<
      Action,
      boolean
    >,
  };
}

function unprocessable(path: string, message: string): AppError {
  return new AppError(
    HttpStatus.BAD_REQUEST,
    ErrorCode.VALIDATION_FAILED,
    'Some fields are not valid.',
    [{ path, message }],
  );
}

/**
 * Role access screen and designation map (ROLE-5…8, ACT-1, DSG-1…3). A saved change applies to
 * everyone in the role on their next request — access is read fresh per request (D-70).
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async list(): Promise<RoleSummary[]> {
    const roles = await this.prisma.role.findMany({
      select: {
        id: true,
        name: true,
        isStandard: true,
        isAdmin: true,
        designations: { select: { designation: true }, orderBy: { designation: 'asc' } },
      },
    });
    const counts = await this.peopleCounts();
    return roles
      .map((r) => ({
        id: r.id,
        name: r.name,
        isStandard: r.isStandard,
        isAdmin: r.isAdmin,
        peopleCount: counts.get(r.id) ?? 0,
        designations: r.designations.map((d) => d.designation),
      }))
      .sort((a, b) => {
        const ia = a.isStandard ? (STANDARD_ORDER.get(a.name.toLowerCase()) ?? 99) : 100;
        const ib = b.isStandard ? (STANDARD_ORDER.get(b.name.toLowerCase()) ?? 99) : 100;
        return ia - ib || a.name.localeCompare(b.name);
      });
  }

  private async peopleCounts(roleId?: string): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<{ role_id: string; n: number }[]>`
      SELECT role_id, count(DISTINCT user_id)::int AS n FROM (
        SELECT base_role_id AS role_id, id AS user_id FROM users WHERE base_role_id IS NOT NULL
        UNION ALL
        SELECT role_id, user_id FROM plant_assignments
      ) x
      WHERE ${roleId ?? null}::uuid IS NULL OR role_id = ${roleId ?? null}::uuid
      GROUP BY role_id`;
    return new Map(rows.map((r) => [r.role_id, r.n]));
  }

  async get(id: string): Promise<RoleDetail> {
    const r = await this.prisma.role.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        isStandard: true,
        isAdmin: true,
        version: true,
        updatedAt: true,
        updatedBy: { select: { id: true, name: true } },
        modules: { select: { module: true, setting: true } },
        actions: { select: { action: true, allowed: true } },
        designations: { select: { designation: true }, orderBy: { designation: 'asc' } },
      },
    });
    if (!r) throw notFound();
    const stored = new Map(r.modules.map((m) => [m.module, m.setting]));
    const allowed = new Map(r.actions.map((a) => [a.action, a.allowed]));
    const counts = await this.peopleCounts(id);
    return {
      id: r.id,
      name: r.name,
      isStandard: r.isStandard,
      isAdmin: r.isAdmin,
      peopleCount: counts.get(id) ?? 0,
      designations: r.designations.map((d) => d.designation),
      version: r.version,
      // The Admin role always has everything (it cannot lock itself out).
      modules: Object.fromEntries(
        MODULES.map((m) => [m, r.isAdmin ? 'APPROVE' : (stored.get(m) ?? 'HIDDEN')]),
      ) as Record<Module, ModuleSetting>,
      actions: Object.fromEntries(
        ACTIONS.map((a) => [a, r.isAdmin ? true : (allowed.get(a) ?? false)]),
      ) as Record<Action, boolean>,
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  /** Lock the role row and check the version the Admin read (optimistic lock). */
  private async lockRole(
    tx: Tx,
    id: string,
    version: number,
  ): Promise<{ id: string; name: string; isAdmin: boolean; isStandard: boolean }> {
    const rows = await tx.$queryRaw<
      { id: string; name: string; is_admin: boolean; is_standard: boolean; version: number }[]
    >`SELECT id, name::text AS name, is_admin, is_standard, version FROM roles WHERE id = ${id}::uuid FOR UPDATE`;
    const r = rows[0];
    if (!r) throw notFound();
    if (r.is_admin)
      throw new AppError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, PEOPLE_MESSAGES.adminRoleLocked);
    if (r.version !== version)
      throw new AppError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, PEOPLE_MESSAGES.staleVersion);
    return { id: r.id, name: r.name, isAdmin: r.is_admin, isStandard: r.is_standard };
  }

  private async writeAccess(
    tx: Tx,
    roleId: string,
    modules: Readonly<Record<Module, ModuleSetting>>,
    actions: Readonly<Record<Action, boolean>>,
  ): Promise<void> {
    await tx.roleModulePermission.deleteMany({ where: { roleId } });
    await tx.roleModulePermission.createMany({
      data: MODULES.map((module) => ({ roleId, module, setting: modules[module] })),
    });
    await tx.roleActionPermission.deleteMany({ where: { roleId } });
    await tx.roleActionPermission.createMany({
      data: ACTIONS.map((action) => ({ roleId, action, allowed: actions[action] })),
    });
  }

  private async saveAccess(
    access: ResolvedAccess,
    id: string,
    version: number,
    next: (role: { name: string; isStandard: boolean }) => {
      modules: Record<Module, ModuleSetting>;
      actions: Record<Action, boolean>;
    },
    auditAction: AuditAction,
    ctx: RequestContext,
  ): Promise<RoleDetail> {
    await this.prisma.$transaction(async (tx) => {
      const role = await this.lockRole(tx, id, version);
      const before = await readAccess(tx, id);
      const target = next(role);
      await this.writeAccess(tx, id, target.modules, target.actions);
      await tx.role.update({
        where: { id },
        data: { version: { increment: 1 }, updatedById: access.userId },
      });
      await this.audit.record(
        {
          action: auditAction,
          entity: 'role',
          entityId: id,
          actorId: access.userId,
          before: { modules: before.modules, actions: before.actions },
          after: { modules: target.modules, actions: target.actions },
          ctx,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** Save changes (ROLE-6/7/8, ACT-1). Hide all modules is this call with every module Hidden. */
  update(
    access: ResolvedAccess,
    id: string,
    input: RoleAccessInput,
    ctx: RequestContext,
  ): Promise<RoleDetail> {
    return this.saveAccess(
      access,
      id,
      input.version,
      () => ({ modules: input.modules, actions: input.actions }),
      AuditAction.ROLE_CHANGE,
      ctx,
    );
  }

  /** Reset role to default (ROLE-8): the go-live matrix and action switches. */
  reset(
    access: ResolvedAccess,
    id: string,
    version: number,
    ctx: RequestContext,
  ): Promise<RoleDetail> {
    return this.saveAccess(
      access,
      id,
      version,
      (role) => {
        if (!role.isStandard || !isStandardName(role.name))
          throw new AppError(
            HttpStatus.CONFLICT,
            ErrorCode.CONFLICT,
            PEOPLE_MESSAGES.notStandardRole,
          );
        const standard = STANDARD_ROLES.find((s) => s.toLowerCase() === role.name.toLowerCase());
        if (standard === undefined)
          throw new AppError(
            HttpStatus.CONFLICT,
            ErrorCode.CONFLICT,
            PEOPLE_MESSAGES.notStandardRole,
          );
        return {
          modules: { ...DEFAULT_MODULE_SETTINGS[standard] },
          actions: Object.fromEntries(
            ACTIONS.map((a) => [a, defaultActionAllowed(standard, a)]),
          ) as Record<Action, boolean>,
        };
      },
      AuditAction.ROLE_RESET,
      ctx,
    );
  }

  /** Create new role (DSG-3): name, access copied from an existing role, designations mapped. */
  async create(
    access: ResolvedAccess,
    input: CreateRoleInput,
    ctx: RequestContext,
  ): Promise<RoleDetail> {
    const source = await this.get(input.copyFromRoleId).catch((e: unknown) => {
      if (e instanceof AppError && e.status === HttpStatus.NOT_FOUND)
        throw unprocessable('copyFromRoleId', PEOPLE_MESSAGES.copyFromRequired);
      throw e;
    });
    const id = await this.prisma.$transaction(async (tx) => {
      const designations = [
        ...new Set(
          await this.canonicalDesignations(tx, input.designations, (i) => `designations.${i}`),
        ),
      ];
      let role: { id: string };
      try {
        role = await tx.role.create({
          data: {
            name: input.name,
            isStandard: false,
            isAdmin: false,
            copiedFromId: source.id,
            updatedById: access.userId,
          },
          select: { id: true },
        });
      } catch (e: unknown) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw unprocessable('name', PEOPLE_MESSAGES.roleNameTaken);
        throw e;
      }
      // Copying Admin copies its full matrix, never the Admin flag itself.
      await this.writeAccess(tx, role.id, source.modules, source.actions);
      if (designations.length > 0) {
        await tx.designationRoleMap.createMany({
          data: designations.map((designation) => ({ designation, roleId: role.id })),
          skipDuplicates: true,
        });
      }
      const changed = await rederiveBaseRoles(tx, designations);
      await this.audit.record(
        {
          action: AuditAction.ROLE_CREATE,
          entity: 'role',
          entityId: role.id,
          actorId: access.userId,
          after: {
            name: input.name,
            copiedFrom: source.name,
            designations,
            baseRolesChanged: changed,
          },
          ctx,
        },
        tx,
      );
      return role.id;
    });
    return this.get(id);
  }

  /**
   * Designations as stored in KEKA data (DSG-1 “must match the KEKA export”). Matching ignores
   * case; the stored spelling is used. Unknown designations are a field error.
   */
  private async canonicalDesignations(
    tx: Tx,
    wanted: readonly string[],
    pathOf: (index: number) => string,
  ): Promise<string[]> {
    if (wanted.length === 0) return [];
    const lowered = wanted.map((d) => d.toLowerCase());
    const rows = await tx.$queryRaw<{ designation: string }[]>`
      SELECT min(designation::text) AS designation FROM users
      WHERE lower(designation::text) = ANY(${lowered}::text[])
      GROUP BY lower(designation::text)`;
    const byLower = new Map(rows.map((r) => [r.designation.toLowerCase(), r.designation]));
    return wanted.map((d, i) => {
      const found = byLower.get(d.toLowerCase());
      if (found === undefined) throw unprocessable(pathOf(i), PEOPLE_MESSAGES.designationUnknown);
      return found;
    });
  }

  async designations(): Promise<DesignationRow[]> {
    const people = await this.prisma.$queryRaw<{ designation: string; n: number }[]>`
      SELECT designation::text AS designation, count(*)::int AS n FROM users GROUP BY designation`;
    const maps = await this.prisma.designationRoleMap.findMany({
      select: { designation: true, role: { select: { id: true, name: true } } },
    });
    const rows = new Map<string, DesignationRow>();
    for (const p of people) {
      rows.set(p.designation.toLowerCase(), { designation: p.designation, roles: [], people: p.n });
    }
    for (const m of maps) {
      const key = m.designation.toLowerCase();
      const row = rows.get(key) ?? { designation: m.designation, roles: [], people: 0 };
      row.roles.push(m.role);
      rows.set(key, row);
    }
    return [...rows.values()]
      .map((r) => ({ ...r, roles: r.roles.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.designation.localeCompare(b.designation));
  }

  /** Map a designation to role(s) (DSG-1/2). Empty roles → unmapped. Base roles re-derived. */
  async mapDesignation(
    access: ResolvedAccess,
    input: DesignationMapInput,
    ctx: RequestContext,
  ): Promise<DesignationRow> {
    const roleIds = [...new Set(input.roleIds)];
    const designation = await this.prisma.$transaction(async (tx) => {
      const [canonical] = await this.canonicalDesignations(
        tx,
        [input.designation],
        () => 'designation',
      );
      if (canonical === undefined)
        throw unprocessable('designation', PEOPLE_MESSAGES.designationUnknown);
      const roles = await tx.role.findMany({
        where: { id: { in: roleIds } },
        select: { id: true },
      });
      if (roles.length !== roleIds.length)
        throw unprocessable('roleIds', PEOPLE_MESSAGES.roleNotFound);
      const before = await tx.$queryRaw<{ role_id: string }[]>`
        SELECT role_id FROM designation_role_map WHERE lower(designation::text) = lower(${canonical})`;
      await tx.$executeRaw`
        DELETE FROM designation_role_map WHERE lower(designation::text) = lower(${canonical})`;
      if (roleIds.length > 0) {
        await tx.designationRoleMap.createMany({
          data: roleIds.map((roleId) => ({ designation: canonical, roleId })),
        });
      }
      const changed = await rederiveBaseRoles(tx, [canonical]);
      await this.audit.record(
        {
          action: AuditAction.DESIGNATION_MAP_CHANGE,
          entity: 'designation',
          entityId: canonical.slice(0, 64),
          actorId: access.userId,
          before: { roleIds: before.map((b) => b.role_id).sort() },
          after: { roleIds: [...roleIds].sort(), baseRolesChanged: changed },
          ctx,
        },
        tx,
      );
      return canonical;
    });
    const rows = await this.designations();
    const row = rows.find((r) => r.designation.toLowerCase() === designation.toLowerCase());
    return row ?? { designation, roles: [], people: 0 };
  }
}
