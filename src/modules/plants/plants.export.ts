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
import { formatDate, formatNumber, type PlantQuery, type PlantRow } from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { PlantsService } from './plants.service';

const COLUMNS: readonly ReportColumn<PlantRow>[] = [
  { header: 'Plant name', width: 24, value: (r) => r.name },
  { header: 'Plant address', width: 40, value: (r) => r.address },
  { header: 'Plant code', width: 11, value: (r) => r.code },
  { header: 'Start date', width: 12, value: (r) => formatDate(r.startDate) },
  { header: 'End date', width: 12, value: (r) => formatDate(r.endDate) },
  {
    header: 'Period',
    width: 10,
    value: (r) => `${String(r.periodYears)} year${r.periodYears === 1 ? '' : 's'}`,
  },
  { header: 'Status', width: 10, value: (r) => (r.status === 'WORKING' ? 'Working' : 'New') },
  { header: 'Plant key', width: 12, value: (r) => r.plantKey },
  { header: 'Plant Manager', width: 18, value: (r) => r.manager.name },
];

/** Plant master download (BTN-4, BEV-6): the table's own filter; audited with its report ID. */
@Injectable()
export class PlantsExport {
  constructor(
    private readonly plants: PlantsService,
    private readonly audit: AuditLogService,
  ) {}

  async table(
    access: ResolvedAccess,
    filter: Omit<PlantQuery, 'page' | 'pageSize'>,
    format: 'xlsx' | 'pdf',
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const rows = await this.plants.exportRows(access, filter);
    const reportId = newReportId();
    const spec = {
      reportName: 'Plant master',
      subtitle: `${filter.q ? `“${filter.q}” · ` : ''}${
        filter.status ? `${filter.status === 'WORKING' ? 'Working' : 'New'} · ` : ''
      }${formatNumber(rows.length, 0)} plants`,
      columns: COLUMNS,
      rows,
      totals: [
        `Total (${formatNumber(rows.length, 0)} plants)`,
        null,
        null,
        null,
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
      entity: 'plant',
      entityId: reportId,
      actorId: access.userId,
      after: { format, filter: { ...filter }, rows: rows.length },
      ctx,
    });
    return {
      body,
      fileName: `plant-master.${format}`,
      contentType: format === 'xlsx' ? XLSX_TYPE : 'application/pdf',
    };
  }
}
