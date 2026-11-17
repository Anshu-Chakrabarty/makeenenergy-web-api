import { HttpStatus } from '@nestjs/common';
import { parse as parseCsv } from 'csv-parse/sync';
import * as ExcelJS from 'exceljs';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { KEKA_COLUMNS, PEOPLE_MESSAGES, kekaColumnFor, type KekaRawRow } from '../../shared';

/** Limits for one KEKA file (spec File uploads: ≤ 10 MB; rows bounded so a load stays one tx). */
export const KEKA_MAX_BYTES = 10 * 1024 * 1024;
export const KEKA_MAX_ROWS = 20_000;
/** Zip-bomb guard for .xlsx: total inflated size and entry count. */
const XLSX_MAX_INFLATED = 100 * 1024 * 1024;
const XLSX_MAX_ENTRIES = 2_000;

export interface SourceRow {
  /** Spreadsheet row number (header = 1), so the report points at the line in the file. */
  row: number;
  values: KekaRawRow;
}

export type KekaFileKind = 'csv' | 'xlsx';

function badFile(message: string, details?: unknown): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, message, details);
}

function unsupported(): AppError {
  return new AppError(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    ErrorCode.UNSUPPORTED_MEDIA_TYPE,
    PEOPLE_MESSAGES.fileType,
  );
}

/**
 * File type by content (magic bytes), never by name or Content-Type alone (SEC uploads):
 * XLSX = ZIP local header `PK\x03\x04` with a .xlsx name; CSV = valid UTF-8 text without NULs
 * and with a .csv name. Old .xls, PDFs, images and anything else are refused.
 */
export function detectKekaFile(buf: Buffer, fileName: string): KekaFileKind {
  const name = fileName.toLowerCase();
  const isZip = buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) {
    if (!name.endsWith('.xlsx')) throw unsupported();
    return 'xlsx';
  }
  if (!name.endsWith('.csv')) throw unsupported();
  if (buf.includes(0)) throw unsupported();
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw unsupported();
  }
  return 'csv';
}

/**
 * Sum the uncompressed sizes in the ZIP central directory before ExcelJS inflates anything.
 * Refuses ZIP64 and archives that would inflate past the limit.
 */
export function assertSafeZip(buf: Buffer): void {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  const searchFrom = Math.max(0, buf.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= searchFrom; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unsupported();
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries > XLSX_MAX_ENTRIES || entries === 0xffff || cdOffset === 0xffffffff)
    throw unsupported();
  let p = cdOffset;
  let inflated = 0;
  for (let n = 0; n < entries; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw unsupported();
    const size = buf.readUInt32LE(p + 24);
    if (size === 0xffffffff) throw unsupported();
    inflated += size;
    if (inflated > XLSX_MAX_INFLATED) throw unsupported();
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
}

/** Map a header row to column keys; throws listing the missing spec columns (PPL-2). */
function headerMap(headers: readonly string[]): Map<number, keyof KekaRawRow> {
  const map = new Map<number, keyof KekaRawRow>();
  headers.forEach((h, i) => {
    const key = kekaColumnFor(h);
    if (key !== null && ![...map.values()].includes(key)) map.set(i, key);
  });
  const found = new Set(map.values());
  const missing = KEKA_COLUMNS.filter((c) => !found.has(c.key)).map((c) => c.header);
  if (missing.length > 0)
    throw badFile(PEOPLE_MESSAGES.missingColumns, { missingColumns: missing });
  return map;
}

function toRows(matrix: readonly (readonly string[])[], firstRow: number): SourceRow[] {
  const [header, ...data] = matrix;
  if (!header) throw badFile(PEOPLE_MESSAGES.fileEmpty);
  const map = headerMap(header);
  const rows: SourceRow[] = [];
  data.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    const values: KekaRawRow = {};
    for (const [col, key] of map) values[key] = (cells[col] ?? '').trim();
    rows.push({ row: firstRow + 1 + i, values });
  });
  if (rows.length === 0) throw badFile(PEOPLE_MESSAGES.fileEmpty);
  if (rows.length > KEKA_MAX_ROWS) throw badFile(PEOPLE_MESSAGES.fileTooManyRows);
  return rows;
}

function parseCsvRows(buf: Buffer): SourceRow[] {
  const matrix: string[][] = parseCsv(buf, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    max_record_size: 64 * 1024,
    to_line: KEKA_MAX_ROWS + 2,
  });
  return toRows(matrix, 1);
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  // Numbers (phones, Aadhaar typed as numbers) must not become 9.81E+09.
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  return cell.text;
}

async function parseXlsxRows(buf: Buffer): Promise<SourceRow[]> {
  assertSafeZip(buf);
  const wb = new ExcelJS.Workbook();
  // ExcelJS's typings declare its `Buffer` as an ArrayBuffer; hand it one (copy, ≤ 10 MB).
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  try {
    await wb.xlsx.load(ab);
  } catch {
    throw unsupported();
  }
  const sheet = wb.worksheets[0];
  if (!sheet) throw badFile(PEOPLE_MESSAGES.fileEmpty);
  if (sheet.rowCount > KEKA_MAX_ROWS + 1) throw badFile(PEOPLE_MESSAGES.fileTooManyRows);
  const width = Math.min(sheet.columnCount, 100);
  const matrix: string[][] = [];
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= width; c += 1) cells.push(cellText(row.getCell(c)));
    matrix.push(cells);
  }
  return toRows(matrix, 1);
}

/** Parse an uploaded KEKA export into raw rows (validation happens in the import service). */
export async function parseKekaFile(buf: Buffer, fileName: string): Promise<SourceRow[]> {
  if (buf.length === 0) throw badFile(PEOPLE_MESSAGES.fileEmpty);
  if (buf.length > KEKA_MAX_BYTES)
    throw new AppError(
      HttpStatus.PAYLOAD_TOO_LARGE,
      ErrorCode.PAYLOAD_TOO_LARGE,
      'The file is larger than 10 MB.',
    );
  return detectKekaFile(buf, fileName) === 'xlsx' ? parseXlsxRows(buf) : parseCsvRows(buf);
}

/** Raw rows from KEKA API objects keyed by the same column names (PPL-3). */
export function rowsFromObjects(items: readonly unknown[]): SourceRow[] {
  if (items.length > KEKA_MAX_ROWS) throw badFile(PEOPLE_MESSAGES.fileTooManyRows);
  return items.map((item, i) => {
    const values: KekaRawRow = {};
    if (item !== null && typeof item === 'object') {
      for (const [k, v] of Object.entries(item)) {
        const key = kekaColumnFor(k);
        if (key !== null && (typeof v === 'string' || typeof v === 'number'))
          values[key] = String(v).trim();
      }
    }
    return { row: i + 1, values };
  });
}
