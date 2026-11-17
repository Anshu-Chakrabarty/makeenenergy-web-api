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
  CYLINDER_SIZES,
  CYLINDER_SIZE_LABELS,
  CYLINDER_STAT_ROWS,
  INVENTORY_ITEM_DEFS,
  MONTHLY_MIS_INPUT_FIELDS,
  MONTHLY_MIS_SECTIONS,
  MONTHLY_SUMMARY_ITEMS,
  cylinderFieldNo,
  formatDate,
  formatDateTimeIst,
  formatMonthYear,
  formatNumber,
  KIND_DECIMALS,
  type FieldDef,
  type MonthlyMisDetail,
  type MonthlyMisFilter,
  type MonthlyMisListRow,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { AuditAction, AuditLogService } from '../audit-log/audit-log.service';
import { STATUS_LABEL } from '../daily-mis/daily-mis.export';
import { MonthlyMisService } from './monthly-mis.service';

/** Columns of the Monthly MIS table (MMIS-T1…T10), the same in Excel and PDF. */
const COLUMNS: readonly ReportColumn<MonthlyMisListRow>[] = [
  { header: 'Plant', width: 22, value: (r) => r.plant.name },
  { header: 'Month', width: 14, value: (r) => formatMonthYear(r.month) },
  { header: 'Total production (MT)', width: 16, decimals: 3, value: (r) => r.totalProduction },
  { header: 'Total normal shifts', width: 13, decimals: 0, value: (r) => r.totalShifts },
  { header: 'Electricity units (kW)', width: 16, decimals: 2, value: (r) => r.electricityUnits },
  { header: 'Diesel consumed (litres)', width: 16, decimals: 2, value: (r) => r.dieselConsumed },
  {
    header: 'Cylinder despatches (MT)',
    width: 17,
    decimals: 3,
    value: (r) => r.cylinderDespatches,
  },
  { header: 'TT loading (MT)', width: 14, decimals: 3, value: (r) => r.ttLoading },
  { header: 'Status', width: 11, value: (r) => STATUS_LABEL[r.status] },
  { header: 'Entered by', width: 16, value: (r) => r.enteredBy },
  {
    header: 'Last modified (IST)',
    width: 20,
    value: (r) => formatDateTimeIst(new Date(r.updatedAt)),
  },
];

/**
 * Monthly MIS downloads (BTN-4, BEV-6, D-87): the table download reads the SAME filter and totals
 * as the screen (MonthlyMisService.exportRows). Every download is audited with its report ID.
 */
@Injectable()
export class MonthlyMisExport {
  constructor(
    private readonly monthly: MonthlyMisService,
    private readonly audit: AuditLogService,
  ) {}

  async table(
    access: ResolvedAccess,
    filter: MonthlyMisFilter,
    format: 'xlsx' | 'pdf',
    ctx: RequestContext,
  ): Promise<ReportFile> {
    const data = await this.monthly.exportRows(access, filter);
    const reportId = newReportId();
    const t = data.totals;
    const spec = {
      reportName: 'Monthly MIS',
      subtitle: `${data.plantName ?? 'All plants this login may see'} · ${formatMonthYear(data.month)}${
        filter.status ? ` · ${STATUS_LABEL[filter.status]}` : ''
      } · ${formatNumber(t.rows, 0)} rows`,
      columns: COLUMNS,
      rows: data.rows,
      totals: [
        `Total (${formatNumber(t.rows, 0)} rows)`,
        null,
        t.totalProduction,
        t.totalShifts,
        t.electricityUnits,
        t.dieselConsumed,
        t.cylinderDespatches,
        t.ttLoading,
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
      entity: 'monthly_mis',
      entityId: reportId,
      actorId: access.userId,
      after: { format, filter: { ...filter, month: data.month }, rows: t.rows },
      ctx,
    });
    return {
      body,
      fileName: `monthly-mis_${data.month}.${format}`,
      contentType: format === 'xlsx' ? XLSX_TYPE : 'application/pdf',
    };
  }

