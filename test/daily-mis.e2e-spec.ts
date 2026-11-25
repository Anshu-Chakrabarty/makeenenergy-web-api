/**
 * Phase 6 Daily MIS suite, end to end against real PostgreSQL (real Redis in CI).
 * Exit criterion: the downloaded totals equal the list totals for the same filter.
 * Rows created here use May 2026 dates — before the seeded history (from 1 Aug 2026).
 */
import * as ExcelJS from 'exceljs';
import { Client } from 'pg';
import type { Response } from 'supertest';
import { hashPassword } from '../src/common/crypto/password';
import {
  DAILY_MIS_MESSAGES,
  FIELD_MESSAGES,
  addDays,
  istToday,
  serializeGridFilters,
  type ApprovalQueueItem,
  type GridFilter,
  type DailyMisDetail,
  type DailyMisPage,
  type DailyMisRevision,
} from '../src/shared';
import { createE2EApp, type E2EApp } from './support/e2e-app';
import { call, ipFactory, signIn, type Browser } from './support/http';

const PASSWORD = process.env['SEED_DEFAULT_PASSWORD'] ?? '';
const ANITA = 'anita.sharma@makeenenergy.com'; // Admin
const RAVI = 'ravi.kumar@makeenenergy.com'; // Plant Manager, Yediyur
const ASHA = 'asha.nair@makeenenergy.com'; // Maintenance Officer, Yediyur + Barhi
const GOPAL = 'gopal.das@makeenenergy.com'; // Staff, Barhi

let e: E2EApp;
let db: Client;
const ip = ipFactory(43);
let yediyur = '';
let barhi = '';
let gwalior = '';

const VALUES = {
  shiftsOperated: '2',
  otHours: '4',
  openingStock: '412.380',
  bulkReceipts: '180.000',
  normalCylinderDespatch: '198.420',
  normalTtLoading: '12.000',
  otCylinderDespatch: '14.260',
  otTtLoading: '0.000',
  cylFilled142: '14,200',
  cylFilled19: 560,
  prcnReturn: '0.850',
  physicalStock: '368.430',
  lossCarousel: 15,
  lossOld: 10,
  lossConveyor: 20,
  lossUtility: 5,
  lossPowerEb: 35,
  accuracyZero: '62.40',
  mrPinLeak: 3,
  mrPinCut: 1,
  sqcTime: '11:30',
  remarks: 'e2e',
  // System totals sent by a client must be ignored (SEC-14).
  closingBookStock: '999.999',
  mrTotal: 999,
};

async function as(email: string): Promise<Browser> {
  const s = await signIn(e, ip(), email, PASSWORD);
  expect(s.res.status).toBe(200);
  return s;
}

function save(b: Browser, body: object, id?: string) {
  return call(b, id ? 'put' : 'post', id ? `/api/daily-mis/${id}` : '/api/daily-mis').send(body);
}

/** Plain text of an Excel cell value (strings and numbers only). */
function text(v: ExcelJS.CellValue): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function binary(res: Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => {
    cb(null, Buffer.concat(chunks));
  });
}

beforeAll(async () => {
  e = await createE2EApp();
  db = new Client({ connectionString: process.env['E2E_OWNER_URL'] });
  await db.connect();
  const hash = await hashPassword(PASSWORD, process.env['PASSWORD_PEPPER'] ?? '');
  await db.query(
    `UPDATE users SET password_hash = $1, must_set_password = false, login_status = 'ACTIVE'
      WHERE email = ANY($2)`,
    [hash, [ANITA, RAVI, ASHA, GOPAL]],
  );
  const p = await db.query<{ id: string; code: string }>(
    `SELECT id, code::text FROM plants WHERE code IN ('HPY-011','HPB-017','IOW-025')`,
  );
  const id = (c: string): string => p.rows.find((r) => r.code === c)?.id ?? '';
  yediyur = id('HPY-011');
  barhi = id('HPB-017');
  gwalior = id('IOW-025');
  await e.flushRedis();
});

afterAll(async () => {
  // Leave the seeded world as it was for the other suites (they count Pending rows).
  await db.query(`DELETE FROM daily_mis WHERE report_date BETWEEN '2026-05-01' AND '2026-05-31'`);
  await db.end();
  await e.close();
});

