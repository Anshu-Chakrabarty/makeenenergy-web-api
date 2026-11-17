import { Injectable } from '@nestjs/common';
import {
  buildPdf,
  buildRecordPdf,
  buildXlsx,
  newReportId,
  XLSX_TYPE,
  type RecordSection,
  type ReportColumn,
  type ReportFile,
} from '../../common/export/report-file';
import type { RequestContext } from '../../common/security/request-context';
import {
  DAILY_EXCEPTION_LINES,
  formatDate,
  formatDateTimeIst,
  formatNumber,
  type DailyExceptionDetail,
  type DailyExceptionFilter,
  type DailyExceptionListRow,
  type ExceptionLineDef,
  type ExceptionRowStatus,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { DailyExceptionsService } from './daily-exceptions.service';

export const EXCEPTION_STATUS_LABEL: Record<ExceptionRowStatus, string> = {
  COMPLETED: 'Completed',
  PENDING: 'Pending',
  PARTIAL: 'Partial',
  NOT_INITIATED: 'Not initiated',
};

const COLUMNS: readonly ReportColumn<DailyExceptionListRow>[] = [
  { header: 'Plant', width: 22, value: (r) => r.plant.name },
  { header: 'Date', width: 12, value: (r) => formatDate(r.reportDate) },
  {
    header: 'Problem highlight',
    width: 48,
    value: (r) => r.problemHighlight ?? (r.lapseNote ? `Note: ${r.lapseNote}` : null),
  },
  { header: 'Status', width: 13, value: (r) => EXCEPTION_STATUS_LABEL[r.status] },
  { header: 'Entered by', width: 16, value: (r) => r.enteredBy },
  {
    header: 'Last modified (IST)',
    width: 20,
    value: (r) => (r.updatedAt ? formatDateTimeIst(new Date(r.updatedAt)) : null),
  },
];

const LINES = DAILY_EXCEPTION_LINES as readonly ExceptionLineDef[];

/**
 * Daily Exceptions downloads (BTN-4, BEV-6): the table download reads the SAME filter (including
 * the derived Not initiated days) and prints the card counts. Every download is audited.
 */
@Injectable()
export class DailyExceptionsExport {
  constructor(
    private readonly exceptions: DailyExceptionsService,
    private readonly audit: AuditLogService,
  ) {}

  async table(
    access: ResolvedAccess,
    filter: DailyExceptionFilter,
    format: 'xlsx' | 'pdf',
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const data = await this.exceptions.exportRows(access, filter);
    const reportId = newReportId();
    const c = data.cards;
    const period =
      data.from === data.to
        ? formatDate(data.from)
        : `${formatDate(data.from)} to ${formatDate(data.to)}`;
    const spec = {
      reportName: 'Daily Exceptions',
      subtitle: `${data.plantName ?? 'All plants this login may see'} · ${period}${
        filter.status ? ` · ${EXCEPTION_STATUS_LABEL[filter.status]}` : ''
      } · ${formatNumber(data.rows.length, 0)} rows`,
      columns: COLUMNS,
      rows: data.rows,
      totals: [
        `Total (${formatNumber(data.rows.length, 0)} rows)`,
        null,
        `Completed ${String(c.completed)} · Submitted ${String(c.submitted)} · Pending ${String(c.pending)} · Partial ${String(c.partial)} · Not initiated ${String(c.notInitiated)}`,
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
      entity: 'daily_exception',
      entityId: reportId,
      actorId: access.userId,
      after: { format, filter: { ...filter }, rows: data.rows.length },
      ctx,
    });
    return {
      body,
      fileName: `daily-exceptions_${data.from}_${data.to}.${format}`,
      contentType: format === 'xlsx' ? XLSX_TYPE : 'application/pdf',
    };
  }

  /** One report: header, the 13 lines with their extra fields, the files (form “Download PDF”). */
  async record(access: ResolvedAccess, id: string, ctx: RequestContext): Promise<ReportFile> {
    const d = await this.exceptions.get(access, id);
    const reportId = newReportId();
    const body = await buildRecordPdf({
      reportName: `Daily Exception — ${d.plant.name}, ${formatDate(d.reportDate)}`,
      subtitle: `Status ${EXCEPTION_STATUS_LABEL[d.status]} · entered by ${d.enteredBy.name} · last updated ${formatDateTimeIst(new Date(d.updatedAt))}`,
      reportId,
      generatedAt: new Date(),
      sections: sectionsOf(d),
    });
    await this.audit.record({
      action: AuditAction.EXPORT,
      entity: 'daily_exception',
      entityId: reportId,
      plantId: d.plant.id,
      actorId: access.userId,
      after: { format: 'pdf', dailyExceptionId: id },
      ctx,
    });
    return {
      body,
      fileName: `daily-exception_${d.plant.code}_${d.reportDate}.pdf`,
      contentType: 'application/pdf',
    };
  }
}

function sectionsOf(d: DailyExceptionDetail): RecordSection[] {
  const header: RecordSection = {
    title: 'Header',
    items: [
      { no: 1, label: 'Plant', value: d.plant.name },
      { no: 2, label: 'Date', value: formatDate(d.reportDate) },
      { no: 3, label: 'Last updated', value: formatDateTimeIst(new Date(d.updatedAt)) },
      {
        no: 4,
        label: 'Plant status',
        value:
          d.plantStatus === 'OPERATIONAL'
            ? 'Operational'
            : d.plantStatus === 'NON_OPERATIONAL'
              ? 'Non-operational'
              : '—',
      },
      { label: 'Problem highlight', value: d.problemHighlight ?? '—' },
    ],
  };
  const lines = LINES.map((def) => {
    const l = d.lines[String(def.lineNo)];
    const answer = l?.answer === 'YES' ? 'Yes' : l?.answer === 'NO' ? 'No' : '—';
    return {
      title: `Line ${String(def.lineNo)}. ${def.question}`,
      items: [
        { no: def.answerNo, label: 'Answer', value: answer },
        ...def.details
          .filter((x) => l?.answer === 'YES' && l.details[x.key] !== undefined)
          .map((x) => ({
            no: x.no,
            label: x.label,
            value: `${String(l?.details[x.key] ?? '—')}${x.unit && x.kind !== 'text' ? ` ${x.unit}` : ''}`,
          })),
      ],
    };
  });
  const files: RecordSection = {
    title: 'Footer',
    items: [
      {
        no: 47,
        label: 'SQC reports',
        value: d.attachments.length ? d.attachments.map((a) => a.fileName).join(', ') : '—',
      },
      { no: 48, label: 'Report status', value: EXCEPTION_STATUS_LABEL[d.status] },
    ],
  };
  return [header, ...lines, files];
}
