import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentAccess, RequireModule } from '../../common/access/access.decorators';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { sendFile } from '../../common/export/report-file';
import { IdParamDto } from '../../common/pipes/params';
import { requestContext } from '../../common/security/request-context';
import {
  DAILY_EXCEPTION_MESSAGES,
  dailyExceptionExportSchema,
  dailyExceptionQuerySchema,
  dailyExceptionSaveSchema,
  lapseNoteSchema,
  type DailyExceptionDetail,
  type DailyExceptionPage,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import type { IncomingFile } from '../attachments/attachments.service';
import { UPLOAD_MAX_BYTES } from '../attachments/file-type';
import { DailyExceptionsExport } from './daily-exceptions.export';
import { DailyExceptionsService } from './daily-exceptions.service';

class QueryDto extends createZodDto(dailyExceptionQuerySchema) {}
class ExportDto extends createZodDto(dailyExceptionExportSchema) {}
class SaveDto extends createZodDto(dailyExceptionSaveSchema) {}
class LapseNoteDto extends createZodDto(lapseNoteSchema) {}
class FileParamDto extends createZodDto(z.object({ id: z.uuid(), fileId: z.uuid() })) {}

/** Daily Exceptions (module DAILY_EXCEPTIONS). Static paths come before `:id`. No Approve. */
@ApiTags('Daily Exceptions')
@Controller('daily-exceptions')
export class DailyExceptionsController {
  constructor(
    private readonly exceptions: DailyExceptionsService,
    private readonly exports: DailyExceptionsExport,
  ) {}

  @RequireModule('DAILY_EXCEPTIONS', 'VIEW')
  @Get()
  list(@CurrentAccess() access: ResolvedAccess, @Query() q: QueryDto): Promise<DailyExceptionPage> {
    return this.exceptions.list(access, q);
  }

  @RequireModule('DAILY_EXCEPTIONS', 'DOWNLOAD')
  @Get('export')
  async export(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: ExportDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { format, ...filter } = q;
    sendFile(res, await this.exports.table(access, filter, format, requestContext(req)));
  }

  @RequireModule('DAILY_EXCEPTIONS', 'SUBMIT')
  @Put('lapse-notes')
  lapseNote(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: LapseNoteDto,
    @Req() req: Request,
  ): Promise<{ plantId: string; date: string; note: string }> {
    return this.exceptions.saveLapseNote(access, body, requestContext(req));
  }

  @RequireModule('DAILY_EXCEPTIONS', 'SUBMIT')
  @Post()
  create(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<DailyExceptionDetail> {
    return this.exceptions.create(access, body, requestContext(req));
  }

  @RequireModule('DAILY_EXCEPTIONS', 'VIEW')
  @Get(':id')
  get(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
  ): Promise<DailyExceptionDetail> {
    return this.exceptions.get(access, p.id);
  }

  @RequireModule('DAILY_EXCEPTIONS', 'DOWNLOAD')
  @Get(':id/pdf')
  async pdf(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(res, await this.exports.record(access, p.id, requestContext(req)));
  }

  @RequireModule('DAILY_EXCEPTIONS', 'SUBMIT')
  @Put(':id')
  update(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<DailyExceptionDetail> {
    return this.exceptions.update(access, p.id, body, requestContext(req));
  }

  @RequireModule('DAILY_EXCEPTIONS', 'SUBMIT')
  @Post(':id/files')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'SQC report: PDF, JPG, PNG or XLSX, ≤ 10 MB',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 2, parts: 3 },
    }),
  )
  addFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @UploadedFile() file: IncomingFile | undefined,
    @Req() req: Request,
  ): Promise<DailyExceptionDetail> {
    if (!file)
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        DAILY_EXCEPTION_MESSAGES.fileRequired,
        [{ path: 'file', message: DAILY_EXCEPTION_MESSAGES.fileRequired }],
      );
    return this.exceptions.addFile(access, p.id, file, requestContext(req));
  }

  @RequireModule('DAILY_EXCEPTIONS', 'VIEW')
  @Get(':id/files/:fileId')
  async readFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: FileParamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(res, await this.exceptions.readFile(access, p.id, p.fileId, requestContext(req)));
  }

  @RequireModule('DAILY_EXCEPTIONS', 'SUBMIT')
  @Delete(':id/files/:fileId')
  removeFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: FileParamDto,
    @Req() req: Request,
  ): Promise<DailyExceptionDetail> {
    return this.exceptions.removeFile(access, p.id, p.fileId, requestContext(req));
  }
}