describe('save and submit (DMIS-R1, DMIS-R2, BEV-3, SEC-14)', () => {
  let rowId = '';

  it('Save draft computes every system sum itself and records revision 1', async () => {
    const asha = await as(ASHA);
    const res = await save(asha, {
      action: 'draft',
      plantId: yediyur,
      reportDate: '2026-05-04',
      values: VALUES,
    }).expect(201);
    const d = res.body as DailyMisDetail;
    rowId = d.id;
    expect(d).toMatchObject({
      status: 'DRAFT',
      version: 1,
      enteredBy: { name: 'Asha Nair' },
      values: { cylFilled142: 14200, otHours: '4.00', shiftsOperated: '2' },
      derived: {
        closingBookStock: '368.550',
        stockGainLoss: '-0.120',
        lossMechanicalTotal: 50,
        lossElectricalTotal: 35,
        mrTotal: 4,
      },
      can: { edit: true, approve: false, download: false },
    });
    expect(d.revisions).toHaveLength(1);
    const stored = await db.query(
      `SELECT closing_book_stock::text c, mr_total FROM daily_mis WHERE id = $1`,
      [rowId],
    );
    expect(stored.rows[0]).toEqual({ c: '368.550', mr_total: 4 });
  });

  it('a second Daily MIS for the same plant and date is blocked', async () => {
    const asha = await as(ASHA);
    const second = await save(asha, {
      action: 'draft',
      plantId: yediyur,
      reportDate: '2026-05-04',
      values: {},
    }).expect(409);
    expect(second.body.message).toBe(DAILY_MIS_MESSAGES.duplicate);
    const first = await call(asha, 'get', `/api/daily-mis/${rowId}`).expect(200);
    await save(
      asha,
      {
        action: 'submit',
        version: (first.body as DailyMisDetail).version,
        plantId: yediyur,
        reportDate: '2026-05-04',
        values: VALUES,
      },
      rowId,
    ).expect(200);
    const fresh = await save(asha, {
      action: 'submit',
      plantId: yediyur,
      reportDate: '2026-05-04',
      values: {},
    }).expect(409);
    expect(fresh.body.message).toBe(DAILY_MIS_MESSAGES.duplicate);
  });

  it('refuses a future India date, bad numbers, and a stale version', async () => {
    const asha = await as(ASHA);
    const future = await save(asha, {
      action: 'draft',
      plantId: yediyur,
      reportDate: addDays(istToday(), 1),
      values: {},
    }).expect(400);
    expect(future.body.details).toEqual([
      { path: 'reportDate', message: FIELD_MESSAGES.dateFuture },
    ]);
    const bad = await save(asha, {
      action: 'draft',
      plantId: yediyur,
      reportDate: '2026-05-05',
      values: { accuracyZero: '101', lossCarousel: '-3' },
    }).expect(400);
    expect(bad.body.details).toEqual(
      expect.arrayContaining([
        { path: 'values.accuracyZero', message: FIELD_MESSAGES.percent },
        { path: 'values.lossCarousel', message: FIELD_MESSAGES.negative },
      ]),
    );
    const stale = await save(
      asha,
      { action: 'draft', version: 1, plantId: yediyur, reportDate: '2026-05-04', values: VALUES },
      rowId,
    ).expect(409);
    expect(stale.body.message).toBe(DAILY_MIS_MESSAGES.stale);
  });

  it('the next calendar day is never blocked by a Pending day (APPR-4)', async () => {
    const asha = await as(ASHA);
    await save(asha, {
      action: 'submit',
      plantId: yediyur,
      reportDate: '2026-05-05',
      values: VALUES,
    }).expect(201);
  });

  it('plant scope: no Submit on an unassigned plant, no Submit for a Plant Manager', async () => {
    const asha = await as(ASHA);
    await save(asha, {
      action: 'draft',
      plantId: gwalior,
      reportDate: '2026-05-04',
      values: {},
    }).expect(403);
    const ravi = await as(RAVI);
    await save(ravi, {
      action: 'draft',
      plantId: yediyur,
      reportDate: '2026-05-06',
      values: {},
    }).expect(403);
  });
});

