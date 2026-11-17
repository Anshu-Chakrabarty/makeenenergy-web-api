import { Injectable } from '@nestjs/common';
import {
  buildPdf,
  buildXlsx,
  newReportId,
  XLSX_TYPE,
  type ReportColumn,
  type ReportFile,
} from '../../common/export/report-file';
import type { RequestContext } from '../../common/security/request-context';
import {
  AUDIT_FREQUENCY_LABEL,
  OBSERVATION_URGENCY_LABEL,
  formatDate,
  formatNumber,
  type AuditFilter,
  type AuditRow,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { AuditsService } from './audits.service';

const COLUMNS: readonly ReportColumn<AuditRow>[] = [
  { header: 'Plant name', width: 22, value: (r) => r.plant.name },
  { header: 'Audit', width: 8, value: (r) => r.auditType },
  { header: 'FY', width: 9, value: (r) => r.fy },
  { header: 'Frequency', width: 11, value: (r) => AUDIT_FREQUENCY_LABEL[r.frequency] },
  { header: 'Start date', width: 12, value: (r) => formatDate(r.startDate) },
  { header: 'End date', width: 12, value: (r) => formatDate(r.endDate) },
  { header: 'Attachment', width: 24, value: (r) => r.attachment?.fileName ?? null },
  { header: 'Complied', width: 10, decimals: 0, value: (r) => r.counts.complied },
  { header: 'Pending', width: 10, decimals: 0, value: (r) => r.counts.pending },
  { header: 'Overdue', width: 10, decimals: 0, value: (r) => r.counts.overdue },
  {
    header: 'Most urgent',
    width: 14,
    value: (r) => (r.urgency ? OBSERVATION_URGENCY_LABEL[r.urgency] : null),
  },
];

/** Audit download (BTN-4, BEV-6): the table's own filter and card counts; audited. */
@Injectable()
export class AuditsExport {
  constructor(
    private readonly audits: AuditsService,
    private readonly audit: AuditLogService,
  ) {}

  async table(
    access: ResolvedAccess,
    filter: AuditFilter,
    format: 'xlsx' | 'pdf',
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const { rows, cards } = await this.audits.exportRows(access, filter);
    const reportId = newReportId();
    const spec = {
      reportName: 'Audit',
      subtitle: [
        filter.auditType,
        filter.fy ? `FY ${filter.fy}` : null,
        filter.status,
        `${formatNumber(rows.length, 0)} audits`,
        `${formatNumber(cards.totalRecommendations, 0)} recommendations`,
      ]
        .filter(Boolean)
        .join(' · '),
      columns: COLUMNS,
      rows,
      totals: [
        `Total (${formatNumber(rows.length, 0)} audits)`,
        null,
        null,
        null,
        null,
        null,
        null,
        cards.complied,
        cards.pending,
        cards.overdue,
        null,
      ],
      generatedAt: new Date(),
      reportId,
    };
    const body = format === 'xlsx' ? await buildXlsx(spec) : await buildPdf(spec);
    await this.audit.record({
      action: AuditAction.EXPORT,
      entity: 'audit',
      entityId: reportId,
      actorId: access.userId,
      after: { format, filter: { ...filter }, rows: rows.length },
      ctx,
    });
    return {
      body,
      fileName: `audit.${format}`,
      contentType: format === 'xlsx' ? XLSX_TYPE : 'application/pdf',
    };
  }
}
