import { Injectable } from '@nestjs/common';
import {
  buildBookPdf,
  buildBookXlsx,
  cellColumn,
  newReportId,
  XLSX_TYPE,
  type ReportBook,
  type ReportFile,
  type ReportSection,
} from '../../common/export/report-file';
import type { RequestContext } from '../../common/security/request-context';
import {
  DASHBOARD_MODULE_LABEL,
  EXCEPTION_STATUS_TEXT,
  MONTHLY_SUMMARY_ITEMS,
  REPORT_STATUS_TEXT,
  formatDate,
  formatMonthYear,
  type DashboardQuery,
  type GraphsQuery,
  type ReviewLayout,
  type ReviewPackQuery,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { DashboardService } from './dashboard.service';
import { GraphsService } from './graphs.service';
import { ReviewService } from './review.service';

type Format = 'xlsx' | 'pdf';

const periodText = (p: string): string => (p.length === 7 ? formatMonthYear(p) : formatDate(p));

/**
 * Downloads of Dashboard, Management Review and Graphs (BTN-4, MR-11, GR-0). Each file is built
 * from the SAME service call the screen makes, so file numbers equal screen numbers; audited.
 */
@Injectable()
export class InsightsExport {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly review: ReviewService,
    private readonly graphs: GraphsService,
    private readonly audit: AuditLogService,
  ) {}

  private async file(
    book: ReportBook,
    format: Format,
    name: string,
    entity: string,
    access: ResolvedAccess,
    filter: object,
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const body = format === 'xlsx' ? await buildBookXlsx(book) : await buildBookPdf(book);
    await this.audit.record({
      action: AuditAction.EXPORT,
      entity,
      entityId: book.reportId,
      actorId: access.userId,
      after: { format, filter: { ...filter } },
      ctx,
    });
    return {
      body,
      fileName: `${name}.${format}`,
      contentType: format === 'xlsx' ? XLSX_TYPE : 'application/pdf',
    };
  }

  async dashboardFile(
    access: ResolvedAccess,
    q: DashboardQuery,
    format: Format,
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const v = await this.dashboard.view(access, q);
    const c = v.cards;
    const cards: (string | number | null)[][] = [];
    if (c.waiting)
      cards.push([
        'Days waiting approval',
        c.waiting.daily + c.waiting.monthly,
        `Daily ${String(c.waiting.daily)} · Monthly ${String(c.waiting.monthly)}`,
      ]);
    if (c.openExceptions)
      cards.push([
        'Exceptions still open',
        c.openExceptions.pending + c.openExceptions.partial,
        `Pending ${String(c.openExceptions.pending)} · Partial ${String(c.openExceptions.partial)}`,
      ]);
    if (c.licences)
      cards.push([
        'Licences due',
        c.licences.due + c.licences.expired,
        `Due ${String(c.licences.due)} · Expired ${String(c.licences.expired)}`,
      ]);
    if (c.auditOverdue !== null) cards.push(['Audit observations overdue', c.auditOverdue, null]);
    if (c.notInitiated !== null)
      cards.push([
        'Reports not initiated',
        c.notInitiated,
        `No Daily MIS and no Exception · ${formatDate(c.notInitiatedDate)}`,
      ]);
    const sections: ReportSection[] = [
      {
        title: 'Count cards',
        columns: [
          cellColumn('Card', 0, 30),
          cellColumn('Count', 1, 10, 0),
          cellColumn('Detail', 2, 40),
        ],
        rows: cards,
      },
    ];
    if (v.pending)
      sections.push({
        title: 'Pending approval',
        columns: [
          cellColumn('Plant', 0, 24),
          cellColumn('Date / Month', 1, 14),
          cellColumn('Module', 2, 14),
          cellColumn('Entered by', 3, 20),
          cellColumn('Status', 4, 10),
          cellColumn('Waiting hours', 5, 12, 1),
        ],
        rows: v.pending.map((r) => [
          r.plant.name,
          periodText(r.period),
          r.module === 'DAILY_MIS' ? 'Daily MIS' : 'Monthly MIS',
          r.enteredBy,
          'Pending',
          r.waitingHours,
        ]),
      });
    if (v.openExceptions)
      sections.push({
        title: 'Open exceptions',
        columns: [
          cellColumn('Plant', 0, 24),
          cellColumn('Date', 1, 12),
          cellColumn('Problem highlight', 2, 50),
          cellColumn('Status', 3, 10),
        ],
        rows: v.openExceptions.map((r) => [
          r.plant.name,
          formatDate(r.reportDate),
          r.problemHighlight ??
            (r.answered >= r.lineTotal
              ? 'All lines answered'
              : `Lines ${String(r.answered + 1)}–${String(r.lineTotal)} not yet answered`),
          EXCEPTION_STATUS_TEXT[r.status],
        ]),
      });
    const book: ReportBook = {
      reportName: 'Dashboard',
      subtitle: [
        DASHBOARD_MODULE_LABEL[q.module],
        q.date ? formatDate(q.date) : q.month ? formatMonthYear(q.month) : 'Everything waiting',
      ].join(' · '),
      sections,
      generatedAt: new Date(),
      reportId: newReportId(),
    };
    return this.file(book, format, 'dashboard', 'dashboard', access, q, ctx);
  }

  /** MR-11: the pack exactly as shown; the summary follows the Monthly MIS mapping (MR-7). */
  async reviewFile(
    access: ResolvedAccess,
    q: ReviewPackQuery,
    format: Format,
    layout: ReviewLayout,
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const p = await this.review.pack(access, q);
    const label =
      p.kind === 'DAY'
        ? `Day pack · ${formatDate(p.period)}`
        : `Month pack · ${formatMonthYear(p.period)}`;
    const sections: ReportSection[] = [
      {
        title: 'Count cards',
        columns: [
          cellColumn('Card', 0, 30),
          cellColumn('Count', 1, 10, 0),
          cellColumn('Detail', 2, 40),
        ],
        rows: [
          ['Plants filed', p.cards.filed, `of ${String(p.cards.total)}`],
          ['Plants not filed', p.cards.notFiled, null],
          ['Open exceptions', p.cards.openExceptions, 'Pending or Partial'],
          [
            'Licences due in period',
            p.cards.licencesDue + p.cards.licencesExpired,
            `Due ${String(p.cards.licencesDue)} · Expired ${String(p.cards.licencesExpired)}`,
          ],
        ],
      },
      {
        title: 'Review pack',
        columns: [
          cellColumn('Plant', 0, 22),
          cellColumn('Status', 1, 10),
          cellColumn('Stock gain / loss (MT)', 2, 12, 3),
          cellColumn('Sort-out ELD %', 3, 10, 2),
          cellColumn('Sort-out OLD %', 4, 10, 2),
          cellColumn('Breakdown (min)', 5, 10, 0),
          cellColumn('Market returns', 6, 10, 0),
          cellColumn('Accuracy 0 gms %', 7, 10, 2),
          cellColumn('Exception highlight', 8, 36),
          cellColumn('Lapse D / M / Y', 9, 12),
        ],
        rows: p.rows.map((r) => [
          r.plant.name,
          r.status ? REPORT_STATUS_TEXT[r.status] : 'Not filed',
          r.daily?.stockGainLoss ?? null,
          r.daily?.eldPct ?? null,
          r.daily?.oldPct ?? null,
          r.daily?.breakdownMinutes ?? null,
          r.daily?.marketReturns ?? null,
          r.daily?.accuracyZero ?? null,
          r.exception.text,
          `${String(r.lapse.day)} / ${String(r.lapse.month)} / ${String(r.lapse.year)}`,
        ]),
      },
    ];
    if (p.kind === 'MONTH')
      sections.push({
        title: 'Monthly highlight',
        columns: [
          cellColumn('Plant', 0, 22),
          cellColumn('Production (MT)', 1, 14, 3),
          cellColumn('Electricity (kW)', 2, 14, 2),
          cellColumn('Diesel (L)', 3, 12, 2),
          cellColumn('Cost / MT (Rs.)', 4, 12, 2),
          cellColumn('Tender cost / MT (Rs.)', 5, 14, 2),
        ],
        rows: p.rows
          .filter((r) => r.monthly)
          .map((r) => [
            r.plant.name,
            r.monthly?.production ?? null,
            r.monthly?.electricity ?? null,
            r.monthly?.diesel ?? null,
            r.monthly?.costPerMt ?? null,
            r.monthly?.tenderCostPerMt ?? null,
          ]),
      });
    sections.push({
      title: 'All-plants summary',
      columns: [
        cellColumn('No.', 0, 6, 0),
        cellColumn(
          `Cumulative Daily Summary · ${formatDate(p.summary.from)} to ${formatDate(p.summary.to)}`,
          1,
          44,
        ),
        cellColumn('Value', 2, 16),
      ],
      rows: MONTHLY_SUMMARY_ITEMS.map((i) => [i.no, i.label, p.summary.items[i.key]]),
      totals: [null, `Approved days counted`, String(p.summary.approvedDays)],
    });
    sections.push({
      title: 'Files on these records',
      columns: [
        cellColumn('Plant', 0, 22),
        cellColumn('Record', 1, 26),
        cellColumn('File name', 2, 40),
      ],
      rows: p.files.map((f) => [f.plant.name, f.what, f.fileName]),
    });
    const book: ReportBook = {
      reportName: 'Management Review',
      subtitle: `${label} · ${q.plantId ? (p.rows[0]?.plant.name ?? 'Plant') : 'All plants this login may see'} · ${layout} layout`,
      sections,
      generatedAt: new Date(),
      reportId: newReportId(),
    };
    return this.file(
      book,
      format,
      'management-review',
      'management_review',
      access,
      { ...q, layout },
      ctx,
    );
  }

  async graphsFile(
    access: ResolvedAccess,
    q: GraphsQuery,
    format: Format,
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const v = await this.graphs.view(access, q);
    const sections: ReportSection[] = v.charts.map((c) => ({
      title: `${String(c.id)}. ${c.title}`,
      columns: c.table.columns.map((h, i) => cellColumn(h, i, i === 0 ? 16 : 18)),
      rows: c.table.rows,
    }));
    const book: ReportBook = {
      reportName: 'Graphs',
      subtitle: `${v.plant.name} · ${formatMonthYear(v.month)} (trends ${formatMonthYear(v.months[0] ?? v.month)} to ${formatMonthYear(v.month)})`,
      sections,
      generatedAt: new Date(),
      reportId: newReportId(),
    };
    return this.file(book, format, 'graphs', 'graphs', access, q, ctx);
  }
}
