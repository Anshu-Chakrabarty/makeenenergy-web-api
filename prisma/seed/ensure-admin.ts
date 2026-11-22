/**
 * Makes the shared local admin able to sign in on THIS machine.
 *
 * The password hash includes PASSWORD_PEPPER. A database copied from another
 * computer still says "Email or password is wrong" until the hash is rewritten
 * with the pepper in this .env. Development only. Refuses NODE_ENV=production.
 *
 * Safe to run more than once: if Makeen@123 already verifies, nothing is changed.
 */
import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashPassword, verifyPassword } from '../../src/common/crypto/password';
import { PrismaClient } from '../../src/generated/prisma/client';
import { PG_SESSION_OPTIONS } from '../../src/infra/pg-session';

const EMAIL = 'ask@makeenenergy.com';
const PASSWORD = 'Makeen@123';
const NAME = 'Achanta Sai Kishore';
const CODE = 'ASK';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to set the dev admin password when NODE_ENV=production.');
  }

  const url = process.env['MIGRATE_DATABASE_URL'] ?? required('DATABASE_URL');
  const pepper = required('PASSWORD_PEPPER');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, options: PG_SESSION_OPTIONS }),
  });

  try {
    const role = await prisma.role.findFirst({ where: { isAdmin: true }, select: { id: true } });
    if (!role) {
      console.log('No Admin role in this database yet. Run npm run db:seed first.');
      return;
    }

    const existing = await prisma.user.findUnique({
      where: { email: EMAIL },
      select: { id: true, passwordHash: true, baseRoleId: true },
    });
    const already =
      typeof existing?.passwordHash === 'string' &&
      (await verifyPassword(existing.passwordHash, PASSWORD, pepper));
    if (already && existing.baseRoleId === role.id) {
      console.log(`Admin sign-in already works for ${EMAIL}.`);
      return;
    }

    const passwordHash = await hashPassword(PASSWORD, pepper);
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          mustSetPassword: false,
          loginStatus: 'ACTIVE',
          workingStatus: 'WORKING',
          baseRoleId: role.id,
          tokenVersion: { increment: 1 },
        },
      });
      console.log(`Updated the admin password for ${EMAIL}.`);
      return;
    }

    const codeTaken = await prisma.user.findUnique({
      where: { employeeCode: CODE },
      select: { id: true },
    });
    await prisma.user.create({
      data: {
        employeeCode: codeTaken ? 'MEI-ASK' : CODE,
        name: NAME,
        email: EMAIL,
        designation: 'Admin',
        workingStatus: 'WORKING',
        loginStatus: 'ACTIVE',
        passwordHash,
        mustSetPassword: false,
        baseRoleId: role.id,
      },
    });
    console.log(`Created the admin sign-in for ${EMAIL}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
