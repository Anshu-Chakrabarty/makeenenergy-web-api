import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { PEOPLE_MESSAGES } from '../../shared';
import { KEKA_MAX_BYTES, rowsFromObjects, type SourceRow } from './keka-file';

export const KEKA_UNAVAILABLE = 'KEKA_UNAVAILABLE';

function unavailable(): AppError {
  return new AppError(
    HttpStatus.BAD_GATEWAY,
    KEKA_UNAVAILABLE,
    'KEKA did not answer. Try again later, or load a CSV or Excel file.',
  );
}

/**
 * KEKA API adapter (PPL-3). The URL and token come from the server environment only — never from
 * a request — so the screen cannot be used to reach other hosts. Contract (docs/DEPLOYMENT.md):
 * GET → JSON array (or `{ employees: [...] }` / `{ data: [...] }`) of objects keyed by the loader
 * columns (Employee name, Employee code, Email, Phone, Aadhaar, Designation, Working / Resigned).
 */
@Injectable()
export class KekaApiSource {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get configured(): boolean {
    return this.env.KEKA_API_URL !== undefined && this.env.KEKA_API_TOKEN !== undefined;
  }

  async fetchRows(): Promise<SourceRow[]> {
    const url = this.env.KEKA_API_URL;
    const token = this.env.KEKA_API_TOKEN;
    if (url === undefined || token === undefined)
      throw new AppError(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        PEOPLE_MESSAGES.kekaApiNotConnected,
      );
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.env.KEKA_API_TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    if (!res.ok) throw unavailable();
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > KEKA_MAX_BYTES) throw unavailable();
    const text = await res.text().catch(() => {
      throw unavailable();
    });
    if (Buffer.byteLength(text) > KEKA_MAX_BYTES) throw unavailable();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw unavailable();
    }
    const list = listOf(body);
    if (list === null) throw unavailable();
    return rowsFromObjects(list);
  }
}

function listOf(body: unknown): readonly unknown[] | null {
  if (Array.isArray(body)) return body as unknown[];
  if (body !== null && typeof body === 'object') {
    const employees: unknown = Reflect.get(body, 'employees');
    if (Array.isArray(employees)) return employees as unknown[];
    const data: unknown = Reflect.get(body, 'data');
    if (Array.isArray(data)) return data as unknown[];
  }
  return null;
}
