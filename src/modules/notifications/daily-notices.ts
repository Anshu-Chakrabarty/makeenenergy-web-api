import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { isoDayOrNull } from '../../common/db/people-names';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  effectiveTargetDate,
  formatDate,
  istToday,
  licenceStatus,
  observationUrgency,
  type DailyNoticeRun,
} from '../../shared';
import { NotificationsService } from './notifications.service';

/** The system acts as Admin for scheduled work (it must see every plant). */
export const SYSTEM_ACTOR = { userId: '00000000-0000-0000-0000-000000000000', isAdmin: true };

/** Stable short hash for dedupe keys built from free text. */
export const keyHash = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * The daily IST job (NOTIF-J1): Licence Due / Expired → its remind list (event 4) and audit
 * observations past their target → the Plant Manager (event 5).
 *
 * Idempotent by construction: every notice carries a dedupe key that names the row and the
 * state it is in (`licence-due:<id>:<end date>`, `audit-overdue:<id>:<target>`), so running the
 * job twice — or on two servers — raises each notice once. A renewed licence (new end date) or
 * a revised target date is a new key, and so a new notice.
 */
@Injectable()
export class DailyNoticesJob {
  private readonly log = new Logger(DailyNoticesJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notices: NotificationsService,
  ) {}

  async run(today: string = istToday()): Promise<DailyNoticeRun> {
    const result: DailyNoticeRun = {
      date: today,
      licenceDue: 0,
      licenceExpired: 0,
      auditOverdue: 0,
      alreadyRaised: 0,
    };
    await this.prisma.runAs(SYSTEM_ACTOR, async (tx) => {
      await this.licences(tx, today, result);
      await this.observations(tx, today, result);
      await this.unmappedDesignations(tx, today);
    });
    this.log.log(
      `Daily notices ${today}: licence due ${String(result.licenceDue)}, expired ${String(result.licenceExpired)}, audit overdue ${String(result.auditOverdue)}, already raised ${String(result.alreadyRaised)}`,
    );
    return result;
  }

  private async adminIds(tx: Tx): Promise<string[]> {
    const rows = await tx.user.findMany({
      where: {
        loginStatus: 'ACTIVE',
        workingStatus: 'WORKING',
        OR: [
          { baseRole: { isAdmin: true } },
          { assignments: { some: { role: { isAdmin: true } } } },
        ],
      },
      select: { id: true },
    });
    return rows.map((u) => u.id);
  }

  private async licences(tx: Tx, today: string, result: DailyNoticeRun): Promise<void> {
    const rows = await tx.licence.findMany({
      where: { plant: { deletedAt: null }, endDate: { not: null }, startDate: { not: null } },
      select: {
        id: true,
        plantId: true,
        licenceType: true,
        docRef: true,
        startDate: true,
        endDate: true,
        frequency: true,
        remindBeforeDays: true,
        item: { select: { title: true } },
        plant: { select: { name: true, managerId: true } },
        remindUsers: { select: { userId: true } },
      },
    });
    const admins = await this.adminIds(tx);
    type Hit = {
      id: string;
      plantId: string;
      plantName: string;
      title: string;
      kind: string;
      status: 'DUE' | 'EXPIRED';
      endDate: string | null;
      recipients: string[];
    };
    const hits: Hit[] = [];
    for (const l of rows) {
      const endDate = isoDayOrNull(l.endDate);
      const status = licenceStatus(
        {
          frequency: l.frequency,
          startDate: isoDayOrNull(l.startDate),
          endDate,
          remindBeforeDays: l.remindBeforeDays,
        },
        today,
      );
      if (status !== 'DUE' && status !== 'EXPIRED') continue;
      const listed = l.remindUsers.map((u) => u.userId);
      const recipients = [
        ...new Set([...listed, ...(listed.length === 0 ? [l.plant.managerId] : []), ...admins]),
      ];
      const calibration = l.licenceType !== 'STATUTORY';
      hits.push({
        id: l.id,
        plantId: l.plantId,
        plantName: l.plant.name,
        title: l.item.title,
        kind: calibration ? 'Calibration' : 'Licence',
        status,
        endDate,
        recipients,
      });
    }
    const groups = new Map<string, Hit[]>();
    for (const h of hits) {
      const key = `${h.plantId}:${h.status}`;
      const list = groups.get(key) ?? [];
      list.push(h);
      groups.set(key, list);
    }
    const skipped: string[] = [];
    for (const group of groups.values()) {
      const first = group[0];
      if (!first) continue;
      const verb = first.status === 'EXPIRED' ? 'overdue' : 'due';
      const kinds = [...new Set(group.map((g) => g.kind))].join(' and ');
      const names = group.map((g) => g.title);
      const title =
        group.length === 1
          ? `${first.kind} ${verb} – ${first.title} (${first.plantName})`
          : `${kinds} ${verb} – ${String(group.length)} items (${first.plantName})`;
      const outcome = await this.notices.notify(tx, {
        category: 'SYSTEM',
        event: 'LICENCE_DUE',
        title,
        body: names.join(', '),
        plantId: first.plantId,
        link: { entity: 'licence', id: first.id },
        recipients: [...new Set(group.flatMap((g) => g.recipients))],
        canAcknowledge: true,
        dedupeKey: `licence-${first.status.toLowerCase()}:${first.plantId}:${today}`,
        sentTo: `Plant Manager and Admin, ${first.plantName}`,
      });
      if (outcome.state === 'DUPLICATE') result.alreadyRaised += 1;
      else if (outcome.state === 'SENT') {
        if (first.status === 'DUE') result.licenceDue += group.length;
        else result.licenceExpired += group.length;
      } else if (outcome.state === 'SKIPPED') skipped.push(`${first.plantName}: ${title}`);
    }
    if (skipped.length > 0 && admins.length > 0) {
      await this.notices.notify(tx, {
        category: 'SYSTEM',
        event: 'LICENCE_DUE',
        title: `Skipped licence reminders – ${today}`,
        body: skipped.join('; '),
        recipients: admins,
        canAcknowledge: true,
        dedupeKey: `licence-skipped:${today}`,
        sentTo: 'Admin',
      });
    }
  }

