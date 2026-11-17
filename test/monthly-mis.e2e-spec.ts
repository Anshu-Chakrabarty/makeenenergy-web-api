/**
 * Phase 7 Monthly MIS suite, end to end against real PostgreSQL.
 * Exit criterion: the Cumulative Daily Summary equals Σ of the Approved Daily rows (and is frozen
 * at Monthly approval). Rows created here use June 2026 — before the seeded history (Aug 2026).
 */
import * as ExcelJS from 'exceljs';
import { Client } from 'pg';
import type { Response } from 'supertest';
import { hashPassword } from '../src/common/crypto/password';
import { defaultMonth } from '../src/modules/monthly-mis/monthly-mis.service';
import {
  MONTHLY_MIS_MESSAGES,
  type ApprovalQueueItem,
  type DailyMisDetail,
  type MonthlyMisDetail,
  type MonthlyMisPage,
  type MonthlySummaryView,
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
const ip = ipFactory(47);
let yediyur = '';
let barhi = '';

const VALUES = {
  ebUnits: '18,420',
  dgUnits: '1200.5',
  dieselDg: '300',
  trainingStaff: 4,
  trainingWorkmen: '6',
  penaltyIncurred: 'NO',
  solarAvailable: 'YES',
  solarCapacity: '100 kW',
  powerFactor: '0.98',
  cvrCycleCountDate: '2026-06-27',
  remarks: 'e2e',
  // The system total 47 sent by a client is ignored (SEC-14).
  trainingTotal: 999,
};
const CYLINDERS = { DUE_TESTING: { KG14_2: 1200, KG35_A: 12, KG35_B: 3 } };
const INVENTORY = { NEW_O_RINGS: 240, DPT_WHITE: '12.5' };

async function as(email: string): Promise<Browser> {
  const s = await signIn(e, ip(), email, PASSWORD);
  expect(s.res.status).toBe(200);
  return s;
}

function save(b: Browser, body: object, id?: string) {
  return call(b, id ? 'put' : 'post', id ? `/api/monthly-mis/${id}` : '/api/monthly-mis').send(
    body,
  );
}

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

interface SqlSummary {
  plant_id: string;
  days: number;
  normal_production: string;
  total_production: string;
  cyl: string;
  tt: string;
  shifts: number;
  gain_loss: string;
  accuracy: string;
  mr: number;
}

/** Items 1, 7, 8, 9, 10, 15, 20, 25 straight from SQL over APPROVED Daily rows. */
async function sqlSummary(month: string): Promise<Map<string, SqlSummary>> {
  const r = await db.query<SqlSummary>(
    `SELECT plant_id,
            count(*)::int AS days,
            COALESCE(sum(COALESCE(normal_cylinder_despatch,0) + COALESCE(normal_tt_loading,0)),0)::numeric(14,3)::text AS normal_production,
            COALESCE(sum(COALESCE(normal_cylinder_despatch,0) + COALESCE(normal_tt_loading,0)
                       + COALESCE(ot_cylinder_despatch,0) + COALESCE(ot_tt_loading,0)),0)::numeric(14,3)::text AS total_production,
            COALESCE(sum(COALESCE(normal_cylinder_despatch,0) + COALESCE(ot_cylinder_despatch,0)),0)::numeric(14,3)::text AS cyl,
            COALESCE(sum(COALESCE(normal_tt_loading,0) + COALESCE(ot_tt_loading,0)),0)::numeric(14,3)::text AS tt,
            COALESCE(sum(shifts_operated),0)::int AS shifts,
            COALESCE(sum(stock_gain_loss),0)::numeric(14,3)::text AS gain_loss,
            COALESCE(round(avg(accuracy_zero), 2), 0)::numeric(5,2)::text AS accuracy,
            COALESCE(sum(mr_total),0)::int AS mr
       FROM daily_mis
      WHERE status = 'APPROVED' AND date_trunc('month', report_date) = $1::date
      GROUP BY plant_id`,
    [`${month}-01`],
  );
  return new Map(r.rows.map((x) => [x.plant_id, x]));
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
    `SELECT id, code::text FROM plants WHERE code IN ('HPY-011','HPB-017')`,
  );
  const id = (c: string): string => p.rows.find((r) => r.code === c)?.id ?? '';
  yediyur = id('HPY-011');
  barhi = id('HPB-017');
  await e.flushRedis();
});

