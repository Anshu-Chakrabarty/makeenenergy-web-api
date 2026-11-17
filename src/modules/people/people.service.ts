import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { forbidden } from '../../common/access/access.guard';
import { hashPassword } from '../../common/crypto/password';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/security/request-context';
import type { Prisma } from '../../generated/prisma/client';
import {
  PEOPLE_MESSAGES,
  maskAadhaar,
  maskPhone,
  type AssignInput,
  type LoginChangeInput,
  type LoginsQuery,
  type PeopleQuery,
} from '../../shared';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { AuthStateService } from '../auth/auth-state.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SessionService } from '../auth/session.service';
import { designationRoles } from './base-role';
import type { PersonRow, PeopleCards, Page } from '../../shared';
export type { PersonRow, PeopleCards, Page };

const personSelect = {
  id: true,
  name: true,
  employeeCode: true,
  email: true,
  phone: true,
  aadhaarLast4: true,
  designation: true,
  photoUrl: true,
  loginStatus: true,
  workingStatus: true,
  lastLoginAt: true,
  baseRole: { select: { id: true, name: true } },
  // Assignments on deleted or RLS-invisible plants are left out (never a dangling relation).
  assignments: {
    where: { plant: { deletedAt: null } },
    select: {
      plant: { select: { id: true, name: true, code: true } },
      role: { select: { id: true, name: true } },
    },
    orderBy: { plant: { name: 'asc' } },
  },
} as const satisfies Prisma.UserSelect;

type PersonRecord = Prisma.UserGetPayload<{ select: typeof personSelect }>;

/** The parts of a target person that decide who may change them. */
interface TargetState {
  id: string;
  loginStatus: 'ACTIVE' | 'INACTIVE';
  workingStatus: 'WORKING' | 'RESIGNED';
  baseRoleId: string | null;
  holdsAdmin: boolean;
}

function notFound(): AppError {
  return new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, PEOPLE_MESSAGES.personNotFound);
}

function conflict(message: string): AppError {
  return new AppError(HttpStatus.CONFLICT, ErrorCode.CONFLICT, message);
}

function orderOf(query: PeopleQuery): Prisma.UserOrderByWithRelationInput[] {
  const dir = query.dir;
  const first: Prisma.UserOrderByWithRelationInput =
    query.sort === 'lastLoginAt'
      ? { lastLoginAt: { sort: dir, nulls: 'last' } }
      : query.sort === 'employeeCode'
        ? { employeeCode: dir }
        : query.sort === 'designation'
          ? { designation: dir }
          : { name: dir };
  return [first, { id: 'asc' }];
}

function searchWhere(q: string | undefined): Prisma.UserWhereInput {
  if (q === undefined) return {};
  const like = { contains: q, mode: 'insensitive' as const };
  return {
    OR: [{ name: like }, { employeeCode: like }, { email: like }, { designation: like }],
  };
}

/**
 * People (Admin panel). KEKA-owned fields are read-only here (GEN-6): this service only ever
 * writes plant assignments, roles, login status and the reset password.
 */