  /** One report, all 122 items (form “Download PDF”). */
  async record(access: ResolvedAccess, id: string, ctx: RequestContext): Promise<ReportFile> {
    const d = await this.monthly.get(access, id);
    const reportId = newReportId();
    const body = await buildRecordPdf({
      reportName: `Monthly MIS — ${d.plant.name}, ${formatMonthYear(d.month)}`,
      subtitle: `Status ${STATUS_LABEL[d.status]} · entered by ${d.enteredBy.name} · last updated ${formatDateTimeIst(new Date(d.updatedAt))}`,
      reportId,
      generatedAt: new Date(),
      sections: sectionsOf(d),
    });
    await this.audit.record({
      action: AuditAction.EXPORT,
      entity: 'monthly_mis',
      entityId: reportId,
      plantId: d.plant.id,
      actorId: access.userId,
      after: { format: 'pdf', monthlyMisId: id },
      ctx,
    });
    return {
      body,
      fileName: `monthly-mis_${d.plant.code}_${d.month}.pdf`,
      contentType: 'application/pdf',
    };
  }
}

const dash = (v: string | number | null | undefined): v is null | undefined | '' =>
  v === null || v === undefined || v === '';

function shownInput(def: FieldDef, d: MonthlyMisDetail): string {
  const raw =
    def.key === 'trainingTotal'
      ? d.trainingTotal
      : (d.values as Record<string, string | number | null>)[def.key];
  if (dash(raw)) return '—';
  if (def.kind === 'yesno') return raw === 'YES' ? 'Yes' : 'No';
  if (def.kind === 'date' && typeof raw === 'string') return formatDate(raw);
  if (def.kind === 'text' || def.kind === 'select' || def.kind === 'time') return String(raw);
  return `${formatNumber(raw, def.decimals)}${def.unit ? ` ${def.unit}` : ''}`;
}

function sectionsOf(d: MonthlyMisDetail): RecordSection[] {
  const summary: RecordSection = {
    title: `A. Cumulative Daily Summary (${d.summary.approvedDays} of ${d.summary.daysInMonth} days Approved${d.summary.frozen ? ', frozen at approval' : ''})`,
    items: MONTHLY_SUMMARY_ITEMS.map((i) => ({
      no: i.no,
      label: `${i.label} (${i.formula})`,
      value: formatNumber(d.summary.items[i.key], KIND_DECIMALS[i.kind]),
    })),
  };
  const inputs = Object.values(MONTHLY_MIS_SECTIONS)
    .filter((title) => title !== MONTHLY_MIS_SECTIONS.cylinders)
    .map((title) => ({
      title,
      items: (MONTHLY_MIS_INPUT_FIELDS as readonly FieldDef[])
        .filter((f) => f.section === title)
        .map((f) => ({ no: f.no, label: f.label, value: shownInput(f, d) })),
    }));
  const remarks = inputs.pop();
  const cylinders: RecordSection = {
    title: MONTHLY_MIS_SECTIONS.cylinders,
    items: [
      ...CYLINDER_STAT_ROWS.flatMap((row) =>
        CYLINDER_SIZES.map((size) => {
          const q = d.cylinders[row.category][size];
          return {
            no: cylinderFieldNo(row.category, size),
            label: `${row.label} — ${CYLINDER_SIZE_LABELS[size]}`,
            value: dash(q) ? '—' : formatNumber(q, 0),
          };
        }),
      ),
      ...INVENTORY_ITEM_DEFS.map((def) => {
        const q = d.inventory[def.item];
        return {
          no: def.no,
          label: `${def.group === 'SCRAP_PARTS' ? 'Closing inventory, scrap CVR' : def.group === 'NEW_CVR' ? 'Closing inventory, new CVR' : 'Closing inventory, DPT paint / primer'} — ${def.label}`,
          value: dash(q) ? '—' : `${formatNumber(q, def.unit === 'litres' ? 2 : 0)} ${def.unit}`,
        };
      }),
    ],
  };
  return [summary, ...inputs, cylinders, ...(remarks ? [remarks] : [])];
}
