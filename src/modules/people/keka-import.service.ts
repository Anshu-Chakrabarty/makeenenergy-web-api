import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { decryptAadhaar, encryptAadhaar } from '../../common/crypto/aadhaar';
import type { RequestContext } from '../../common/security/request-context';
import type { Prisma } from '../../generated/prisma/client';
import {
  KEKA_COLUMNS,
  KEKA_MESSAGES,
  isAllowedEmail,
  kekaRowSchema,
  maskAadhaar,
  maskPhone,
  type ImportOutcome,
  type KekaColumnKey,
  type KekaRow,
} from '../../shared';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService, type AuditEntry } from '../audit-log/audit-log.service';
import { AuthStateService } from '../auth/auth-state.service';
import { SessionService } from '../auth/session.service';
import { designationRoles, nextBaseRole } from './base-role';
import type { SourceRow } from './keka-file';
import type {
  ImportSource,
  ImportRowResult,
  ImportTotals,
  ImportReport,
  ImportStatus,
} from '../../shared';
export type { ImportSource, ImportRowResult, ImportTotals, ImportReport, ImportStatus };

const LABEL = Object.fromEntries(KEKA_COLUMNS.map((c) => [c.key, c.header])) as Record<
  KekaColumnKey,
  string
>;

const NOTES = {
  resigned: 'Resigned in KEKA — login set to Inactive and signed out.',
  rejoined: 'Working again in KEKA — the login stays Inactive until Admin activates it.',
  unmapped: 'Designation is not in the designation map — cannot sign in until mapped or assigned.',
  severalRoles: 'Designation maps to several roles — Admin picks the role before sign-in.',
  checkRoles: 'Designation changed — check this person’s plant roles.',
  newInactive: 'New person — the login starts Inactive.',
} as const;

/** How many row results the stored batch report keeps (unchanged rows are counted, not listed). */
const STORED_ROWS = 5_000;

interface Existing {
  id: string;
  employeeCode: string;
  name: string;
  email: string;
  phone: string | null;
  aadhaarEnc: Uint8Array | null;
  aadhaarKeyId: string | null;
  designation: string;
  workingStatus: 'WORKING' | 'RESIGNED';
  loginStatus: 'ACTIVE' | 'INACTIVE';
  baseRoleId: string | null;
  _count: { assignments: number };
}

interface Planned {
  result: ImportRowResult;
  /** Null for rows with errors. */
  row: KekaRow | null;
  existing: Existing | null;
  /** Aadhaar changed (or must be re-encrypted under the current key). */
  aadhaarChanged: boolean;
}

/**
 * KEKA loader (PPL-2, PPL-3): validate → diff by employee code → dry-run preview or apply.
 * Only KEKA-owned fields are written; plants, roles and login are Admin's (GEN-6). People missing
 * from a file are left as they are — a partial export never deactivates anyone (D-73).
 */
