/**
 * Phase 4 People suite, end to end against real PostgreSQL (real Redis in CI): KEKA loader,
 * People table, Assign, User logins (activate / deactivate / reset), Role access, Create role and
 * the designation map. People touched here are created by this suite's own KEKA loads (MEI-090xx)
 * so the seed-based suites keep their state.
 */
import * as ExcelJS from 'exceljs';
import { Client } from 'pg';
import { hashPassword } from '../src/common/crypto/password';
import { AUTH_MESSAGES, KEKA_MESSAGES, PEOPLE_MESSAGES, verhoeffCheckDigit } from '../src/shared';
import type { ImportRowResult } from '../src/modules/people/keka-import.service';
import type { PersonRow } from '../src/modules/people/people.service';
import type { DesignationRow, RoleDetail, RoleSummary } from '../src/modules/people/roles.service';
import { createE2EApp, type E2EApp } from './support/e2e-app';
import { call, ipFactory, signIn, type Browser } from './support/http';

const PASSWORD = process.env['SEED_DEFAULT_PASSWORD'] ?? '';
const RESET = process.env['RESET_DEFAULT_PASSWORD'] ?? '';
const ANITA = 'anita.sharma@makeenenergy.com'; // Admin
const RAJESH = 'rajesh.menon@makeenenergy.com'; // QHSE Head, all plants
const HEADER = 'Employee name,Employee code,Email,Phone,Aadhaar,Designation,Working / Resigned';

let e: E2EApp;
let db: Client;
let admin: Browser;
const ip = ipFactory(42);

const aadhaar = (body11: string): string => `${body11}${verhoeffCheckDigit(body11)}`;
/** Same body, wrong check digit — always invalid. */
const badAadhaar = (body11: string): string => `${body11}${(verhoeffCheckDigit(body11) + 1) % 10}`;

interface Person {
  code: string;
  name: string;
  email: string;
  phone: string;
  aadhaar: string;
  designation: string;
  status: 'Working' | 'Resigned';
}

const NEW: Record<'trainee' | 'pm' | 'hsse' | 'auditor', Person> = {
  trainee: {
    code: 'MEI-09001',
    name: 'Tara Trainee',
    email: 'tara.trainee@makeenenergy.com',
    phone: '+91 98450 90001',
    aadhaar: aadhaar('29001234567'),
    designation: 'Graduate Trainee',
    status: 'Working',
  },
  pm: {
    code: 'MEI-09002',
    name: 'Pavan Manager',
    email: 'pavan.manager@makeenenergy.com',
    phone: '9845090002',
    aadhaar: aadhaar('29002234567'),
    designation: 'Plant Manager',
    status: 'Working',
  },
  hsse: {
    code: 'MEI-09003',
    name: 'Hema Safety',
    email: 'hema.safety@makeenenergy.com',
    phone: '9845090003',
    aadhaar: '',
    designation: 'Asst Manager — HSSE',
    status: 'Working',
  },
  auditor: {
    code: 'MEI-09004',
    name: 'Arun Auditor',
    email: 'arun.auditor@makeenenergy.com',
    phone: '9845090004',
    aadhaar: '',
    designation: 'Auditor — Regional',
    status: 'Working',
  },
};

const line = (p: Person): string =>
  [p.name, p.code, p.email, p.phone, p.aadhaar, p.designation, p.status]
    .map((v) => (v.includes(',') ? `"${v}"` : v))
    .join(',');
const csv = (...rows: string[]): Buffer => Buffer.from(`${HEADER}\n${rows.join('\n')}\n`);

function upload(b: Browser, file: Buffer, name: string, dryRun: boolean) {
  return call(b, 'post', '/api/people/import')
    .field('dryRun', String(dryRun))
    .attach('file', file, name);
}

async function idOf(code: string): Promise<string> {
  const r = await db.query<{ id: string }>(`SELECT id FROM users WHERE employee_code = $1`, [code]);
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`no user ${code}`);
  return id;
}

async function roleId(name: string): Promise<string> {
  const r = await db.query<{ id: string }>(`SELECT id FROM roles WHERE name = $1`, [name]);
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`no role ${name}`);
  return id;
}

async function plantId(code: string): Promise<string> {
  const r = await db.query<{ id: string }>(`SELECT id FROM plants WHERE code = $1`, [code]);
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`no plant ${code}`);
  return id;
}

