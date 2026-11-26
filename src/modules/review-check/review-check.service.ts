import { Injectable } from '@nestjs/common';
import { plantFilter, type PlantNeed } from '../../common/access/plant-scope';
import { isoDay } from '../../common/db/people-names';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CHECK_STATUS_RANK,
  istToday,
  reviewCheckStatus,
  type ReviewCheckFilter,
  type ReviewCheckPage,
  type ReviewCheckRow,
  type StatusCounts,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { countObservations } from '../audits/audits.service';
import { toLicenceRow } from '../licences/licences.service';

const VIEW = { module: 'REVIEW_CHECK', capability: 'VIEW' } as const satisfies PlantNeed;
const DOWNLOAD = { module: 'REVIEW_CHECK', capability: 'DOWNLOAD' } as const satisfies PlantNeed;

const empty = (): StatusCounts => ({ active: 0, due: 0, expired: 0 });

/**
 * Review Check (spec “Review Check”, RC-1…RC-3): one read-only row per plant built from Plant
 * master, Audit and both licence screens with the SAME shared status rules; the check status
 * follows D-27. Nothing is stored or typed here.
 */
@Injectable()
export class ReviewCheckService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    access: ResolvedAccess,
    f: ReviewCheckFilter,
    download = false,
  ): Promise<ReviewCheckPage> {
    const scope = plantFilter(access, f.plantId, download ? DOWNLOAD : VIEW);
    const today = istToday();
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, async (tx) => {
      const plants = await tx.plant.findMany({
        where: { deletedAt: null, ...(scope.all ? {} : { id: { in: scope.plantIds } }) },
        select: { id: true, name: true, code: true, endDate: true },
        orderBy: { name: 'asc' },
      });
      const ids = plants.map((p) => p.id);
      const observations = await tx.auditObservation.findMany({
        where: { plantId: { in: ids } },
        select: { plantId: true, status: true, targetDate: true, revisedTargetDate: true },
      });
      const licences = await tx.licence.findMany({
        where: { plantId: { in: ids } },
        select: {
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
        },
      });
      let rows: ReviewCheckRow[] = plants.map((p) => {
        const audit = countObservations(
          observations.filter((o) => o.plantId === p.id),
          today,
        );
        const statutory = empty();
        const internal = empty();
        for (const l of licences.filter((x) => x.plantId === p.id)) {
          const s = toLicenceRow(l, today).status;
          const bucket = l.category === 'STATUTORY' ? statutory : internal;
          if (s === 'ACTIVE') bucket.active += 1;
          else if (s === 'DUE') bucket.due += 1;
          else if (s === 'EXPIRED') bucket.expired += 1;
        }
        const contractEnd = isoDay(p.endDate);
        const criticalItems =
          audit.overdue + statutory.expired + (contractEnd < today ? 1 : 0);
        return {
          plant: { id: p.id, name: p.name, code: p.code },
          contractEnd,
          audit,
          statutory,
          internal,
          criticalItems,
          status: reviewCheckStatus(
            {
              contractEnd,
              observationsOverdue: audit.overdue,
              observationsDueSoon: audit.dueSoon,
              statutoryExpired: statutory.expired,
              statutoryDue: statutory.due,
              calibrationExpired: internal.expired,
              calibrationDue: internal.due,
            },
            today,
          ),
        };
      });
      if (f.status) rows = rows.filter((r) => r.status === f.status);
      rows.sort(
        (a, b) =>
          CHECK_STATUS_RANK[a.status] - CHECK_STATUS_RANK[b.status] ||
          a.plant.name.localeCompare(b.plant.name),
      );
      return { rows, today };
    });
  }
}