afterAll(async () => {
  // Leave the seeded world as it was for the other suites.
  await db.query(`DELETE FROM monthly_mis WHERE month = '2026-06-01'`);
  await db.query(`DELETE FROM daily_mis WHERE report_date BETWEEN '2026-06-01' AND '2026-06-30'`);
  await db.end();
  await e.close();
});

describe('Cumulative Daily Summary = Σ Approved Daily (Phase 7 exit criterion, MMIS-R4, WF-4)', () => {
  it('every Sep 2026 row of the table equals the SQL sums of its Approved Daily rows', async () => {
    const admin = await as(ANITA);
    const page = (
      await call(admin, 'get', '/api/monthly-mis?month=2026-09&pageSize=200').expect(200)
    ).body as MonthlyMisPage;
    expect(page.total).toBeGreaterThan(5);
    const sql = await sqlSummary('2026-09');
    for (const row of page.rows) {
      const s = sql.get(row.plant.id);
      expect({
        plant: row.plant.code,
        totalProduction: row.totalProduction,
        totalShifts: row.totalShifts,
        cylinderDespatches: row.cylinderDespatches,
        ttLoading: row.ttLoading,
      }).toEqual({
        plant: row.plant.code,
        totalProduction: s?.total_production ?? '0.000',
        totalShifts: s?.shifts ?? 0,
        cylinderDespatches: s?.cyl ?? '0.000',
        ttLoading: s?.tt ?? '0.000',
      });
    }
  });

  it('the detail shows items 1–25 with the Approved-day count; Pending is live, Approved is frozen', async () => {
    const admin = await as(ANITA);
    const sql = await sqlSummary('2026-09');
    const rows = await db.query<{ id: string; plant_id: string; status: string }>(
      `SELECT id, plant_id, status FROM monthly_mis WHERE month = '2026-09-01' AND status IN ('PENDING','APPROVED')`,
    );
    const pending = rows.rows.find((r) => r.status === 'PENDING');
    const approved = rows.rows.find((r) => r.status === 'APPROVED');
    for (const r of [pending, approved]) {
      if (!r) throw new Error('seed has no Pending / Approved Sep row');
      const d = (await call(admin, 'get', `/api/monthly-mis/${r.id}`).expect(200))
        .body as MonthlyMisDetail;
      const s = sql.get(r.plant_id);
      expect(d.summary).toMatchObject({
        frozen: r.status === 'APPROVED',
        daysInMonth: 30,
        approvedDays: s?.days ?? 0,
        items: {
          normalProduction: s?.normal_production,
          totalProduction: s?.total_production,
          totalShifts: String(s?.shifts ?? 0),
          stockGainLoss: s?.gain_loss,
          accuracyZeroAvg: s?.accuracy,
          marketReturns: String(s?.mr ?? 0),
        },
      });
    }
  });

  it('a month with no Approved Daily rows shows 0 everywhere (MMIS-R4)', async () => {
    const asha = await as(ASHA);
    const s = (
      await call(asha, 'get', `/api/monthly-mis/summary?plantId=${yediyur}&month=2026-06`).expect(
        200,
      )
    ).body as MonthlySummaryView;
    expect(s).toMatchObject({
      approvedDays: 0,
      daysInMonth: 30,
      frozen: false,
      items: { totalProduction: '0.000', totalShifts: '0', accuracyZeroAvg: '0.00' },
    });
    await call(asha, 'get', `/api/monthly-mis/summary?plantId=${yediyur}&month=2099-01`).expect(
      400,
    );
  });
});