async function setPassword(code: string, password = PASSWORD): Promise<void> {
  const hash = await hashPassword(password, process.env['PASSWORD_PEPPER'] ?? '');
  await db.query(
    `UPDATE users SET password_hash = $1, must_set_password = false WHERE employee_code = $2`,
    [hash, code],
  );
  await e.flushRedis();
}

async function as(email: string, password = PASSWORD): Promise<Browser> {
  const s = await signIn(e, ip(), email, password);
  expect(s.res.status).toBe(200);
  return s;
}

beforeAll(async () => {
  expect(RESET.length).toBeGreaterThanOrEqual(12);
  e = await createE2EApp();
  db = new Client({ connectionString: process.env['E2E_OWNER_URL'] });
  await db.connect();
  const hash = await hashPassword(PASSWORD, process.env['PASSWORD_PEPPER'] ?? '');
  await db.query(
    `UPDATE users SET password_hash = $1, must_set_password = false, login_status = 'ACTIVE'
      WHERE email = ANY($2)`,
    [hash, [ANITA, RAJESH]],
  );
  await e.flushRedis();
  admin = await as(ANITA);
});

afterAll(async () => {
  await db.end();
  await e.close();
});

describe('KEKA loader (PPL-2, PPL-3)', () => {
  it('dry run previews every row and changes nothing', async () => {
    const before = await db.query(`SELECT count(*)::int n FROM users`);
    const file = csv(
      line(NEW.trainee),
      line(NEW.pm),
      line(NEW.hsse),
      line(NEW.auditor),
      line({
        ...NEW.pm,
        code: 'MEI-09009',
        name: 'Bad Aadhaar',
        email: 'bad.a@makeenenergy.com',
        aadhaar: badAadhaar('23451234123'),
      }),
      line({ ...NEW.pm, code: 'MEI-09010', name: 'Gmail', email: 'someone@gmail.com' }),
      line({ ...NEW.pm, code: 'MEI-09011', name: 'Dup 1', email: 'dup1@makeenenergy.com' }),
      line({ ...NEW.pm, code: 'MEI-09011', name: 'Dup 2', email: 'dup2@makeenenergy.com' }),
      'Asha Nair,MEI-00733,asha.nair@makeenenergy.com,9876543245,,Maintenance Officer,Working',
    );
    const res = await upload(admin, file, 'keka.csv', true).expect(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.totals).toEqual({ total: 9, created: 4, updated: 1, unchanged: 0, failed: 4 });
    const rows = res.body.rows as ImportRowResult[];
    const byRow = (n: number): ImportRowResult => {
      const r = rows.find((x) => x.row === n);
      if (!r) throw new Error(`no row ${n}`);
      return r;
    };
    expect(byRow(2)).toMatchObject({ outcome: 'CREATE', employeeCode: 'MEI-09001' });
    expect(byRow(2).notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/not in the designation map/)]),
    );
    expect(byRow(4).notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/several roles/)]),
    );
    expect(byRow(6).errors).toEqual([{ field: 'Aadhaar', message: KEKA_MESSAGES.aadhaarInvalid }]);
    expect(byRow(7).errors).toEqual([{ field: 'Email', message: KEKA_MESSAGES.emailNotMakeen }]);
    expect(byRow(8).errors[0]?.message).toBe(KEKA_MESSAGES.duplicateCode);
    expect(byRow(9).errors[0]?.message).toBe(KEKA_MESSAGES.duplicateCode);
    // Asha's KEKA data differs from the seed (Aadhaar blank here) → would be an UPDATE.
    expect(byRow(10).outcome).toBe('UPDATE');
    const after = await db.query(`SELECT count(*)::int n FROM users`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const batch = await db.query(
      `SELECT dry_run, total_rows, failed FROM keka_import_batches ORDER BY started_at DESC LIMIT 1`,
    );
    expect(batch.rows[0]).toEqual({ dry_run: true, total_rows: 9, failed: 4 });
  });

  it('applies: new people start Inactive, base role from the designation map, Aadhaar encrypted', async () => {
    const res = await upload(
      admin,
      csv(line(NEW.trainee), line(NEW.pm), line(NEW.hsse), line(NEW.auditor)),
      'keka.csv',
      false,
    ).expect(200);
    expect(res.body.totals).toMatchObject({ created: 4, failed: 0 });
    const rows = await db.query<{
      employee_code: string;
      login_status: string;
      role: string | null;
      phone: string;
      aadhaar_last4: string | null;
      enc_has_digits: boolean | null;
    }>(
      `SELECT u.employee_code, u.login_status, r.name::text AS role, u.phone, u.aadhaar_last4,
              position(convert_to($1, 'UTF8') in u.aadhaar_enc) > 0 AS enc_has_digits
         FROM users u LEFT JOIN roles r ON r.id = u.base_role_id
        WHERE u.employee_code LIKE 'MEI-090%' ORDER BY 1`,
      [NEW.trainee.aadhaar],
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        employee_code: 'MEI-09001',
        login_status: 'INACTIVE',
        role: null,
        phone: '9845090001',
        aadhaar_last4: NEW.trainee.aadhaar.slice(-4),
        enc_has_digits: false,
      }),
      expect.objectContaining({ employee_code: 'MEI-09002', role: 'Plant Manager' }),
      expect.objectContaining({ employee_code: 'MEI-09003', role: null }),
      expect.objectContaining({ employee_code: 'MEI-09004', role: null }),
    ]);
    const audit = await db.query(
      `SELECT count(*)::int n FROM audit_log WHERE action = 'KEKA_IMPORT' AND entity_id = $1`,
      [res.body.batchId],
    );
    expect(audit.rows[0]).toEqual({ n: 1 });
    const status = await call(admin, 'get', '/api/people/import/status').expect(200);
    expect(status.body).toMatchObject({
      apiConfigured: false,
      last: { source: 'CSV', fileName: 'keka.csv', totals: { created: 4 } },
    });
  });

  it('loading the same file again changes nothing', async () => {
    const res = await upload(
      admin,
      csv(line(NEW.trainee), line(NEW.pm), line(NEW.hsse), line(NEW.auditor)),
      'keka.csv',
      true,
    ).expect(200);
    expect(res.body.totals).toMatchObject({ unchanged: 4, created: 0, updated: 0 });
  });

  it('reads the same columns from Excel (.xlsx)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('KEKA');
    ws.addRow(HEADER.split(','));
    ws.addRow([
      NEW.pm.name,
      NEW.pm.code,
      NEW.pm.email,
      9845090099,
      NEW.pm.aadhaar,
      NEW.pm.designation,
      'Working',
    ]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await upload(admin, buf, 'keka.xlsx', true).expect(200);
    expect(res.body.rows[0]).toMatchObject({ outcome: 'UPDATE', changes: ['Phone'] });
  });

  it('a resignation in KEKA signs the person out at once', async () => {
    const code = NEW.pm.code;
    await setPassword(code);
    await call(admin, 'put', `/api/people/${await idOf(code)}/assignment`)
      .send({
        plantIds: [await plantId('BPS-004')],
        roleId: await roleId('Plant Manager'),
        loginStatus: 'ACTIVE',
      })
      .expect(200);
    const pavan = await as(NEW.pm.email);
    await call(pavan, 'get', '/api/me').expect(200);
    const res = await upload(
      admin,
      csv(line({ ...NEW.pm, status: 'Resigned' })),
      'keka.csv',
      false,
    ).expect(200);
    expect(res.body.rows[0]).toMatchObject({ outcome: 'UPDATE', changes: ['Working / Resigned'] });
    expect(res.body.rows[0].notes[0]).toMatch(/signed out/);
    await call(pavan, 'get', '/api/me').expect(401);
    const u = await db.query(
      `SELECT login_status, working_status FROM users WHERE employee_code=$1`,
      [code],
    );
    expect(u.rows[0]).toEqual({ login_status: 'INACTIVE', working_status: 'RESIGNED' });
  });

  it('refuses other file types by content, and lists missing columns', async () => {
    const pdf = await upload(admin, Buffer.from('%PDF-1.7 fake'), 'keka.pdf', true);
    expect(pdf.status).toBe(415);
    const disguised = await upload(
      admin,
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]),
      'keka.csv',
      true,
    );
    expect(disguised.status).toBe(415);
    const missing = await upload(
      admin,
      Buffer.from('Employee name,Email\nA,b@makeenenergy.com\n'),
      'k.csv',
      true,
    );
    expect(missing.status).toBe(400);
    expect(missing.body.details.missingColumns).toContain('Employee code');
    const none = await call(admin, 'post', '/api/people/import').field('dryRun', 'true');
    expect(none.status).toBe(400);
  });

  it('says the KEKA API is not connected until the server is pointed at it', async () => {
    const res = await call(admin, 'post', '/api/people/import/keka-api').send({ dryRun: true });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(PEOPLE_MESSAGES.kekaApiNotConnected);
  });
});

