import type { CookieOptions, Request, Response } from 'express';

/**
 * Auth cookies (SEC-3, D-06). HttpOnly always. The CSRF cookie is readable by the web app on
 * purpose (double submit). `__Host-` forbids a Path other than `/`, so the path-scoped refresh
 * cookie uses `__Secure-`.
 *
 * Local http uses SameSite=Strict. Production is SameSite=None and Partitioned because the Vercel
 * page calls this host directly and must wait for it to wake; the double-submit token still has
 * to match on every change.
 */
export const REFRESH_COOKIE_PATH = '/api/auth/refresh';

export interface CookieNames {
  access: string;
  refresh: string;
  csrf: string;
}

export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { access: '__Host-mk_at', refresh: '__Secure-mk_rt', csrf: '__Host-mk_csrf' }
    : { access: 'mk_at', refresh: 'mk_rt', csrf: 'mk_csrf' };
}

function base(secure: boolean): CookieOptions {
  if (!secure) return { secure: false, sameSite: 'strict', path: '/' };
  return { secure: true, sameSite: 'none', partitioned: true, path: '/' };
}

export function setSessionCookies(
  res: Response,
  secure: boolean,
  tokens: { access: string; accessMaxAgeMs: number; refresh: string; refreshMaxAgeMs: number },
): void {
  const names = cookieNames(secure);
  res.cookie(names.access, tokens.access, {
    ...base(secure),
    httpOnly: true,
    maxAge: tokens.accessMaxAgeMs,
  });
  res.cookie(names.refresh, tokens.refresh, {
    ...base(secure),
    httpOnly: true,
    path: REFRESH_COOKIE_PATH,
    maxAge: tokens.refreshMaxAgeMs,
  });
}

export function setCsrfCookie(res: Response, secure: boolean, token: string): void {
  // Not HttpOnly: the web app copies it into the X-CSRF-Token header.
  res.cookie(cookieNames(secure).csrf, token, { ...base(secure), httpOnly: false });
}

export function clearSessionCookies(res: Response, secure: boolean): void {
  const names = cookieNames(secure);
  res.clearCookie(names.access, { ...base(secure), httpOnly: true });
  res.clearCookie(names.refresh, { ...base(secure), httpOnly: true, path: REFRESH_COOKIE_PATH });
}

export function readCookie(req: Request, name: string): string | undefined {
  const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
