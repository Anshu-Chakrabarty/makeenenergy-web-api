import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV } from '../../config/config.module';
import { cookiesSecure, type Env } from '../../config/env.schema';
import { safeEqual } from '../crypto/tokens';
import { AppError } from '../errors/app-error';
import { cookieNames, readCookie } from '../security/cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit CSRF protection on every state-changing request (SEC-5), public ones included
 * (login CSRF). The web app echoes the CSRF token in the X-CSRF-Token header. Production cookies
 * are sent on the direct call from the Vercel site, so this match is what stops a foreign page.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    const cookie = readCookie(req, cookieNames(cookiesSecure(this.env)).csrf);
    const header = req.headers[CSRF_HEADER];
    const sent = Array.isArray(header) ? header[0] : header;
    if (!cookie || !sent || cookie.length < 32 || !safeEqual(cookie, sent)) {
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'CSRF_FAILED',
        'Your page has expired. Reload and try again.',
      );
    }
    return true;
  }
}