describe('People table (PPL-T1…T11, CARD-9, BTN-P8)', () => {
  it('shows KEKA fields masked, plants and roles, and the four cards', async () => {
    const res = await call(admin, 'get', '/api/people?q=MEI-00733').expect(200);
    expect(res.body.total).toBe(1);
    const asha = (res.body.rows as PersonRow[])[0];
    expect(asha).toMatchObject({
      name: 'Asha Nair',
      employeeCode: 'MEI-00733',
      phone: '98XXXXXX45',
      aadhaar: 'XXXX-XXXX-1102',
      designation: 'Maintenance Officer',
      role: { name: 'Maintenance Officer' },
      loginStatus: 'ACTIVE',
      workingStatus: 'WORKING',
      hasRole: true,
    });
    expect(asha?.plants.map((p) => p.code).sort()).toEqual(['HPB-017', 'HPY-011']);
    const all = await call(admin, 'get', '/api/people?pageSize=200').expect(200);
    const db1 = await db.query(
      `SELECT count(*) FILTER (WHERE working_status='WORKING')::int working,
              count(*) FILTER (WHERE working_status='RESIGNED')::int resigned,
              count(*) FILTER (WHERE login_status='ACTIVE')::int active,
              count(*) FILTER (WHERE login_status='INACTIVE')::int inactive FROM users`,
    );
    expect(all.body.cards).toEqual({
      working: db1.rows[0].working,
      resigned: db1.rows[0].resigned,
      activeLogins: db1.rows[0].active,
      inactiveLogins: db1.rows[0].inactive,
    });
    // Only masked phone / Aadhaar ever leave the API (SEC-12).
    for (const r of all.body.rows as { phone: string | null; aadhaar: string | null }[]) {
      if (r.phone !== null) expect(r.phone).toMatch(/^\d{2}X{6}\d{2}$/);
      if (r.aadhaar !== null) expect(r.aadhaar).toMatch(/^XXXX-XXXX-\d{4}$/);
    }
    const payload = JSON.stringify(all.body);
    expect(payload).not.toContain('9876543245');
    expect(payload).not.toContain('187654321102');
  });

  it('filters by plant, role, login and working status (cards ignore their own dimension)', async () => {
    const yediyur = await plantId('HPY-011');
    const res = await call(
      admin,
      'get',
      `/api/people?plantId=${yediyur}&loginStatus=ACTIVE`,
    ).expect(200);
    for (const r of res.body.rows as PersonRow[]) {
      expect(r.loginStatus).toBe('ACTIVE');
      expect(r.plants.some((p) => p.code === 'HPY-011')).toBe(true);
    }
    const pm = await call(
      admin,
      'get',
      `/api/people?roleId=${await roleId('Plant Manager')}&pageSize=200`,
    ).expect(200);
    expect(pm.body.total).toBeGreaterThanOrEqual(22);
    const resigned = await call(admin, 'get', '/api/people?workingStatus=RESIGNED').expect(200);
    expect((resigned.body.rows as PersonRow[]).every((r) => r.workingStatus === 'RESIGNED')).toBe(
      true,
    );
    expect(resigned.body.cards.working).toBeGreaterThan(0);
    await call(admin, 'get', '/api/people?plantId=nope').expect(400);
  });

  it('User logins lists every person with last login, filterable by login', async () => {
    const res = await call(
      admin,
      'get',
      '/api/people/logins?loginStatus=INACTIVE&pageSize=200',
    ).expect(200);
    const rows = res.body.rows as PersonRow[];
    expect(rows.some((r) => r.employeeCode === 'MEI-00611')).toBe(true);
    expect(rows.every((r) => r.loginStatus === 'INACTIVE')).toBe(true);
  });
});