describe('Block B, cylinders, inventory and the workflow (MMIS-R1, R2, R3, UXV-10, BEV-4)', () => {
  let id = '';
  let version = 0;

  it('Save draft stores Block B, the two 35 kg columns and the inventory; item 47 is computed', async () => {
    const asha = await as(ASHA);
    const r = await save(asha, {
      action: 'draft',
      plantId: yediyur,
      month: '2026-06',
      values: VALUES,
      cylinders: CYLINDERS,
      inventory: INVENTORY,
    }).expect(201);
    const d = r.body as MonthlyMisDetail;
    id = d.id;
    version = d.version;
    expect(d).toMatchObject({
      status: 'DRAFT',
      month: '2026-06',
      trainingTotal: 10,
      values: {
        ebUnits: '18420.00',
        dgUnits: '1200.50',
        powerFactor: '0.980',
        trainingStaff: 4,
        solarAvailable: 'YES',
        cvrCycleCountDate: '2026-06-27',
      },
      cylinders: { DUE_TESTING: { KG14_2: 1200, KG35_A: 12, KG35_B: 3, KG5: null } },
      inventory: { NEW_O_RINGS: 240, DPT_WHITE: '12.50', NEW_SS_CLIP: null },
      summary: { frozen: false, approvedDays: 0 },
      can: { edit: true, approve: false },
    });
    const stored = await db.query(`SELECT training_total FROM monthly_mis WHERE id = $1`, [id]);
    expect(stored.rows[0]).toEqual({ training_total: 10 });
  });

  it('one row per plant and month (BEV-4, D-31)', async () => {
    const asha = await as(ASHA);
    const dup = await save(asha, {
      action: 'draft',
      plantId: yediyur,
      month: '2026-06',
      values: {},
    }).expect(409);
    expect(dup.body.message).toBe(MONTHLY_MIS_MESSAGES.alreadyExists);
  });

  it('Submit: penalty Yes needs a reason, solar Yes needs a capacity (UXV-10)', async () => {
    const asha = await as(ASHA);
    const bad = await save(
      asha,
      {
        action: 'submit',
        version,
        plantId: yediyur,
        month: '2026-06',
        values: { ...VALUES, penaltyIncurred: 'YES', solarCapacity: '' },
      },
      id,
    ).expect(400);
    expect(bad.body.details).toEqual(
      expect.arrayContaining([
        { path: 'values.penaltyDetails', message: MONTHLY_MIS_MESSAGES.penaltyReasonRequired },
        { path: 'values.solarCapacity', message: MONTHLY_MIS_MESSAGES.solarCapacityRequired },
      ]),
    );
    const ok = await save(
      asha,
      {
        action: 'submit',
        version,
        plantId: yediyur,
        month: '2026-06',
        values: VALUES,
        cylinders: CYLINDERS,
        inventory: { ...INVENTORY, NEW_SS_CLIP: 40 },
      },
      id,
    ).expect(200);
    const d = ok.body as MonthlyMisDetail;
    expect(d).toMatchObject({ status: 'PENDING', inventory: { NEW_SS_CLIP: 40 } });
    version = d.version;
  });

  it('the Plant Manager’s queue lists it with module and month; the entry person has no queue', async () => {
    const ravi = await as(RAVI);
    const q = (await call(ravi, 'get', '/api/monthly-mis/queue').expect(200))
      .body as ApprovalQueueItem[];
    expect(q.find((i) => i.id === id)).toMatchObject({ module: 'MONTHLY_MIS', period: '2026-06' });
    expect(q.every((i) => i.plant.code === 'HPY-011')).toBe(true);
    const asha = await as(ASHA);
    await call(asha, 'get', '/api/monthly-mis/queue').expect(403);
  });

  it('Approve freezes Section A; later Daily approvals do not change it until a reopen', async () => {
    const asha = await as(ASHA);
    await call(asha, 'post', `/api/monthly-mis/${id}/approve`).send({ version }).expect(403);
    const ravi = await as(RAVI);
    const ok = await call(ravi, 'post', `/api/monthly-mis/${id}/approve`)
      .send({ version })
      .expect(200);
    const d = ok.body as MonthlyMisDetail;
    expect(d).toMatchObject({
      status: 'APPROVED',
      approvedBy: { name: 'Ravi Kumar' },
      summary: { frozen: true, approvedDays: 0, items: { totalProduction: '0.000' } },
      can: { edit: false },
    });
    version = d.version;
    const snap = await db.query<{ s: { totalProduction: string; approvedDays: number } }>(
      `SELECT summary_snapshot s FROM monthly_mis WHERE id = $1`,
      [id],
    );
    expect(snap.rows[0]?.s).toMatchObject({ totalProduction: '0.000', approvedDays: 0 });

    // An Approved Daily MIS for 10-06-2026 arrives after the month was approved.
    const daily = await call(asha, 'post', '/api/daily-mis')
      .send({
        action: 'submit',
        plantId: yediyur,
        reportDate: '2026-06-10',
        values: { shiftsOperated: '2', normalCylinderDespatch: '100.500', otTtLoading: '4.250' },
      })
      .expect(201);
    const dd = daily.body as DailyMisDetail;
    await call(ravi, 'post', `/api/daily-mis/${dd.id}/approve`)
      .send({ version: dd.version })
      .expect(200);
    const still = (await call(ravi, 'get', `/api/monthly-mis/${id}`).expect(200))
      .body as MonthlyMisDetail;
    expect(still.summary).toMatchObject({ frozen: true, approvedDays: 0 });

    const locked = await save(
      asha,
      { action: 'draft', version, plantId: yediyur, month: '2026-06', values: VALUES },
      id,
    ).expect(409);
    expect(locked.body.message).toBe(MONTHLY_MIS_MESSAGES.locked);
  });

  it('Reopen (Admin, reason) → Pending, snapshot cleared, the summary is live again', async () => {
    const ravi = await as(RAVI);
    await call(ravi, 'post', `/api/monthly-mis/${id}/reopen`)
      .send({ version, reason: 'x' })
      .expect(403);
    const admin = await as(ANITA);
    const r = await call(admin, 'post', `/api/monthly-mis/${id}/reopen`)
      .send({ version, reason: 'June dailies approved late' })
      .expect(200);
    const d = r.body as MonthlyMisDetail;
    expect(d).toMatchObject({
      status: 'PENDING',
      approvedBy: null,
      reopenReason: 'June dailies approved late',
      summary: {
        frozen: false,
        approvedDays: 1,
        items: {
          normalProduction: '100.500',
          otProduction: '4.250',
          totalProduction: '104.750',
          totalShifts: '2',
        },
      },
    });
    const snap = await db.query(`SELECT summary_snapshot FROM monthly_mis WHERE id = $1`, [id]);
    expect(snap.rows[0]).toEqual({ summary_snapshot: null });
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'monthly_mis' AND entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual(['CREATE', 'SUBMIT', 'APPROVE', 'REOPEN']);
  });

  it('Return needs a reason; Returned keeps its status on Save and goes back to Pending on Submit', async () => {
    const asha = await as(ASHA);
    const created = (
      await save(asha, {
        action: 'submit',
        plantId: barhi,
        month: '2026-06',
        values: { penaltyIncurred: 'NO', solarAvailable: 'NO' },
      }).expect(201)
    ).body as MonthlyMisDetail;
    const admin = await as(ANITA);
    await call(admin, 'post', `/api/monthly-mis/${created.id}/return`)
      .send({ version: created.version, reason: ' ' })
      .expect(400);
    const ret = (
      await call(admin, 'post', `/api/monthly-mis/${created.id}/return`)
        .send({ version: created.version, reason: 'Diesel bill missing' })
        .expect(200)
    ).body as MonthlyMisDetail;
    expect(ret).toMatchObject({ status: 'RETURNED', returnReason: 'Diesel bill missing' });
    const kept = (
      await save(
        asha,
        { action: 'draft', version: ret.version, plantId: barhi, month: '2026-06', values: {} },
        created.id,
      ).expect(200)
    ).body as MonthlyMisDetail;
    expect(kept.status).toBe('RETURNED');
    const moved = await save(
      asha,
      { action: 'draft', version: kept.version, plantId: barhi, month: '2026-05', values: {} },
      created.id,
    ).expect(400);
    expect(moved.body.details[0].message).toBe(MONTHLY_MIS_MESSAGES.plantMonthFixed);
    const again = (
      await save(
        asha,
        { action: 'submit', version: kept.version, plantId: barhi, month: '2026-06', values: {} },
        created.id,
      ).expect(200)
    ).body as MonthlyMisDetail;
    expect(again.status).toBe('PENDING');
  });
});

