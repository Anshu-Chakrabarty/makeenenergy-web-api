import { nextBaseRole } from './base-role';

describe('nextBaseRole (designation map → base role)', () => {
  it('gives the single mapped role to someone with no role and no plants', () => {
    expect(nextBaseRole(null, ['pm'], false)).toBe('pm');
  });

  it('gives no role for an unmapped or several-roles designation (cannot sign in — PPL-4)', () => {
    expect(nextBaseRole(null, [], false)).toBeNull();
    expect(nextBaseRole(null, ['a', 'b'], false)).toBeNull();
  });

  it('keeps the current role while the map still allows it', () => {
    expect(nextBaseRole('b', ['a', 'b'], false)).toBe('b');
  });

  it('drops a role the map no longer allows, unless Admin assigned the person', () => {
    expect(nextBaseRole('old', ['new'], false)).toBe('new');
    expect(nextBaseRole('old', [], false)).toBeNull();
    expect(nextBaseRole('old', [], true)).toBe('old');
    expect(nextBaseRole('old', ['new'], true)).toBe('old');
  });

  it('fills a missing base role for an assigned person when the map has exactly one', () => {
    expect(nextBaseRole(null, ['pm'], true)).toBe('pm');
    expect(nextBaseRole(null, ['a', 'b'], true)).toBeNull();
  });
});