describe('Assign and User logins (PPL-A1…A4, ROLE-2, ULG-T7, AUTH-5)', () => {
  it('an unmapped person can sign in once Admin assigns a plant, role and Active', async () => {
    const code = NEW.trainee.code;
    await setPassword(code);
    const blocked = await signIn(e, ip(), NEW.trainee.email, PASSWORD);
    expect(blocked.res.status).toBe(403);
    expect(blocked.res.body.message).toBe(AUTH_MESSAGES.inactive);
    const res = await call(admin, 'put', `/api/people/${await idOf(code)}/assignment`)
      .send({
        plantIds: [await plantId('BPS-004')],
        roleId: await roleId('Staff'),
        loginStatus: 'ACTIVE',
        remarks: 'New joiner',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      role: { name: 'Staff' },
      loginStatus: 'ACTIVE',
      hasRole: true,
    });
    await as(NEW.trainee.email);
    const audit = await db.query(
      `SELECT reason, after->>'loginStatus' AS login FROM audit_log
        WHERE action='ASSIGNMENT_CHANGE' AND entity_id=$1 ORDER BY id DESC LIMIT 1`,
      [await idOf(code)],
    );
    expect(audit.rows[0]).toEqual({ reason: 'New joiner', login: 'ACTIVE' });
  });

  it('validates the Assign form and refuses impossible changes', async () => {
    const staff = await roleId('Staff');
    const id = await idOf(NEW.trainee.code);
    const noPlant = await call(admin, 'put', `/api/people/${id}/assignment`)
      .send({ plantIds: [], roleId: staff, loginStatus: 'ACTIVE' })
      .expect(400);
    expect(noPlant.body.details).toEqual([
      { path: 'plantIds', message: PEOPLE_MESSAGES.plantRequired },
    ]);
    const resigned = await call(admin, 'put', `/api/people/${await idOf(NEW.pm.code)}/assignment`)
      .send({ plantIds: [await plantId('BPS-004')], roleId: staff, loginStatus: 'ACTIVE' })
      .expect(409);
    expect(resigned.body.message).toBe(PEOPLE_MESSAGES.resignedCannotLogin);
    const self = await call(admin, 'put', `/api/people/${await idOf('MEI-00412')}/assignment`)
      .send({ allPlants: true, roleId: staff, loginStatus: 'INACTIVE' })
      .expect(403);
    expect(self.body.message).toBe(PEOPLE_MESSAGES.selfChange);
    await call(admin, 'put', `/api/people/${id}/assignment`)
      .send({
        plantIds: [await plantId('BPS-004')],
        roleId: '0190a000-0000-7000-8000-000000000000',
        loginStatus: 'ACTIVE',
      })
      .expect(404);
  });

  it('Deactivate ends the login at once; Activate lets the person sign in again', async () => {
    const id = await idOf(NEW.trainee.code);
    const tara = await as(NEW.trainee.email);
    await call(admin, 'post', `/api/people/${id}/deactivate`)
      .send({ remarks: 'Transfer' })
      .expect(200);
    await call(tara, 'get', '/api/me').expect(401);
    await call(tara, 'post', '/api/auth/refresh').expect(401);
    const inactive = await signIn(e, ip(), NEW.trainee.email, PASSWORD);
    expect(inactive.res.body.message).toBe(AUTH_MESSAGES.inactive);
    await call(admin, 'post', `/api/people/${id}/activate`).send({}).expect(200);
    await as(NEW.trainee.email);
  });

  it('Reset to default password: the person stays signed in, but must set a new password to sign in again', async () => {
    const id = await idOf(NEW.trainee.code);
    const tara = await as(NEW.trainee.email);
    await call(admin, 'post', `/api/people/${id}/reset-password`).send({}).expect(204);
    await call(tara, 'get', '/api/me').expect(200);
    const old = await signIn(e, ip(), NEW.trainee.email, PASSWORD);
    expect(old.res.body.message).toBe(AUTH_MESSAGES.wrongCredentials);
    const withDefault = await signIn(e, ip(), NEW.trainee.email, RESET);
    expect(withDefault.res.status).toBe(403);
    expect(withDefault.res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const audit = await db.query(
      `SELECT count(*)::int n FROM audit_log WHERE action='PASSWORD_RESET' AND entity_id=$1`,
      [id],
    );
    expect(audit.rows[0]).toEqual({ n: 1 });
  });

  it('a resigned person cannot be activated', async () => {
    const res = await call(admin, 'post', `/api/people/${await idOf(NEW.pm.code)}/activate`).send(
      {},
    );
    expect(res.status).toBe(409);
  });
});

describe('Role access (ROLE-5…8, ACT-1)', () => {
  it('lists the 14 go-live roles in spec order', async () => {
    const res = await call(admin, 'get', '/api/roles').expect(200);
    const standard = (res.body as RoleSummary[]).filter((r) => r.isStandard);
    expect(standard.map((r) => r.name)).toEqual([
      'Admin',
      'Plant Manager',
      'Dy Plant Incharge',
      'Maintenance Officer',
      'Operation Officer',
      'Sr. Operations and Maintenance Officer',
      'Accounts Officer',
      'Asst Manager HSSE',
      'Safety Officer',
      'QHSE Head',
      'FM Co-ordinator',
      'Zonal Manager',
      'Management',
      'Staff',
    ]);
  });

  it('logs a save with the Admin name, refuses stale versions and the Admin role', async () => {
    const id = await roleId('Accounts Officer');
    const r = await call(admin, 'get', `/api/roles/${id}`).expect(200);
    const read = r.body as RoleDetail;
    expect(read.modules.MANAGEMENT_REVIEW).toBe('HIDDEN');
    const saved = await call(admin, 'put', `/api/roles/${id}`)
      .send({
        version: read.version,
        modules: { ...read.modules, GRAPHS: 'SEARCH' },
        actions: read.actions,
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      version: read.version + 1,
      modules: { GRAPHS: 'SEARCH' },
      updatedBy: { name: 'Anita Sharma' },
    });
    const stale = await call(admin, 'put', `/api/roles/${id}`)
      .send({ version: r.body.version, modules: r.body.modules, actions: r.body.actions })
      .expect(409);
    expect(stale.body.message).toBe(PEOPLE_MESSAGES.staleVersion);
    const reset = await call(admin, 'post', `/api/roles/${id}/reset`)
      .send({ version: saved.body.version })
      .expect(200);
    expect(reset.body.modules.GRAPHS).toBe('DOWNLOAD');
    const audit = await db.query(
      `SELECT action, (after->'modules'->>'GRAPHS') AS graphs FROM audit_log
        WHERE entity='role' AND entity_id=$1 ORDER BY id`,
      [id],
    );
    expect(audit.rows).toEqual([
      { action: 'ROLE_CHANGE', graphs: 'SEARCH' },
      { action: 'ROLE_RESET', graphs: 'DOWNLOAD' },
    ]);
    const adminRole = await roleId('Admin');
    const a = await call(admin, 'get', `/api/roles/${adminRole}`).expect(200);
    const locked = await call(admin, 'put', `/api/roles/${adminRole}`)
      .send({
        version: a.body.version,
        modules: { ...a.body.modules, PEOPLE: 'HIDDEN' },
        actions: a.body.actions,
      })
      .expect(409);
    expect(locked.body.message).toBe(PEOPLE_MESSAGES.adminRoleLocked);
  });

  it('Create new role: copy of an existing role, designations mapped, unique name', async () => {
    const qhse = await roleId('QHSE Head');
    const res = await call(admin, 'post', '/api/roles')
      .send({
        name: 'Regional Auditor',
        copyFromRoleId: qhse,
        designations: ['auditor — regional'],
      })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'Regional Auditor',
      isStandard: false,
      isAdmin: false,
      designations: ['Auditor — Regional'],
      peopleCount: 1,
    });
    const source = await call(admin, 'get', `/api/roles/${qhse}`).expect(200);
    expect(res.body.modules).toEqual(source.body.modules);
    const arun = await db.query(
      `SELECT r.name::text AS role FROM users u JOIN roles r ON r.id = u.base_role_id WHERE u.employee_code = $1`,
      [NEW.auditor.code],
    );
    expect(arun.rows[0]).toEqual({ role: 'Regional Auditor' });
    const dup = await call(admin, 'post', '/api/roles')
      .send({ name: 'regional auditor', copyFromRoleId: qhse })
      .expect(400);
    expect(dup.body.details).toEqual([{ path: 'name', message: PEOPLE_MESSAGES.roleNameTaken }]);
    const unknown = await call(admin, 'post', '/api/roles')
      .send({ name: 'Ghost', copyFromRoleId: qhse, designations: ['No Such Title'] })
      .expect(400);
    expect(unknown.body.details[0].message).toBe(PEOPLE_MESSAGES.designationUnknown);
    const std = await call(admin, 'post', `/api/roles/${res.body.id}/reset`)
      .send({ version: res.body.version })
      .expect(409);
    expect(std.body.message).toBe(PEOPLE_MESSAGES.notStandardRole);
  });
});