@Injectable()
export class KekaImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly sessions: SessionService,
    private readonly authState: AuthStateService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async status(apiConfigured: boolean): Promise<ImportStatus> {
    const last = await this.prisma.kekaImportBatch.findFirst({
      where: { dryRun: false, finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' },
      select: {
        finishedAt: true,
        source: true,
        fileName: true,
        totalRows: true,
        created: true,
        updated: true,
        unchanged: true,
        failed: true,
      },
    });
    return {
      apiConfigured,
      last: !last?.finishedAt
        ? null
        : {
            at: last.finishedAt.toISOString(),
            source: last.source,
            fileName: last.fileName,
            totals: {
              total: last.totalRows,
              created: last.created,
              updated: last.updated,
              unchanged: last.unchanged,
              failed: last.failed,
            },
          },
    };
  }

  async run(
    access: ResolvedAccess,
    rows: readonly SourceRow[],
    opts: { source: ImportSource; fileName: string | null; dryRun: boolean },
    ctx: RequestContext,
  ): Promise<ImportReport> {
    const plan = await this.plan(rows);
    const batchId = randomUUID();
    const totals = totalsOf(plan.map((p) => p.result));

    const touched: string[] = [];
    const families: string[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        if (!opts.dryRun) {
          const applied = await this.apply(tx, access, plan, batchId, ctx);
          touched.push(...applied.touched);
          families.push(...applied.families);
          await this.audit.record(
            {
              action: AuditAction.KEKA_IMPORT,
              entity: 'keka_import',
              entityId: batchId,
              actorId: access.userId,
              after: { source: opts.source, fileName: opts.fileName, ...totals },
              ctx,
            },
            tx,
          );
        }
        await tx.kekaImportBatch.create({
          data: {
            id: batchId,
            source: opts.source,
            fileName: opts.fileName,
            dryRun: opts.dryRun,
            startedById: access.userId,
            finishedAt: new Date(),
            totalRows: totals.total,
            created: totals.created,
            updated: totals.updated,
            unchanged: totals.unchanged,
            failed: totals.failed,
            report: plan
              .map((p) => p.result)
              .filter((r) => r.outcome !== 'UNCHANGED')
              .slice(0, STORED_ROWS) as unknown as Prisma.InputJsonValue,
          },
        });
      },
      { timeout: 180_000, maxWait: 10_000 },
    );

    await Promise.all(touched.map((id) => this.authState.invalidateUser(id)));
    await Promise.all(families.map((f) => this.authState.markFamilyRevoked(f)));
    return {
      batchId,
      source: opts.source,
      fileName: opts.fileName,
      dryRun: opts.dryRun,
      finishedAt: new Date().toISOString(),
      totals,
      rows: plan.map((p) => p.result),
    };
  }

  /** Validate every row and work out what would change. Reads only. */
  private async plan(rows: readonly SourceRow[]): Promise<Planned[]> {
    const parsed: { result: ImportRowResult; row: KekaRow | null }[] = rows.map((src) => {
      const result: ImportRowResult = {
        row: src.row,
        employeeCode: src.values.employeeCode?.trim().toUpperCase() || null,
        name: src.values.name?.trim() || null,
        outcome: 'ERROR',
        changes: [],
        errors: [],
        notes: [],
      };
      const r = kekaRowSchema.safeParse(src.values);
      if (!r.success) {
        result.errors = r.error.issues.map((i) => {
          const key = String(i.path[0] ?? '');
          const column = KEKA_COLUMNS.find((c) => c.key === key);
          return { field: column?.header ?? key, message: i.message };
        });
        return { result, row: null };
      }
      if (!isAllowedEmail(r.data.email, this.env.ALLOWED_EMAIL_DOMAINS)) {
        result.errors.push({ field: LABEL.email, message: KEKA_MESSAGES.emailNotMakeen });
        return { result, row: null };
      }
      return { result, row: r.data };
    });

    // Duplicates inside the file: every copy is an error (which one is right is KEKA's call).
    const countBy = (key: (r: KekaRow) => string): Map<string, number> => {
      const m = new Map<string, number>();
      for (const p of parsed) if (p.row) m.set(key(p.row), (m.get(key(p.row)) ?? 0) + 1);
      return m;
    };
    const codes = countBy((r) => r.employeeCode);
    const emails = countBy((r) => r.email);
    for (const p of parsed) {
      if (!p.row) continue;
      if ((codes.get(p.row.employeeCode) ?? 0) > 1)
        p.result.errors.push({ field: LABEL.employeeCode, message: KEKA_MESSAGES.duplicateCode });
      if ((emails.get(p.row.email) ?? 0) > 1)
        p.result.errors.push({ field: LABEL.email, message: KEKA_MESSAGES.duplicateEmail });
      if (p.result.errors.length > 0) p.row = null;
    }

    const valid = parsed.flatMap((p) => (p.row ? [p.row] : []));
    const existing = await this.prisma.user.findMany({
      where: { employeeCode: { in: valid.map((r) => r.employeeCode) } },
      select: {
        id: true,
        employeeCode: true,
        name: true,
        email: true,
        phone: true,
        aadhaarEnc: true,
        aadhaarKeyId: true,
        designation: true,
        workingStatus: true,
        loginStatus: true,
        baseRoleId: true,
        _count: { select: { assignments: true } },
      },
    });
    const byCode = new Map(existing.map((e) => [e.employeeCode.toUpperCase(), e]));
    const emailOwners = await this.prisma.user.findMany({
      where: { email: { in: valid.map((r) => r.email) } },
      select: { email: true, employeeCode: true },
    });
    const ownerOf = new Map(
      emailOwners.map((o) => [o.email.toLowerCase(), o.employeeCode.toUpperCase()]),
    );
    const map = await designationRoles(this.prisma);

    return parsed.map((p): Planned => {
      if (!p.row) return { result: p.result, row: null, existing: null, aadhaarChanged: false };
      const row = p.row;
      const owner = ownerOf.get(row.email);
      if (owner !== undefined && owner !== row.employeeCode) {
        p.result.errors.push({ field: LABEL.email, message: KEKA_MESSAGES.emailTaken });
        return { result: p.result, row: null, existing: null, aadhaarChanged: false };
      }
      const mapped = map.get(row.designation.toLowerCase()) ?? [];
      const e = byCode.get(row.employeeCode) ?? null;
      if (e === null) {
        p.result.outcome = 'CREATE';
        p.result.notes.push(NOTES.newInactive);
        if (mapped.length === 0) p.result.notes.push(NOTES.unmapped);
        if (mapped.length > 1) p.result.notes.push(NOTES.severalRoles);
        return { result: p.result, row, existing: null, aadhaarChanged: row.aadhaar !== undefined };
      }
      const aadhaarChanged = this.aadhaarDiffers(e, row.aadhaar ?? null);
      const changes: string[] = [];
      if (e.name !== row.name) changes.push(LABEL.name);
      if (e.email.toLowerCase() !== row.email) changes.push(LABEL.email);
      if ((e.phone ?? null) !== (row.phone ?? null)) changes.push(LABEL.phone);
      if (aadhaarChanged) changes.push(LABEL.aadhaar);
      if (e.designation !== row.designation) changes.push(LABEL.designation);
      if (e.workingStatus !== row.workingStatus) changes.push(LABEL.workingStatus);
      p.result.changes = changes;
      p.result.outcome = changes.length === 0 ? 'UNCHANGED' : 'UPDATE';
      if (row.workingStatus === 'RESIGNED' && e.workingStatus === 'WORKING')
        p.result.notes.push(NOTES.resigned);
      if (row.workingStatus === 'WORKING' && e.workingStatus === 'RESIGNED')
        p.result.notes.push(NOTES.rejoined);
      if (e.designation.toLowerCase() !== row.designation.toLowerCase()) {
        if (e._count.assignments > 0) p.result.notes.push(NOTES.checkRoles);
        else if (mapped.length === 0) p.result.notes.push(NOTES.unmapped);
        else if (mapped.length > 1) p.result.notes.push(NOTES.severalRoles);
      }
      return { result: p.result, row, existing: e, aadhaarChanged };
    });
  }

  private aadhaarDiffers(e: Existing, next: string | null): boolean {
    if (e.aadhaarEnc === null) return next !== null;
    if (next === null) return true;
    if (e.aadhaarKeyId !== this.env.AADHAAR_ENC_KEY_ID) return true; // re-encrypt under current key
    try {
      const current = decryptAadhaar(
        Buffer.from(e.aadhaarEnc),
        this.env.AADHAAR_ENC_KEY_B64,
        e.aadhaarKeyId,
      );
      return current !== next;
    } catch {
      return true;
    }
  }

  private aadhaarFields(digits: string | undefined): {
    aadhaarEnc: Uint8Array<ArrayBuffer> | null;
    aadhaarKeyId: string | null;
    aadhaarLast4: string | null;
  } {
    if (digits === undefined) return { aadhaarEnc: null, aadhaarKeyId: null, aadhaarLast4: null };
    const enc = encryptAadhaar(digits, this.env.AADHAAR_ENC_KEY_B64, this.env.AADHAAR_ENC_KEY_ID);
    return {
      aadhaarEnc: new Uint8Array(enc.enc),
      aadhaarKeyId: enc.keyId,
      aadhaarLast4: enc.last4,
    };
  }

  private async apply(
    tx: Tx,
    access: ResolvedAccess,
    plan: readonly Planned[],
    batchId: string,
    ctx: RequestContext,
  ): Promise<{ touched: string[]; families: string[] }> {
    const now = new Date();
    const map = await designationRoles(tx);
    const audits: AuditEntry[] = [];
    const touched: string[] = [];
    const families: string[] = [];

    const creates = plan.flatMap((p) => (p.result.outcome === 'CREATE' && p.row ? [p.row] : []));
    if (creates.length > 0) {
      const made = await tx.user.createManyAndReturn({
        data: creates.map((row) => ({
          employeeCode: row.employeeCode,
          name: row.name,
          email: row.email,
          phone: row.phone ?? null,
          ...this.aadhaarFields(row.aadhaar),
          designation: row.designation,
          workingStatus: row.workingStatus,
          loginStatus: 'INACTIVE' as const,
          mustSetPassword: true,
          baseRoleId: nextBaseRole(null, map.get(row.designation.toLowerCase()) ?? [], false),
          kekaSyncedAt: now,
        })),
        select: { id: true, employeeCode: true },
      });
      for (const m of made) {
        audits.push({
          action: AuditAction.CREATE,
          entity: 'user',
          entityId: m.id,
          actorId: access.userId,
          after: { source: 'KEKA', batchId, employeeCode: m.employeeCode },
          ctx,
        });
      }
    }

    for (const p of plan) {
      if (p.result.outcome !== 'UPDATE' || p.existing === null || p.row === null) continue;
      const e = p.existing;
      const row = p.row;
      const resigning = row.workingStatus === 'RESIGNED' && e.workingStatus === 'WORKING';
      const designationChanged = e.designation !== row.designation;
      const data: Prisma.UserUpdateInput = {
        name: row.name,
        email: row.email,
        phone: row.phone ?? null,
        designation: row.designation,
        workingStatus: row.workingStatus,
        kekaSyncedAt: now,
        ...(p.aadhaarChanged ? this.aadhaarFields(row.aadhaar) : {}),
        ...(designationChanged
          ? {
              baseRole: connectOrNull(
                nextBaseRole(
                  e.baseRoleId,
                  map.get(row.designation.toLowerCase()) ?? [],
                  e._count.assignments > 0,
                ),
              ),
            }
          : {}),
        ...(resigning ? { loginStatus: 'INACTIVE', tokenVersion: { increment: 1 } } : {}),
      };
      await tx.user.update({ where: { id: e.id }, data });
      if (resigning) families.push(...(await this.sessions.revokeAllForUser(tx, e.id, 'RESIGNED')));
      touched.push(e.id);
      audits.push({
        action: AuditAction.KEKA_SYNC,
        entity: 'user',
        entityId: e.id,
        actorId: access.userId,
        // Field names, plus non-sensitive old/new values; phone and Aadhaar only masked.
        before: {
          name: e.name,
          designation: e.designation,
          workingStatus: e.workingStatus,
          phone: e.phone ? maskPhone(e.phone) : null,
        },
        after: {
          batchId,
          changes: p.result.changes,
          name: row.name,
          designation: row.designation,
          workingStatus: row.workingStatus,
          phone: row.phone ? maskPhone(row.phone) : null,
          ...(p.aadhaarChanged && row.aadhaar
            ? { aadhaar: maskAadhaar(row.aadhaar.slice(-4)) }
            : {}),
          signedOut: resigning,
        },
        ctx,
      });
    }
    await this.audit.recordMany(audits, tx);
    return { touched, families };
  }
}

function connectOrNull(id: string | null): Prisma.RoleUpdateOneWithoutBaseUsersNestedInput {
  return id === null ? { disconnect: true } : { connect: { id } };
}

function totalsOf(results: readonly ImportRowResult[]): ImportTotals {
  const n = (o: ImportOutcome): number => results.filter((r) => r.outcome === o).length;
  return {
    total: results.length,
    created: n('CREATE'),
    updated: n('UPDATE'),
    unchanged: n('UNCHANGED'),
    failed: n('ERROR'),
  };
}
