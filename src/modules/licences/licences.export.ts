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
  LICENCE_CATEGORY_LABEL,
  LICENCE_STATUS_LABEL,
  LICENCE_TYPE_LABEL,
  RENEWAL_FREQUENCY_LABEL,
  formatDate,
  formatNumber,
  type LicenceFilter,
  type LicenceRow,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { LicencesService } from './licences.service';

const COLUMNS: readonly ReportColumn<LicenceRow>[] = [
  { header: 'Plant name', width: 22, value: (r) => r.plant.name },
  { header: 'Licence type', width: 22, value: (r) => LICENCE_TYPE_LABEL[r.licenceType] },
  { header: 'Title / item', width: 30, value: (r) => r.item.title },
  { header: 'Doc reference', width: 18, value: (r) => r.docRef },
  { header: 'Start date', width: 12, value: (r) => (r.startDate ? formatDate(r.startDate) : null) },
  { header: 'End date', width: 12, value: (r) => (r.endDate ? formatDate(r.endDate) : null) },
  { header: 'Frequency', width: 12, value: (r) => RENEWAL_FREQUENCY_LABEL[r.frequency] },
  { header: 'Status', width: 16, value: (r) => LICENCE_STATUS_LABEL[r.status] },
];

/** Licences download per tab (BTN-4, BEV-6): the table's own filter and card counts; audited. */
@Injectable()
export class LicencesExport {
  constructor(
    private readonly licences: LicencesService,
    private readonly audit: AuditLogService,
  ) {}

  async table(
    access: ResolvedAccess,
    filter: LicenceFilter,
    format: 'xlsx' | 'pdf',
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const { rows, cards } = await this.licences.exportRows(access, filter);
    const reportId = newReportId();
    const spec = {
      reportName: LICENCE_CATEGORY_LABEL[filter.category],
      subtitle: [
        filter.licenceType ? LICENCE_TYPE_LABEL[filter.licenceType] : null,
        filter.status ? LICENCE_STATUS_LABEL[filter.status] : null,
        `${formatNumber(rows.length, 0)} rows`,
      ]
        .filter(Boolean)
        .join(' · '),
      columns: COLUMNS,
      rows,
      totals: [
        `Total (${formatNumber(rows.length, 0)} rows)`,
        null,
        `Active ${String(cards.active)} · Due ${String(cards.due)} · Expired ${String(cards.expired)} · NA ${String(cards.na)} · Not yet initiated ${String(cards.notInitiated)}`,
        null,
        null,
        null,
        null,
        null,
      ],
      generatedAt: new Date(),
      reportId,
    };
    const body = format === 'xlsx' ? await buildXlsx(spec) : await buildPdf(spec);
    await this.audit.record({
      action: AuditAction.EXPORT,
      entity: 'licence',
      entityId: reportId,
      actorId: access.userId,
      after: { format, filter: { ...filter }, rows: rows.length },
      ctx,
    });
    return {
      body,
      fileName: `${filter.category === 'STATUTORY' ? 'statutory-mandatory' : 'internal-testing'}.${format}`,
      contentType: format === 'xlsx' ? XLSX_TYPE : 'application/pdf',
    };
  }
}