describe('approve, return, reopen (APPR-1…5, BEV-2, UXV-8)', () => {
  let id = '';
  let version = 0;

  beforeAll(async () => {
    const asha = await as(ASHA);
    const r = await save(asha, {
      action: 'submit',
      plantId: yediyur,
      reportDate: '2026-05-10',
      values: VALUES,
    }).expect(201);
    id = (r.body as DailyMisDetail).id;
    version = (r.body as DailyMisDetail).version;
  });

  it('only the plant’s approver sees the row in the queue, oldest first', async () => {
    const ravi = await as(RAVI);
    const q = (await call(ravi, 'get', '/api/daily-mis/queue').expect(200))
      .body as ApprovalQueueItem[];
    expect(q.length).toBeGreaterThan(0);
    expect(q.every((i) => i.plant.code === 'HPY-011')).toBe(true);
    const times = q.map((i) => i.waitingHours);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(q.some((i) => i.id === id)).toBe(true);
    const asha = await as(ASHA);
    await call(asha, 'get', '/api/daily-mis/queue').expect(403);
  });

  it('Return needs a reason; with one the row is Returned and the reason is kept', async () => {
    const ravi = await as(RAVI);
    const empty = await call(ravi, 'post', `/api/daily-mis/${id}/return`)
      .send({ version, reason: ' ' })
      .expect(400);
    expect(empty.body.details[0].message).toBe(DAILY_MIS_MESSAGES.returnReasonRequired);
    const r = await call(ravi, 'post', `/api/daily-mis/${id}/return`)
      .send({ version, reason: 'Recheck physical stock' })
      .expect(200);
    const d = r.body as DailyMisDetail;
    expect(d).toMatchObject({
      status: 'RETURNED',
      returnReason: 'Recheck physical stock',
      returnedBy: { name: 'Ravi Kumar' },
    });
    version = d.version;
  });

  it('“Edit & save again” sends it back to Pending; Save draft on Returned keeps Returned (D-29)', async () => {
    const asha = await as(ASHA);
    const draft = await save(
      asha,
      {
        action: 'draft',
        version,
        plantId: yediyur,
        reportDate: '2026-05-10',
        values: { ...VALUES, physicalStock: '368.550' },
      },
      id,
    ).expect(200);
    expect((draft.body as DailyMisDetail).status).toBe('RETURNED');
    const again = await save(
      asha,
      {
        action: 'submit',
        version: (draft.body as DailyMisDetail).version,
        plantId: yediyur,
        reportDate: '2026-05-10',
        values: { ...VALUES, physicalStock: '368.550' },
      },
      id,
    ).expect(200);
    const d = again.body as DailyMisDetail;
    expect(d).toMatchObject({ status: 'PENDING', derived: { stockGainLoss: '0.000' } });
    expect(d.revisions.map((r) => r.status)).toEqual([
      'PENDING',
      'RETURNED',
      'RETURNED',
      'PENDING',
    ]);
    version = d.version;
  });

  it('the entry person cannot approve; the Plant Manager approves and the row locks', async () => {
    const asha = await as(ASHA);
    await call(asha, 'post', `/api/daily-mis/${id}/approve`).send({ version }).expect(403);
    const ravi = await as(RAVI);
    const ok = await call(ravi, 'post', `/api/daily-mis/${id}/approve`)
      .send({ version })
      .expect(200);
    const d = ok.body as DailyMisDetail;
    expect(d).toMatchObject({
      status: 'APPROVED',
      approvedBy: { name: 'Ravi Kumar' },
      can: { edit: false },
    });
    version = d.version;
    const locked = await save(
      asha,
      { action: 'draft', version, plantId: yediyur, reportDate: '2026-05-10', values: VALUES },
      id,
    ).expect(409);
    expect(locked.body.message).toBe(DAILY_MIS_MESSAGES.locked);
    const twice = await call(ravi, 'post', `/api/daily-mis/${id}/approve`)
      .send({ version })
      .expect(409);
    expect(twice.body.message).toBe(DAILY_MIS_MESSAGES.notPending);
  });

  it('only a role with the Reopen switch reopens, with a reason; the row is Pending again', async () => {
    const ravi = await as(RAVI);
    await call(ravi, 'post', `/api/daily-mis/${id}/reopen`)
      .send({ version, reason: 'x' })
      .expect(403);
    const admin = await as(ANITA);
    await call(admin, 'post', `/api/daily-mis/${id}/reopen`)
      .send({ version, reason: '' })
      .expect(400);
    const r = await call(admin, 'post', `/api/daily-mis/${id}/reopen`)
      .send({ version, reason: 'Wrong tank dip used' })
      .expect(200);
    expect(r.body).toMatchObject({
      status: 'PENDING',
      reopenReason: 'Wrong tank dip used',
      approvedBy: null,
    });
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'daily_mis' AND entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual([
      'SUBMIT',
      'RETURN',
      'UPDATE',
      'SUBMIT',
      'APPROVE',
      'REOPEN',
    ]);
  });

  it('every save is a time-stamped revision that can be read back', async () => {
    const admin = await as(ANITA);
    const rev = await call(admin, 'get', `/api/daily-mis/${id}/revisions/1`).expect(200);
    expect((rev.body as DailyMisRevision).values.physicalStock).toBe('368.430');
    const last = await call(admin, 'get', `/api/daily-mis/${id}/revisions/4`).expect(200);
    expect((last.body as DailyMisRevision).values.physicalStock).toBe('368.550');
  });
});

