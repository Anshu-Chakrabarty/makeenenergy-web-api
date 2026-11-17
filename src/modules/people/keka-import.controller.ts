import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { CurrentAccess, RequireModule } from '../../common/access/access.decorators';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { requestContext } from '../../common/security/request-context';
import { PEOPLE_MESSAGES, importApiOptionsSchema, importFileOptionsSchema } from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { KekaApiSource } from './keka-api.source';
import { KEKA_MAX_BYTES, parseKekaFile } from './keka-file';
import { KekaImportService, type ImportReport, type ImportStatus } from './keka-import.service';

/** The parts of multer's in-memory file we use (multer comes with @nestjs/platform-express). */
interface UploadedFileLike {
  originalname: string;
  buffer: Buffer;
}

class ImportFileOptionsDto extends createZodDto(importFileOptionsSchema) {}
class ImportApiOptionsDto extends createZodDto(importApiOptionsSchema) {}

/** KEKA loader (PPL-2, PPL-3). Dry run first (default), then the same file with dryRun=false. */
@ApiTags('KEKA import')
@Controller('people/import')
export class KekaImportController {
  constructor(
    private readonly imports: KekaImportService,
    private readonly api: KekaApiSource,
  ) {}

  @RequireModule('PEOPLE', 'VIEW')
  @Get('status')
  status(): Promise<ImportStatus> {
    return this.imports.status(this.api.configured);
  }

  @RequireModule('PEOPLE', 'SUBMIT')
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'KEKA export, CSV or .xlsx, ≤ 10 MB',
        },
        dryRun: {
          type: 'string',
          enum: ['true', 'false'],
          default: 'true',
          description: 'true = check only (nothing changes); false = load',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: KEKA_MAX_BYTES, files: 1, fields: 5, parts: 8 },
    }),
  )
  async upload(
    @CurrentAccess() access: ResolvedAccess,
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() options: ImportFileOptionsDto,
    @Req() req: Request,
  ): Promise<ImportReport> {
    if (!file)
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        PEOPLE_MESSAGES.fileType,
        [{ path: 'file', message: PEOPLE_MESSAGES.fileType }],
      );
    const fileName = file.originalname.slice(0, 255);
    const rows = await parseKekaFile(file.buffer, fileName);
    return this.imports.run(
      access,
      rows,
      { source: 'CSV', fileName, dryRun: options.dryRun },
      requestContext(req),
    );
  }

  @RequireModule('PEOPLE', 'SUBMIT')
  @Post('keka-api')
  @HttpCode(HttpStatus.OK)
  async fromApi(
    @CurrentAccess() access: ResolvedAccess,
    @Body() options: ImportApiOptionsDto,
    @Req() req: Request,
  ): Promise<ImportReport> {
    const rows = await this.api.fetchRows();
    return this.imports.run(
      access,
      rows,
      { source: 'API', fileName: null, dryRun: options.dryRun },
      requestContext(req),
    );
  }
}