describe('table, cards, plant scope (MMIS-T*, CARD-3, BTN-P2)', () => {
  it('defaults to the previous India month', async () => {
    const admin = await as(ANITA);
    const page = (await call(admin, 'get', '/api/monthly-mis').expect(200)).body as MonthlyMisPage;
    expect(page.month).toBe(defaultMonth());
  });

  it('cards count the month by status; Not started = running plants with no row', async () => {
    const admin = await as(ANITA);
    const page = (
      await call(admin, 'get', '/api/monthly-mis?month=2026-09&status=PENDING').expect(200)
    ).body as MonthlyMisPage;
    const byStatus = await db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int n FROM monthly_mis WHERE month = '2026-09-01' GROUP BY status`,
    );
    const n = (s: string): number => byStatus.rows.find((r) => r.status === s)?.n ?? 0;
    const missing = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM plants p
        WHERE p.deleted_at IS NULL AND p.status = 'WORKING' AND p.start_date <= '2026-09-30'
          AND NOT EXISTS (SELECT 1 FROM monthly_mis m WHERE m.plant_id = p.id AND m.month = '2026-09-01')`,
    );
    expect(page.cards).toEqual({
      pending: n('PENDING'),
      approved: n('APPROVED'),
      returned: n('RETURNED'),
      draft: n('DRAFT'),
      notStarted: missing.rows[0]?.n,
    });
    expect(page.cards.notStarted).toBeGreaterThan(0);
    expect(page.total).toBe(n('PENDING'));
    expect(page.rows.every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('electricity = 26 + 27 and diesel = 31 + 32 per row (D-16)', async () => {
    const admin = await as(ANITA);
    const page = (
      await call(admin, 'get', `/api/monthly-mis?month=2026-09&plantId=${yediyur}`).expect(200)
    ).body as MonthlyMisPage;
    const sql = await db.query<{ e: string; d: string }>(
      `SELECT (COALESCE(eb_units,0) + COALESCE(dg_units,0))::numeric(14,2)::text e,
              (COALESCE(diesel_dg,0) + COALESCE(diesel_fire_engine,0))::numeric(14,2)::text d
         FROM monthly_mis WHERE plant_id = $1 AND month = '2026-09-01'`,
      [yediyur],
    );
    expect(page.rows[0]).toMatchObject({
      electricityUnits: sql.rows[0]?.e,
      dieselConsumed: sql.rows[0]?.d,
    });
  });

  it('Staff on Barhi sees only Barhi and cannot open another plant', async () => {
    const gopal = await as(GOPAL);
    const page = (await call(gopal, 'get', '/api/monthly-mis?month=2026-09').expect(200))
      .body as MonthlyMisPage;
    expect(page.rows.every((r) => r.plant.code === 'HPB-017')).toBe(true);
    const other = await db.query<{ id: string }>(
      `SELECT id FROM monthly_mis WHERE plant_id = $1 LIMIT 1`,
      [yediyur],
    );
    await call(gopal, 'get', `/api/monthly-mis/${other.rows[0]?.id ?? ''}`).expect(404);
    await call(gopal, 'get', `/api/monthly-mis?plantId=${yediyur}`).expect(403);
    await call(gopal, 'get', `/api/monthly-mis/summary?plantId=${yediyur}&month=2026-09`).expect(
      403,
    );
    await save(gopal, { action: 'draft', plantId: barhi, month: '2026-07', values: {} }).expect(
      403,
    );
  });
});

describe('downloads (BTN-4, BEV-6)', () => {
  it('Excel totals equal the list totals for the same filter', async () => {
    const admin = await as(ANITA);
    const page = (await call(admin, 'get', '/api/monthly-mis?month=2026-09&pageSize=5').expect(200))
      .body as MonthlyMisPage;
    const res = await call(admin, 'get', '/api/monthly-mis/export?month=2026-09&format=xlsx')
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="monthly-mis_2026-09.xlsx"',
    );
    const wb = new ExcelJS.Workbook();
    const body = res.body as Buffer;
    const ab = new ArrayBuffer(body.length);
    new Uint8Array(ab).set(body);
    await wb.xlsx.load(ab);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('no sheet');
    expect(text(ws.getCell('A1').value)).toBe('Monthly MIS');
    let totalsRow = 0;
    ws.eachRow((row, n) => {
      if (text(row.getCell(1).value).startsWith('Total (')) totalsRow = n;
    });
    const t = ws.getRow(totalsRow);
    expect(text(t.getCell(1).value)).toBe(`Total (${page.totals.rows} rows)`);
    expect(t.getCell(3).value).toBe(Number(page.totals.totalProduction));
    expect(t.getCell(4).value).toBe(page.totals.totalShifts);
    expect(t.getCell(5).value).toBe(Number(page.totals.electricityUnits));
    expect(t.getCell(6).value).toBe(Number(page.totals.dieselConsumed));
    expect(t.getCell(7).value).toBe(Number(page.totals.cylinderDespatches));
    expect(t.getCell(8).value).toBe(Number(page.totals.ttLoading));
  });

  it('PDF of the table and of one record; Download needs the Download capability', async () => {
    const admin = await as(ANITA);
    const pdf = await call(admin, 'get', '/api/monthly-mis/export?month=2026-09&format=pdf')
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const one = await db.query<{ id: string }>(
      `SELECT id FROM monthly_mis WHERE plant_id = $1 AND month = '2026-09-01'`,
      [yediyur],
    );
    const rec = await call(admin, 'get', `/api/monthly-mis/${one.rows[0]?.id ?? ''}/pdf`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(rec.headers['content-disposition']).toBe(
      'attachment; filename="monthly-mis_HPY-011_2026-09.pdf"',
    );
    expect((rec.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const asha = await as(ASHA);
    await call(asha, 'get', '/api/monthly-mis/export?format=xlsx').expect(403);
  });
});
