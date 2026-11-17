import * as ExcelJS from 'exceljs';
import { AppError } from '../../common/errors/app-error';
import { assertSafeZip, detectKekaFile, parseKekaFile, rowsFromObjects } from './keka-file';

const HEADER = 'Employee name,Employee code,Email,Phone,Aadhaar,Designation,Working / Resigned';
const ROW =
  'Asha Nair,MEI-00733,asha.nair@makeenenergy.com,9876543245,,Maintenance Officer,Working';

async function rejects(p: Promise<unknown>, status: number): Promise<AppError> {
  try {
    await p;
  } catch (e: unknown) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(status);
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

async function xlsx(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('KEKA');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('KEKA file type (magic bytes)', () => {
  it('accepts CSV text and XLSX zips by content and name', async () => {
    expect(detectKekaFile(Buffer.from(`${HEADER}\n${ROW}`), 'keka.csv')).toBe('csv');
    expect(detectKekaFile(await xlsx([['a']]), 'KEKA.XLSX')).toBe('xlsx');
  });

  it('refuses PDFs, old .xls, binary data and renamed zips', async () => {
    const zip = await xlsx([['a']]);
    expect(() => detectKekaFile(Buffer.from('%PDF-1.7\n'), 'keka.pdf')).toThrow(AppError);
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => detectKekaFile(ole, 'keka.xls')).toThrow(AppError);
    expect(() => detectKekaFile(Buffer.from([0x41, 0x00, 0x42]), 'keka.csv')).toThrow(AppError);
    expect(() => detectKekaFile(Buffer.from([0xff, 0xfe, 0x41]), 'keka.csv')).toThrow(AppError);
    expect(() => detectKekaFile(zip, 'keka.csv')).toThrow(AppError);
  });
});

describe('KEKA CSV', () => {
  it('reads rows with a BOM, extra columns and blank lines; row numbers match the file', async () => {
    const bom = String.fromCharCode(0xfeff);
    const csv = `${bom}${HEADER},Photo\n${ROW},x.jpg\n\n"Ravi Kumar",MEI-00218,ravi.kumar@makeenenergy.com,,,Plant Manager,Working\n`;
    const rows = await parseKekaFile(Buffer.from(csv), 'keka.csv');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      row: 2,
      values: {
        name: 'Asha Nair',
        employeeCode: 'MEI-00733',
        email: 'asha.nair@makeenenergy.com',
        phone: '9876543245',
        aadhaar: '',
        designation: 'Maintenance Officer',
        workingStatus: 'Working',
      },
    });
    expect(rows[1]?.values.name).toBe('Ravi Kumar');
  });

  it('lists every missing spec column', async () => {
    const e = await rejects(parseKekaFile(Buffer.from('Employee name,Email\nA,b\n'), 'k.csv'), 400);
    expect(e.details).toEqual({
      missingColumns: ['Employee code', 'Phone', 'Aadhaar', 'Designation', 'Working / Resigned'],
    });
  });

  it('refuses an empty file and a file with only a header', async () => {
    await rejects(parseKekaFile(Buffer.alloc(0), 'k.csv'), 400);
    await rejects(parseKekaFile(Buffer.from(`${HEADER}\n`), 'k.csv'), 400);
  });
});

describe('KEKA XLSX', () => {
  it('reads the first sheet and keeps numeric phones / Aadhaar as plain digits', async () => {
    const buf = await xlsx([
      HEADER.split(','),
      [
        'Asha Nair',
        'MEI-00733',
        'asha.nair@makeenenergy.com',
        9876543245,
        234567890124,
        'MO',
        'Working',
      ],
    ]);
    const rows = await parseKekaFile(buf, 'keka.xlsx');
    expect(rows[0]?.values.phone).toBe('9876543245');
    expect(rows[0]?.values.aadhaar).toBe('234567890124');
  });

  it('refuses a zip whose central directory inflates past the limit (zip bomb)', async () => {
    const buf = await xlsx([HEADER.split(',')]);
    // Patch every central-directory entry to claim a 200 MB uncompressed size.
    const bomb = Buffer.from(buf);
    for (let i = 0; i + 4 <= bomb.length; i += 1) {
      if (bomb.readUInt32LE(i) === 0x02014b50) bomb.writeUInt32LE(200 * 1024 * 1024, i + 24);
    }
    expect(() => {
      assertSafeZip(bomb);
    }).toThrow(AppError);
    expect(() => {
      assertSafeZip(buf);
    }).not.toThrow();
  });
});

describe('KEKA API rows', () => {
  it('maps objects keyed by the loader columns and ignores other keys', () => {
    expect(
      rowsFromObjects([
        { 'Employee name': 'Asha', 'Employee code': 'MEI-1', Phone: 9876543245, Salary: 1 },
      ]),
    ).toEqual([{ row: 1, values: { name: 'Asha', employeeCode: 'MEI-1', phone: '9876543245' } }]);
  });
});
