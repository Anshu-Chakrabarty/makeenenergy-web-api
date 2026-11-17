import { Injectable } from '@nestjs/common';
import { plantScope, type PlantScope } from '../../common/access/plant-scope';
import { dayOf, isoDay } from '../../common/db/people-names';
import {
  EXCEPTION_STATUS_TEXT,
  LICENCE_TYPE_LABEL,
  REPORT_STATUS_TEXT,
  formatDate,
  formatMonthYear,
  isIsoDate,
  parseDisplayDate,
  type Module,
  type SearchHit,
} from '../../shared';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import type { ResolvedAccess } from '../access/access.service';

/** Results per kind in the command palette. */
export const SEARCH_PER_KIND = 5;

const plantIn = (scope: PlantScope): { plantId?: { in: string[] } } =>
  scope.all ? {} : { plantId: { in: scope.plantIds } };

/**
 * Command palette (⌘K / Ctrl+K): plants, reports, exceptions, licences and audit observations
 * whose name, date, highlight, title or code matches. Each kind is searched only on plants where
 * the login's role may open that module (Hidden modules return nothing), and RLS applies.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  private scope(access: ResolvedAccess, module: Module): PlantScope | null {
    const s = plantScope(access, { module, capability: 'VIEW' });
    return s.all || s.plantIds.length > 0 ? s : null;
  }

  async search(access: ResolvedAccess, raw: string): Promise<SearchHit[]> {
    const q = raw.trim();
    const day = isIsoDate(q) ? q : parseDisplayDate(q);
    const text = { contains: q, mode: 'insensitive' as const };
    return this.prisma.runAs({ userId: access.userId, isAdmin: access.isAdmin }, async (tx) => {
      const out: SearchHit[] = [];
      const plants = this.scope(access, 'PLANT_MASTER');
      if (plants) out.push(...(await this.plants(tx, plants, text)));
      const daily = this.scope(access, 'DAILY_MIS');
      if (daily) out.push(...(await this.daily(tx, daily, text, day)));
      const monthly = this.scope(access, 'MONTHLY_MIS');
      if (monthly && !day) out.push(...(await this.monthly(tx, monthly, text)));
      const ex = this.scope(access, 'DAILY_EXCEPTIONS');
      if (ex) out.push(...(await this.exceptions(tx, ex, text, day)));
      const lic = this.scope(access, 'LICENCES');
      if (lic && !day) out.push(...(await this.licences(tx, lic, text)));
      const audit = this.scope(access, 'AUDIT');
      if (audit && !day) out.push(...(await this.observations(tx, audit, text)));
      return out;
    });
  }

  private async plants(
    tx: Tx,
    scope: PlantScope,
    text: { contains: string; mode: 'insensitive' },
  ): Promise<SearchHit[]> {
    const rows = await tx.plant.findMany({
      where: {
        deletedAt: null,
        OR: [{ name: text }, { code: text }],
        ...(scope.all ? {} : { id: { in: scope.plantIds } }),
      },
      select: { id: true, name: true, code: true, status: true },
      orderBy: { name: 'asc' },
      take: SEARCH_PER_KIND,
    });
    return rows.map((p) => ({
      kind: 'PLANT',
      id: p.id,
      title: p.name,
      subtitle: `Plant · ${p.code} · ${p.status === 'WORKING' ? 'Working' : 'New'}`,
      href: `/plant-master/${p.id}`,
    }));
  }

  private async daily(
    tx: Tx,
    scope: PlantScope,
    text: { contains: string; mode: 'insensitive' },
    day: string | null,
  ): Promise<SearchHit[]> {
    const rows = await tx.dailyMis.findMany({
      where: {
        plant: { deletedAt: null, ...(day ? {} : { name: text }) },
        ...(day ? { reportDate: dayOf(day) } : { status: { not: 'DRAFT' } }),
        ...plantIn(scope),
      },
      select: {
        id: true,
        reportDate: true,
        status: true,
        plant: { select: { name: true } },
      },
      orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }],
      take: SEARCH_PER_KIND,
    });
    return rows.map((r) => ({
      kind: 'DAILY_MIS',
      id: r.id,
      title: `${r.plant.name} · ${formatDate(isoDay(r.reportDate))}`,
      subtitle: `Daily MIS · ${REPORT_STATUS_TEXT[r.status]}`,
      href: `/daily-mis/${r.id}`,
    }));
  }

  private async monthly(
    tx: Tx,
    scope: PlantScope,
    text: { contains: string; mode: 'insensitive' },
  ): Promise<SearchHit[]> {
    const rows = await tx.monthlyMis.findMany({
      where: {
        plant: { deletedAt: null, name: text },
        status: { not: 'DRAFT' },
        ...plantIn(scope),
      },
      select: { id: true, month: true, status: true, plant: { select: { name: true } } },
      orderBy: { month: 'desc' },
      take: SEARCH_PER_KIND,
    });
    return rows.map((r) => ({
      kind: 'MONTHLY_MIS',
      id: r.id,
      title: `${r.plant.name} · ${formatMonthYear(isoDay(r.month).slice(0, 7))}`,
      subtitle: `Monthly MIS · ${REPORT_STATUS_TEXT[r.status]}`,
      href: `/monthly-mis/${r.id}`,
    }));
  }

  private async exceptions(
    tx: Tx,
    scope: PlantScope,
    text: { contains: string; mode: 'insensitive' },
    day: string | null,
  ): Promise<SearchHit[]> {
    const rows = await tx.dailyException.findMany({
      where: {
        plant: { deletedAt: null },
        ...(day
          ? { reportDate: dayOf(day) }
          : { OR: [{ problemHighlight: text }, { plant: { name: text } }] }),
        ...plantIn(scope),
      },
      select: {
        id: true,
        reportDate: true,
        status: true,
        problemHighlight: true,
        plant: { select: { name: true } },
      },
      orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }],
      take: SEARCH_PER_KIND,
    });
    return rows.map((r) => ({
      kind: 'EXCEPTION',
      id: r.id,
      title: `${r.plant.name} · ${formatDate(isoDay(r.reportDate))}`,
      subtitle: `Daily Exception · ${EXCEPTION_STATUS_TEXT[r.status]}${r.problemHighlight ? ` · ${r.problemHighlight}` : ''}`,
      href: `/daily-exceptions/${r.id}`,
    }));
  }

  private async licences(
    tx: Tx,
    scope: PlantScope,
    text: { contains: string; mode: 'insensitive' },
  ): Promise<SearchHit[]> {
    const rows = await tx.licence.findMany({
      where: {
        plant: { deletedAt: null },
        OR: [{ item: { title: text } }, { docRef: text }],
        ...plantIn(scope),
      },
      select: {
        id: true,
        licenceType: true,
        item: { select: { title: true } },
        plant: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: SEARCH_PER_KIND,
    });
    return rows.map((r) => ({
      kind: 'LICENCE',
      id: r.id,
      title: `${r.item.title} · ${r.plant.name}`,
      subtitle: `Licence · ${LICENCE_TYPE_LABEL[r.licenceType]}`,
      href: `/licences/${r.id}`,
    }));
  }

  private async observations(
    tx: Tx,
    scope: PlantScope,
    text: { contains: string; mode: 'insensitive' },
  ): Promise<SearchHit[]> {
    const rows = await tx.auditObservation.findMany({
      where: {
        audit: { plant: { deletedAt: null } },
        OR: [{ observationCode: text }, { observation: text }],
        ...plantIn(scope),
      },
      select: {
        id: true,
        auditId: true,
        observationCode: true,
        observation: true,
        audit: { select: { plant: { select: { name: true } } } },
      },
      orderBy: { observationCode: 'asc' },
      take: SEARCH_PER_KIND,
    });
    return rows.map((r) => ({
      kind: 'AUDIT',
      id: r.id,
      title: `${r.observationCode} · ${r.audit.plant.name}`,
      subtitle: `Audit observation${r.observation ? ` · ${r.observation.slice(0, 80)}` : ''}`,
      href: `/audit/${r.auditId}`,
    }));
  }
}