describe('table, cards, plant scope (DMIS-T*, CARD-2, GEN-1)', () => {
  it('Staff on Barhi sees only Barhi rows and cannot open Yediyur', async () => {
    const gopal = await as(GOPAL);
    const page = (
      await call(gopal, 'get', '/api/daily-mis?from=2026-10-01&to=2026-10-16&pageSize=200').expect(
        200,
      )
    ).body as DailyMisPage;
    expect(page.total).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.plant.code === 'HPB-017')).toBe(true);
    const other = await db.query<{ id: string }>(
      `SELECT id FROM daily_mis WHERE plant_id = $1 LIMIT 1`,
      [yediyur],
    );
    // Row-level security hides another plant's row entirely: 404, existence not revealed (D-88).
    await call(gopal, 'get', `/api/daily-mis/${other.rows[0]?.id ?? ''}`).expect(404);
    await call(gopal, 'get', `/api/daily-mis?plantId=${yediyur}`).expect(403);
    await call(gopal, 'get', `/api/daily-mis?plantId=${barhi}`).expect(200);
  });

  it('cards count the filter by status (without the status filter itself)', async () => {
    const admin = await as(ANITA);
    const page = (
      await call(
        admin,
        'get',
        '/api/daily-mis?from=2026-10-01&to=2026-10-16&status=PENDING',
      ).expect(200)
    ).body as DailyMisPage;
    const db1 = await db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int n FROM daily_mis WHERE report_date BETWEEN '2026-10-01' AND '2026-10-16' GROUP BY status`,
    );
    const n = (s: string): number => db1.rows.find((r) => r.status === s)?.n ?? 0;
    expect(page.cards).toMatchObject({
      pending: n('PENDING'),
      approved: n('APPROVED'),
      returned: n('RETURNED'),
      draft: n('DRAFT'),
    });
    expect(page.total).toBe(n('PENDING'));
    expect(page.rows.every((r) => r.status === 'PENDING')).toBe(true);
  });
});

describe('grid: column filters, search, sort (read-only over the seeded October)', () => {
  const RANGE = 'from=2026-10-01&to=2026-10-16';
  const SQL_RANGE = `m.report_date BETWEEN '2026-10-01' AND '2026-10-16' AND p.deleted_at IS NULL`;
  const grid = (filters: GridFilter[], extra = ''): string =>
    `/api/daily-mis?${RANGE}&pageSize=200&filters=${encodeURIComponent(
      serializeGridFilters(filters) ?? '',
    )}${extra}`;
  const count = async (cond: string, params: unknown[] = []): Promise<number> =>
    (
      await db.query<{ n: number }>(
        `SELECT count(*)::int n FROM daily_mis m JOIN plants p ON p.id = m.plant_id
          WHERE ${SQL_RANGE} AND ${cond}`,
        params,
      )
    ).rows[0]?.n ?? 0;

  it('number operators match SQL, including the derived bottling despatches', async () => {
    const admin = await as(ANITA);
    const gt = (
      await call(admin, 'get', grid([{ field: 'physicalStock', op: 'gt', value: '300' }])).expect(
        200,
      )
    ).body as DailyMisPage;
    expect(gt.total).toBe(await count('m.physical_stock > 300'));
    expect(gt.rows.every((r) => Number(r.physicalStock) > 300)).toBe(true);
    const between = (
      await call(
        admin,
        'get',
        grid([{ field: 'bottlingDespatches', op: 'between', value: '100', value2: '250' }]),
      ).expect(200)
    ).body as DailyMisPage;
    expect(between.total).toBe(
      await count(
        `(m.normal_cylinder_despatch IS NOT NULL OR m.ot_cylinder_despatch IS NOT NULL)
         AND COALESCE(m.normal_cylinder_despatch,0) + COALESCE(m.ot_cylinder_despatch,0) BETWEEN 100 AND 250`,
      ),
    );
    // Totals cover the filter, not the whole range.
    expect(between.totals.rows).toBe(between.total);
  });

  it('text, enum and search narrow the rows; cards ignore only the status filter', async () => {
    const admin = await as(ANITA);
    const text = (
      await call(admin, 'get', grid([{ field: 'plant', op: 'contains', value: 'yediy' }])).expect(
        200,
      )
    ).body as DailyMisPage;
    expect(text.total).toBe(await count(`p.name ILIKE '%yediy%'`));
    expect(text.total).toBeGreaterThan(0);
    const both = (
      await call(
        admin,
        'get',
        grid([
          { field: 'plant', op: 'contains', value: 'yediy' },
          { field: 'status', op: 'in', values: ['APPROVED'] },
        ]),
      ).expect(200)
    ).body as DailyMisPage;
    expect(both.rows.every((r) => r.status === 'APPROVED')).toBe(true);
    expect(both.cards.approved).toBe(both.total);
    expect(both.cards.approved + both.cards.pending + both.cards.returned + both.cards.draft).toBe(
      text.total,
    );
    const q = (
      await call(admin, 'get', `/api/daily-mis?${RANGE}&pageSize=200&q=HPY-011`).expect(200)
    ).body as DailyMisPage;
    expect(q.total).toBe(await count(`p.code::text = 'HPY-011'`));
  });

  it('sorts by a column (blanks last) and by the derived value, with stable paging', async () => {
    const admin = await as(ANITA);
    const asc = (
      await call(admin, 'get', `/api/daily-mis?${RANGE}&pageSize=200&sort=accuracyZero:asc`).expect(
        200,
      )
    ).body as DailyMisPage;
    const acc = asc.rows.map((r) => r.accuracyZero);
    const firstBlank = acc.indexOf(null);
    const numbers = (firstBlank < 0 ? acc : acc.slice(0, firstBlank)).map(Number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    if (firstBlank >= 0) expect(acc.slice(firstBlank).every((v) => v === null)).toBe(true);
    const sort = 'sort=bottlingDespatches:desc';
    const all = (
      await call(admin, 'get', `/api/daily-mis?${RANGE}&pageSize=200&${sort}`).expect(200)
    ).body as DailyMisPage;
    const p2 = (
      await call(admin, 'get', `/api/daily-mis?${RANGE}&pageSize=5&page=2&${sort}`).expect(200)
    ).body as DailyMisPage;
    expect(p2.rows.map((r) => r.id)).toEqual(all.rows.slice(5, 10).map((r) => r.id));
    const d = all.rows
      .map((r) => r.bottlingDespatches)
      .filter((v) => v !== null)
      .map(Number);
    expect(d).toEqual([...d].sort((a, b) => b - a));
  });

  it('refuses unknown columns, wrong operators and bad values with VALIDATION_FAILED', async () => {
    const admin = await as(ANITA);
    for (const bad of [
      `filters=${encodeURIComponent('[{"field":"enteredById","op":"equals","value":"x"}]')}`,
      `filters=${encodeURIComponent('[{"field":"physicalStock","op":"contains","value":"1"}]')}`,
      `filters=${encodeURIComponent('[{"field":"physicalStock","op":"gt","value":"1;drop"}]')}`,
      'filters=not-json',
      'sort=enteredBy:asc',
    ]) {
      const res = await call(admin, 'get', `/api/daily-mis?${RANGE}&${bad}`).expect(400);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
    }
  });

  it('the download uses the same grid filter: Excel totals equal the list totals', async () => {
    const admin = await as(ANITA);
    const filters = encodeURIComponent(
      serializeGridFilters([{ field: 'physicalStock', op: 'gte', value: '200' }]) ?? '',
    );
    const qs = `${RANGE}&filters=${filters}&sort=physicalStock:desc`;
    const page = (await call(admin, 'get', `/api/daily-mis?${qs}`).expect(200))
      .body as DailyMisPage;
    const res = await call(admin, 'get', `/api/daily-mis/export?${qs}&format=xlsx`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    const wb = new ExcelJS.Workbook();
    const body = res.body as Buffer;
    const ab = new ArrayBuffer(body.length);
    new Uint8Array(ab).set(body);
    await wb.xlsx.load(ab);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('no sheet');
    let totalsRow = 0;
    let header = '';
    ws.eachRow((row, n) => {
      const v = text(row.getCell(1).value);
      if (v.startsWith('Total (')) totalsRow = n;
      if (v.includes('Physical stock (MT) ≥ 200')) header = v;
    });
    const t = ws.getRow(totalsRow);
    expect(text(t.getCell(1).value)).toBe(`Total (${String(page.totals.rows)} rows)`);
    expect(t.getCell(5).value).toBe(Number(page.totals.bottlingDespatches));
    expect(t.getCell(9).value).toBe(Number(page.totals.stockGainLoss));
    expect(header).not.toBe('');
  });
});

describe('downloads (BTN-4, BEV-6 — Phase 6 exit criterion)', () => {
  it('Excel totals equal the list totals for the same filter', async () => {
    const admin = await as(ANITA);
    const filter = 'from=2026-10-01&to=2026-10-16';
    const page = (await call(admin, 'get', `/api/daily-mis?${filter}&pageSize=10`).expect(200))
      .body as DailyMisPage;
    const res = await call(admin, 'get', `/api/daily-mis/export?${filter}&format=xlsx`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="daily-mis_2026-10-01_2026-10-16\.xlsx"$/,
    );
    const wb = new ExcelJS.Workbook();
    // ExcelJS types its input as an ArrayBuffer.
    const body = res.body as Buffer;
    const ab = new ArrayBuffer(body.length);
    new Uint8Array(ab).set(body);
    await wb.xlsx.load(ab);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('no sheet');
    expect(text(ws.getCell('A1').value)).toBe('Daily MIS');
    expect(text(ws.getCell('A2').value)).toMatch(/^Report ID: RPT-[0-9A-F]{8}$/);
    let totalsRow = 0;
    let dataRows = 0;
    ws.eachRow((row, n) => {
      const first = text(row.getCell(1).value);
      if (first.startsWith('Total (')) totalsRow = n;
      else if (n > 5 && row.getCell(2).value && !first.startsWith('Generated')) dataRows += 1;
    });
    const t = ws.getRow(totalsRow);
    expect(dataRows).toBe(page.totals.rows);
    expect(t.getCell(5).value).toBe(Number(page.totals.bottlingDespatches));
    expect(t.getCell(6).value).toBe(page.totals.cylFilled142);
    expect(t.getCell(7).value).toBe(page.totals.cylFilled19);
    expect(t.getCell(8).value).toBe(page.totals.cylFilledOther);
    expect(t.getCell(9).value).toBe(Number(page.totals.stockGainLoss));
    expect(t.getCell(10).value).toBe(Number(page.totals.accuracyZeroAverage));
    const audit = await db.query(
      `SELECT count(*)::int n FROM audit_log WHERE action = 'EXPORT' AND entity = 'daily_mis'`,
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('PDF of the table and of one record; Download needs the Download capability', async () => {
    const admin = await as(ANITA);
    const pdf = await call(
      admin,
      'get',
      '/api/daily-mis/export?from=2026-10-15&to=2026-10-15&format=pdf',
    )
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const one = await db.query<{ id: string }>(
      `SELECT id FROM daily_mis WHERE plant_id = $1 LIMIT 1`,
      [yediyur],
    );
    const rec = await call(admin, 'get', `/api/daily-mis/${one.rows[0]?.id ?? ''}/pdf`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((rec.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const asha = await as(ASHA);
    await call(asha, 'get', '/api/daily-mis/export?format=xlsx').expect(403);
  });
});