describe('Designation map (DSG-1, DSG-2, PPL-4)', () => {
  it('mapping fills the base role of unassigned people; un-mapping blocks their sign-in', async () => {
    const staff = await roleId('Staff');
    const designation = 'Graduate Trainee';
    // Tara (assigned above) keeps Admin's choice; a new unassigned trainee follows the map.
    await upload(
      admin,
      csv(
        line({
          ...NEW.trainee,
          code: 'MEI-09005',
          name: 'Gita Graduate',
          email: 'gita.graduate@makeenenergy.com',
          aadhaar: '',
        }),
      ),
      'keka.csv',
      false,
    ).expect(200);
    await setPassword('MEI-09005');
    await db.query(`UPDATE users SET login_status='ACTIVE' WHERE employee_code='MEI-09005'`);
    const before = await signIn(e, ip(), 'gita.graduate@makeenenergy.com', PASSWORD);
    expect(before.res.body.message).toBe(AUTH_MESSAGES.inactive);

    const mapped = await call(admin, 'put', '/api/designations')
      .send({ designation: 'graduate trainee', roleIds: [staff] })
      .expect(200);
    expect(mapped.body).toEqual({ designation, roles: [{ id: staff, name: 'Staff' }], people: 2 });
    await as('gita.graduate@makeenenergy.com');

    await call(admin, 'put', '/api/designations').send({ designation, roleIds: [] }).expect(200);
    await e.flushRedis();
    const after = await signIn(e, ip(), 'gita.graduate@makeenenergy.com', PASSWORD);
    expect(after.res.body.message).toBe(AUTH_MESSAGES.inactive);
    const tara = await db.query(
      `SELECT r.name::text AS role FROM users u JOIN roles r ON r.id=u.base_role_id WHERE employee_code=$1`,
      [NEW.trainee.code],
    );
    expect(tara.rows[0]).toEqual({ role: 'Staff' });

    const list = await call(admin, 'get', '/api/designations').expect(200);
    const hsse = (list.body as DesignationRow[]).find(
      (d) => d.designation === 'Asst Manager — HSSE',
    );
    expect(hsse?.roles.map((r) => r.name)).toEqual(['Asst Manager HSSE', 'Safety Officer']);
    await call(admin, 'put', '/api/designations')
      .send({ designation: 'Nobody Has This', roleIds: [staff] })
      .expect(400);
  });
});