  /** One notice to Admin when working people still have a designation with no role. */
  private async unmappedDesignations(tx: Tx, today: string): Promise<void> {
    const maps = await tx.designationRoleMap.findMany({ select: { designation: true } });
    const mapped = new Set(maps.map((m) => m.designation.toLowerCase()));
    const people = await tx.user.findMany({
      where: {
        workingStatus: 'WORKING',
        assignments: { none: {} },
        NOT: { baseRole: { isAdmin: true } },
      },
      select: { designation: true },
    });
    const names = [
      ...new Set(
        people
          .map((p) => p.designation)
          .filter((d) => d.trim() !== '' && !mapped.has(d.toLowerCase())),
      ),
    ];
    if (names.length === 0) return;
    const admins = await this.adminIds(tx);
    if (admins.length === 0) return;
    await this.notices.notify(tx, {
      category: 'SYSTEM',
      event: null,
      title: 'Designations are not mapped',
      body: `${names.join(', ')} — these people cannot sign in until an Admin maps the designation.`,
      recipients: admins,
      canAcknowledge: true,
      dedupeKey: `unmapped-designations:${today}`,
      sentTo: 'Admin',
    });
  }

  private async observations(tx: Tx, today: string, result: DailyNoticeRun): Promise<void> {
    const rows = await tx.auditObservation.findMany({
      where: { status: 'PENDING', audit: { plant: { deletedAt: null } } },
      select: {
        id: true,
        plantId: true,
        auditId: true,
        observationCode: true,
        checklistRef: true,
        observation: true,
        status: true,
        targetDate: true,
        revisedTargetDate: true,
        audit: { select: { auditType: true, plant: { select: { name: true } } } },
      },
    });
    const managers = new Map<string, string[]>();
    for (const o of rows) {
      const dates = {
        targetDate: isoDayOrNull(o.targetDate),
        revisedTargetDate: isoDayOrNull(o.revisedTargetDate),
      };
      if (observationUrgency({ status: o.status, ...dates }, today) !== 'OVERDUE') continue;
      const target = effectiveTargetDate(dates) ?? today;
      let pm = managers.get(o.plantId);
      if (!pm) {
        pm = await this.notices.plantManagers(tx, o.plantId);
        managers.set(o.plantId, pm);
      }
      const outcome = await this.notices.notify(tx, {
        category: 'SYSTEM',
        event: 'AUDIT_OVERDUE',
        title: `Audit observation overdue — ${o.checklistRef ?? o.observationCode}, ${o.audit.plant.name}`,
        body: `${o.observationCode} ${o.observation ?? ''} — ${dates.revisedTargetDate ? 'revised target' : 'target'} ${formatDate(target)} has passed.`,
        plantId: o.plantId,
        link: { entity: 'audit', id: o.auditId },
        recipients: pm,
        canAcknowledge: true,
        dedupeKey: `audit-overdue:${o.id}:${target}`,
        sentTo: `Plant Manager, ${o.audit.plant.name}`,
      });
      if (outcome.state === 'DUPLICATE') result.alreadyRaised += 1;
      else if (outcome.state === 'SENT') result.auditOverdue += 1;
    }
  }
}
