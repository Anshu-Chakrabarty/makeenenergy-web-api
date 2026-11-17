import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { CurrentAccess, RequireModule } from '../../common/access/access.decorators';
import {
  buildPdf,
  buildXlsx,
  newReportId,
  sendFile,
  XLSX_TYPE,
  type ReportColumn,
} from '../../common/export/report-file';
import { requestContext } from '../../common/security/request-context';
import {
  CHECK_STATUS_LABEL,
  formatDate,
  formatNumber,
  reviewCheckExportSchema,
  reviewCheckQuerySchema,
  type ReviewCheckPage,
  type ReviewCheckRow,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { ReviewCheckService } from './review-check.service';

class QueryDto extends createZodDto(reviewCheckQuerySchema) {}
class ExportDto extends createZodDto(reviewCheckExportSchema) {}

const trio = (a: number, b: number, c: number): string =>
  `${String(a)} / ${String(b)} / ${String(c)}`;

const COLUMNS: readonly ReportColumn<ReviewCheckRow>[] = [
  { header: 'Plant', width: 24, value: (r) => r.plant.name },
  { header: 'Contract end date', width: 14, value: (r) => formatDate(r.contractEnd) },
  {
    header: 'Audit · Complied / Pending / Overdue',
    width: 22,
    value: (r) => trio(r.audit.complied, r.audit.pending, r.audit.overdue),
  },
  {
    header: 'Statutory · Active / Due / Expired',
    width: 22,
    value: (r) => trio(r.statutory.active, r.statutory.due, r.statutory.expired),
  },
  {
    header: 'Internal testing · Active / Due / Expired',
    width: 22,
    value: (r) => trio(r.internal.active, r.internal.due, r.internal.expired),
  },
  { header: 'Check status', width: 12, value: (r) => CHECK_STATUS_LABEL[r.status] },
];

/** Review Check (module REVIEW_CHECK): read only, with Excel / PDF (RC-3). */
@ApiTags('Review Check')
@Controller('review-check')
export class ReviewCheckController {
  constructor(
    private readonly review: ReviewCheckService,
    private readonly audit: AuditLogService,
  ) {}

  @RequireModule('REVIEW_CHECK', 'VIEW')
  @Get()
  list(@CurrentAccess() access: ResolvedAccess, @Query() q: QueryDto): Promise<ReviewCheckPage> {
    return this.review.list(access, q);
  }

  @RequireModule('REVIEW_CHECK', 'DOWNLOAD')
  @Get('export')
  async export(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: ExportDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { format, ...filter } = q;
    const page = await this.review.list(access, filter, true);
    const reportId = newReportId();
    const spec = {
      reportName: 'Review Check',
      subtitle: `As of ${formatDate(page.today)}${filter.status ? ` · ${CHECK_STATUS_LABEL[filter.status]}` : ''} · ${formatNumber(page.rows.length, 0)} plants`,
      columns: COLUMNS,
      rows: page.rows,
      generatedAt: new Date(),
      reportId,
    };
    const body = format === 'xlsx' ? await buildXlsx(spec) : await buildPdf(spec);
    await this.audit.record({
      action: AuditAction.EXPORT,
      entity: 'review_check',
      entityId: reportId,
      actorId: access.userId,
      after: { format, filter: { ...filter }, rows: page.rows.length },
      ctx: requestContext(req),
    });
    sendFile(res, {
      body,
      fileName: `review-check.${format}`,
      contentType: format === 'xlsx' ? XLSX_TYPE : 'application/pdf',
    });
  }
}