describe('someone other than Admin with People Submit cannot escalate', () => {
  it('may assign ordinary roles, but not Admin, not an Admin holder, not role access', async () => {
    const qhse = await roleId('QHSE Head');
    const r = (await call(admin, 'get', `/api/roles/${qhse}`).expect(200)).body as RoleDetail;
    await call(admin, 'put', `/api/roles/${qhse}`)
      .send({ version: r.version, modules: { ...r.modules, PEOPLE: 'SUBMIT' }, actions: r.actions })
      .expect(200);
    try {
      const rajesh = await as(RAJESH);
      await call(rajesh, 'get', '/api/people').expect(200);
      const tara = await idOf(NEW.trainee.code);
      await call(rajesh, 'put', `/api/people/${tara}/assignment`)
        .send({
          plantIds: [await plantId('BPS-004')],
          roleId: await roleId('Staff'),
          loginStatus: 'ACTIVE',
        })
        .expect(200);
      const toAdmin = await call(rajesh, 'put', `/api/people/${tara}/assignment`)
        .send({
          plantIds: [await plantId('BPS-004')],
          roleId: await roleId('Admin'),
          loginStatus: 'ACTIVE',
        })
        .expect(403);
      expect(toAdmin.body.message).toBe(PEOPLE_MESSAGES.adminOnly);
      await call(rajesh, 'post', `/api/people/${await idOf('MEI-00412')}/deactivate`)
        .send({})
        .expect(403);
      await call(rajesh, 'put', `/api/roles/${qhse}`)
        .send({ version: r.version + 1, modules: r.modules, actions: r.actions })
        .expect(403);
      await call(rajesh, 'put', '/api/designations')
        .send({ designation: 'Plant Manager', roleIds: [] })
        .expect(403);
    } finally {
      const now = await call(admin, 'get', `/api/roles/${qhse}`).expect(200);
      await call(admin, 'post', `/api/roles/${qhse}/reset`)
        .send({ version: now.body.version })
        .expect(200);
    }
  });
});