@Injectable()
export class PeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly sessions: SessionService,
    private readonly authState: AuthStateService,
    @Inject(ENV) private readonly env: Env,
    private readonly notices: NotificationsService,
  ) {}

  /** Sentences for event 6 from an assignment change, plus the plants it concerns. */
  private async accessChanges(
    tx: Tx,
    before: readonly { plantId: string; roleId: string }[],
    after: readonly { plantId: string; roleId: string }[],
    baseRole: { before: string | null; after: string },
    login: 'ON' | 'OFF' | null,
  ): Promise<{ lines: string[]; plantIds: string[] }> {
    const plantIds = [...new Set([...before, ...after].map((a) => a.plantId))];
    const roleIds = [...new Set([...before, ...after].map((a) => a.roleId).concat(baseRole.after))];
    const [plants, roles] = await Promise.all([
      tx.plant.findMany({ where: { id: { in: plantIds } }, select: { id: true, name: true } }),
      tx.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }),
    ]);
    const plant = (id: string): string => plants.find((p) => p.id === id)?.name ?? 'a plant';
    const role = (id: string): string => roles.find((r) => r.id === id)?.name ?? 'a role';
    const was = new Map(before.map((a) => [a.plantId, a.roleId]));
    const now = new Map(after.map((a) => [a.plantId, a.roleId]));
    const lines: string[] = [];
    const touched = new Set<string>();
    for (const [p, r] of now) {
      const old = was.get(p);
      if (old === undefined) lines.push(`Added to ${plant(p)} as ${role(r)}.`);
      else if (old !== r) lines.push(`Role on ${plant(p)} is now ${role(r)}.`);
      else continue;
      touched.add(p);
    }
    for (const p of was.keys())
      if (!now.has(p)) {
        lines.push(`Removed from ${plant(p)}.`);
        touched.add(p);
      }
    if (baseRole.before !== baseRole.after) lines.push(`Base role is now ${role(baseRole.after)}.`);
    if (login === 'ON') lines.push('Login turned on.');
    if (login === 'OFF') lines.push('Login turned off.');
    return { lines, plantIds: login ? after.map((a) => a.plantId) : [...touched] };
  }

  private asActor<T>(access: ResolvedAccess, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, fn);
  }

  async list(
    access: ResolvedAccess,
    query: PeopleQuery,
  ): Promise<Page<PersonRow> & { cards: PeopleCards }> {
    // Cards use the Search filters but not their own dimension (clicking a card sets it).
    const base: Prisma.UserWhereInput = {
      AND: [
        searchWhere(query.q),
        query.plantId ? { assignments: { some: { plantId: query.plantId } } } : {},
        query.roleId
          ? {
              OR: [
                { baseRoleId: query.roleId },
                { assignments: { some: { roleId: query.roleId } } },
              ],
            }
          : {},
      ],
    };
    const where: Prisma.UserWhereInput = {
      AND: [
        base,
        query.loginStatus ? { loginStatus: query.loginStatus } : {},
        query.workingStatus ? { workingStatus: query.workingStatus } : {},
      ],
    };
    return this.asActor(access, async (tx) => {
      // One connection per transaction: run the queries one after another.
      const records = await tx.user.findMany({
        where,
        select: personSelect,
        orderBy: orderOf(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      const total = await tx.user.count({ where });
      const byWorking = await tx.user.groupBy({
        by: ['workingStatus'],
        where: base,
        _count: { _all: true },
      });
      const byLogin = await tx.user.groupBy({
        by: ['loginStatus'],
        where: base,
        _count: { _all: true },
      });
      const working = (s: string): number =>
        byWorking.find((r) => r.workingStatus === s)?._count._all ?? 0;
      const login = (s: string): number =>
        byLogin.find((r) => r.loginStatus === s)?._count._all ?? 0;
      return {
        rows: await this.toRows(tx, records),
        total,
        page: query.page,
        pageSize: query.pageSize,
        cards: {
          working: working('WORKING'),
          resigned: working('RESIGNED'),
          activeLogins: login('ACTIVE'),
          inactiveLogins: login('INACTIVE'),
        },
      };
    });
  }

  async logins(access: ResolvedAccess, query: LoginsQuery): Promise<Page<PersonRow>> {
    const where: Prisma.UserWhereInput = {
      AND: [searchWhere(query.q), query.loginStatus ? { loginStatus: query.loginStatus } : {}],
    };
    return this.asActor(access, async (tx) => {
      const records = await tx.user.findMany({
        where,
        select: personSelect,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      const total = await tx.user.count({ where });
      return {
        rows: await this.toRows(tx, records),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  async get(access: ResolvedAccess, id: string): Promise<PersonRow> {
    return this.asActor(access, async (tx) => {
      const record = await tx.user.findUnique({ where: { id }, select: personSelect });
      if (!record) throw notFound();
      const [row] = await this.toRows(tx, [record]);
      if (!row) throw notFound();
      return row;
    });
  }

  private async toRows(tx: Tx, records: readonly PersonRecord[]): Promise<PersonRow[]> {
    const map = await designationRoles(tx);
    const roleIds = [...new Set([...map.values()].flat())];
    const roles = await tx.role.findMany({
      where: { id: { in: roleIds } },
      select: { id: true, name: true },
    });
    const roleName = new Map(roles.map((r) => [r.id, r.name]));
    return records.map((r) => ({
      id: r.id,
      name: r.name,
      employeeCode: r.employeeCode,
      email: r.email,
      phone: r.phone ? maskPhone(r.phone) : null,
      aadhaar: r.aadhaarLast4 ? maskAadhaar(r.aadhaarLast4) : null,
      designation: r.designation,
      photoUrl: r.photoUrl,
      plants: r.assignments.map((a) => ({ ...a.plant, role: a.role })),
      role: r.baseRole,
      mappedRoles: (map.get(r.designation.toLowerCase()) ?? []).flatMap((id) => {
        const name = roleName.get(id);
        return name === undefined ? [] : [{ id, name }];
      }),
      loginStatus: r.loginStatus,
      workingStatus: r.workingStatus,
      lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
      hasRole: r.baseRole !== null || r.assignments.length > 0,
    }));
  }

  /**
   * Lock the person's row and check the actor may change them:
   *  - nobody changes their own plant, role or login (no self-escalation, no Admin lock-out);
   *  - only an Admin may change someone who holds the Admin role.
   */
  private async lockTarget(tx: Tx, access: ResolvedAccess, id: string): Promise<TargetState> {
    if (id === access.userId) throw forbidden(PEOPLE_MESSAGES.selfChange);
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notFound();
    const u = await tx.user.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        loginStatus: true,
        workingStatus: true,
        baseRoleId: true,
        baseRole: { select: { isAdmin: true } },
        assignments: { select: { role: { select: { isAdmin: true } } } },
      },
    });
    const holdsAdmin = u.baseRole?.isAdmin === true || u.assignments.some((a) => a.role.isAdmin);
    if (holdsAdmin && !access.isAdmin) throw forbidden(PEOPLE_MESSAGES.adminOnly);
    return {
      id: u.id,
      loginStatus: u.loginStatus,
      workingStatus: u.workingStatus,
      baseRoleId: u.baseRoleId,
      holdsAdmin,
    };
  }

  /** Revoke sessions inside the transaction; returns families to mark revoked after commit. */
  private async deactivateTx(tx: Tx, id: string): Promise<string[]> {
    await tx.user.update({
      where: { id },
      data: { loginStatus: 'INACTIVE', tokenVersion: { increment: 1 } },
    });
    return this.sessions.revokeAllForUser(tx, id, 'DEACTIVATED');
  }

  private async afterCommit(userId: string, families: readonly string[]): Promise<void> {
    await this.authState.invalidateUser(userId);
    await Promise.all(families.map((f) => this.authState.markFamilyRevoked(f)));
  }

  /** Assign (PPL-A1…A4, ROLE-2, ROLE-4): plants, role per plant, base role and login. */
  async assign(
    access: ResolvedAccess,
    id: string,
    input: AssignInput,
    ctx: RequestContext,
  ): Promise<PersonRow> {
    const families = await this.asActor(access, async (tx) => {
      const target = await this.lockTarget(tx, access, id);

      const roleIds = [...new Set([input.roleId, ...input.plantRoles.map((p) => p.roleId)])];
      const roles = await tx.role.findMany({
        where: { id: { in: roleIds } },
        select: { id: true, name: true, isAdmin: true },
      });
      if (roles.length !== roleIds.length)
        throw new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, PEOPLE_MESSAGES.roleNotFound);
      if (!access.isAdmin && roles.some((r) => r.isAdmin))
        throw forbidden(PEOPLE_MESSAGES.adminOnly);

      // Plants the actor can see (RLS): Admin sees all; anyone else only their own plants.
      const visible = await tx.plant.findMany({ where: { deletedAt: null }, select: { id: true } });
      const visibleIds = new Set(visible.map((p) => p.id));
      const chosen = input.allPlants ? [...visibleIds] : input.plantIds;
      if (chosen.length === 0)
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_FAILED,
          'Some fields are not valid.',
          [{ path: 'plantIds', message: PEOPLE_MESSAGES.plantRequired }],
        );
      if (chosen.some((p) => !visibleIds.has(p)))
        throw new AppError(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          PEOPLE_MESSAGES.plantNotFound,
        );
      if (input.loginStatus === 'ACTIVE' && target.workingStatus === 'RESIGNED')
        throw conflict(PEOPLE_MESSAGES.resignedCannotLogin);

      const before = await tx.plantAssignment.findMany({
        where: { userId: id },
        select: { plantId: true, roleId: true },
        orderBy: { plantId: 'asc' },
      });
      const roleFor = new Map(input.plantRoles.map((p) => [p.plantId, p.roleId]));
      // Replace only within the plants the actor can see; others are left as they are.
      await tx.plantAssignment.deleteMany({
        where: { userId: id, plantId: { in: [...visibleIds], notIn: chosen } },
      });
      for (const plantId of chosen) {
        const roleId = roleFor.get(plantId) ?? input.roleId;
        await tx.plantAssignment.upsert({
          where: { userId_plantId: { userId: id, plantId } },
          create: {
            userId: id,
            plantId,
            roleId,
            assignedById: access.userId,
            remarks: input.remarks ?? null,
          },
          update: { roleId, assignedById: access.userId, remarks: input.remarks ?? null },
        });
      }

      const deactivating = target.loginStatus === 'ACTIVE' && input.loginStatus === 'INACTIVE';
      await tx.user.update({
        where: { id },
        data: {
          baseRoleId: input.roleId,
          ...(deactivating ? {} : { loginStatus: input.loginStatus }),
        },
      });
      const revoked = deactivating ? await this.deactivateTx(tx, id) : [];

      await this.audit.record(
        {
          action: AuditAction.ASSIGNMENT_CHANGE,
          entity: 'user',
          entityId: id,
          actorId: access.userId,
          before: {
            baseRoleId: target.baseRoleId,
            loginStatus: target.loginStatus,
            assignments: before,
          },
          after: {
            baseRoleId: input.roleId,
            loginStatus: input.loginStatus,
            assignments: chosen
              .map((plantId) => ({ plantId, roleId: roleFor.get(plantId) ?? input.roleId }))
              .sort((a, b) => a.plantId.localeCompare(b.plantId)),
          },
          reason: input.remarks ?? null,
          ctx,
        },
        tx,
      );
      const changes = await this.accessChanges(
        tx,
        before,
        chosen.map((plantId) => ({ plantId, roleId: roleFor.get(plantId) ?? input.roleId })),
        { before: target.baseRoleId, after: input.roleId },
        target.loginStatus === input.loginStatus
          ? null
          : input.loginStatus === 'ACTIVE'
            ? 'ON'
            : 'OFF',
      );
      await this.notices.accessChanged(tx, {
        userId: id,
        actorId: access.userId,
        changes: changes.lines,
        plantIds: changes.plantIds,
      });
      return revoked;
    });
    await this.afterCommit(id, families);
    return this.get(access, id);
  }

  /** Event 6 for a login switched on or off: the person and their plants' managers. */
  private async loginChanged(
    tx: Tx,
    access: ResolvedAccess,
    id: string,
    on: boolean,
  ): Promise<void> {
    const plants = await tx.plantAssignment.findMany({
      where: { userId: id },
      select: { plantId: true },
    });
    await this.notices.accessChanged(tx, {
      userId: id,
      actorId: access.userId,
      changes: [on ? 'Login turned on.' : 'Login turned off.'],
      plantIds: plants.map((p) => p.plantId),
    });
  }

  async activate(
    access: ResolvedAccess,
    id: string,
    input: LoginChangeInput,
    ctx: RequestContext,
  ): Promise<PersonRow> {
    await this.asActor(access, async (tx) => {
      const target = await this.lockTarget(tx, access, id);
      if (target.workingStatus === 'RESIGNED') throw conflict(PEOPLE_MESSAGES.resignedCannotLogin);
      if (target.loginStatus === 'ACTIVE') return;
      await tx.user.update({ where: { id }, data: { loginStatus: 'ACTIVE' } });
      await this.audit.record(
        {
          action: AuditAction.LOGIN_ACTIVATED,
          entity: 'user',
          entityId: id,
          actorId: access.userId,
          before: { loginStatus: 'INACTIVE' },
          after: { loginStatus: 'ACTIVE' },
          reason: input.remarks ?? null,
          ctx,
        },
        tx,
      );
      await this.loginChanged(tx, access, id, true);
    });
    await this.authState.invalidateUser(id);
    return this.get(access, id);
  }

  /** Deactivate (ULG-T7): the login stops at once — sessions revoked, token version bumped. */
  async deactivate(
    access: ResolvedAccess,
    id: string,
    input: LoginChangeInput,
    ctx: RequestContext,
  ): Promise<PersonRow> {
    const families = await this.asActor(access, async (tx) => {
      const target = await this.lockTarget(tx, access, id);
      if (target.loginStatus === 'INACTIVE') return [];
      const revoked = await this.deactivateTx(tx, id);
      await this.audit.record(
        {
          action: AuditAction.LOGIN_DEACTIVATED,
          entity: 'user',
          entityId: id,
          actorId: access.userId,
          before: { loginStatus: 'ACTIVE' },
          after: { loginStatus: 'INACTIVE', sessionsRevoked: revoked.length },
          reason: input.remarks ?? null,
          ctx,
        },
        tx,
      );
      await this.loginChanged(tx, access, id, false);
      return revoked;
    });
    await this.afterCommit(id, families);
    return this.get(access, id);
  }

  /**
   * Reset to default password (ULG-T7, AUTH-5). The default never opens a session — signing in
   * with it answers PASSWORD_CHANGE_REQUIRED — and the person stays signed in until Logout
   * (spec Login; D-72). They set a new password with OTP from the Login screen.
   */
  async resetPassword(access: ResolvedAccess, id: string, ctx: RequestContext): Promise<void> {
    const hash = await hashPassword(this.env.RESET_DEFAULT_PASSWORD, this.env.PASSWORD_PEPPER);
    await this.asActor(access, async (tx) => {
      await this.lockTarget(tx, access, id);
      await tx.user.update({ where: { id }, data: { passwordHash: hash, mustSetPassword: true } });
      await this.audit.record(
        {
          action: AuditAction.PASSWORD_RESET,
          entity: 'user',
          entityId: id,
          actorId: access.userId,
          ctx,
        },
        tx,
      );
    });
    await this.authState.invalidateUser(id);
  }
}
