import type { Tx } from '../../prisma/prisma.service';

/**
 * Base role from the designation map (ROLE-4, People 2–4, D-11):
 *  - Someone Admin has assigned (has plants) keeps Admin's choice; with no base role yet they get
 *    the mapped role when there is exactly one.
 *  - Otherwise the current base role stays while the map still allows it; else the single mapped
 *    role; else none — an unmapped (or several-roles) designation cannot sign in until Admin
 *    maps it or assigns a role (PPL-4).
 */
export function nextBaseRole(
  current: string | null,
  mapped: readonly string[],
  hasAssignments: boolean,
): string | null {
  const single = mapped.length === 1 ? (mapped[0] ?? null) : null;
  if (hasAssignments) return current ?? single;
  if (current !== null && mapped.includes(current)) return current;
  return single;
}

/** Designation (case-insensitive, as stored in citext) → mapped role ids. */
export async function designationRoles(tx: Tx): Promise<Map<string, string[]>> {
  const rows = await tx.designationRoleMap.findMany({
    select: { designation: true, roleId: true },
  });
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.designation.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), r.roleId]);
  }
  return map;
}

/**
 * Re-derive base roles for everyone holding one of `designations` after the map changed.
 * Returns how many people's base role changed.
 */
export async function rederiveBaseRoles(tx: Tx, designations: readonly string[]): Promise<number> {
  if (designations.length === 0) return 0;
  const map = await designationRoles(tx);
  const lowered = designations.map((d) => d.toLowerCase());
  const ids = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE lower(designation::text) = ANY(${lowered}::text[])`;
  const people = await tx.user.findMany({
    where: { id: { in: ids.map((r) => r.id) } },
    select: {
      id: true,
      designation: true,
      baseRoleId: true,
      _count: { select: { assignments: true } },
    },
  });
  let changed = 0;
  for (const p of people) {
    const next = nextBaseRole(
      p.baseRoleId,
      map.get(p.designation.toLowerCase()) ?? [],
      p._count.assignments > 0,
    );
    if (next !== p.baseRoleId) {
      await tx.user.update({ where: { id: p.id }, data: { baseRoleId: next } });
      changed += 1;
    }
  }
  return changed;
}
