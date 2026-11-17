import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentAccess, RequireModule } from '../../common/access/access.decorators';
import { sendFile } from '../../common/export/report-file';
import { IdParamDto } from '../../common/pipes/params';
import { SingleUpload, UPLOAD_BODY, requireFile } from '../../common/pipes/upload';
import { requestContext } from '../../common/security/request-context';
import {
  auditExportSchema,
  auditQuerySchema,
  auditSaveSchema,
  type AuditDetail,
  type AuditPage,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import type { IncomingFile } from '../attachments/attachments.service';
import { AuditsExport } from './audits.export';
import { AuditsService } from './audits.service';

class QueryDto extends createZodDto(auditQuerySchema) {}
class ExportDto extends createZodDto(auditExportSchema) {}
class SaveDto extends createZodDto(auditSaveSchema) {}
class FileParamDto extends createZodDto(z.object({ id: z.uuid(), fileId: z.uuid() })) {}

/** Audit + observations (module AUDIT). */
@ApiTags('Audit')
@Controller('audits')
export class AuditsController {
  constructor(
    private readonly audits: AuditsService,
    private readonly exports: AuditsExport,
  ) {}

  @RequireModule('AUDIT', 'VIEW')
  @Get()
  list(@CurrentAccess() access: ResolvedAccess, @Query() q: QueryDto): Promise<AuditPage> {
    return this.audits.list(access, q);
  }

  @RequireModule('AUDIT', 'DOWNLOAD')
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

  @RequireModule('AUDIT', 'SUBMIT')
  @Post()
  create(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<AuditDetail> {
    return this.audits.create(access, body, requestContext(req));
  }

  @RequireModule('AUDIT', 'VIEW')
  @Get(':id')
  get(@CurrentAccess() access: ResolvedAccess, @Param() p: IdParamDto): Promise<AuditDetail> {
    return this.audits.get(access, p.id);
  }

  @RequireModule('AUDIT', 'SUBMIT')
  @Put(':id')
  update(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<AuditDetail> {
    return this.audits.update(access, p.id, body, requestContext(req));
  }

  @RequireModule('AUDIT', 'SUBMIT')
  @Post(':id/files')
  @ApiConsumes('multipart/form-data')
  @ApiBody(UPLOAD_BODY)
  @UseInterceptors(SingleUpload())
  addFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @UploadedFile() file: IncomingFile | undefined,
    @Req() req: Request,
  ): Promise<AuditDetail> {
    return this.audits.addFile(access, p.id, requireFile(file), requestContext(req));
  }

  @RequireModule('AUDIT', 'VIEW')
  @Get(':id/files/:fileId')
  async readFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: FileParamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(res, await this.audits.readFile(access, p.id, p.fileId, requestContext(req)));
  }

  @RequireModule('AUDIT', 'SUBMIT')
  @Delete(':id/files/:fileId')
  removeFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: FileParamDto,
    @Req() req: Request,
  ): Promise<AuditDetail> {
    return this.audits.removeFile(access, p.id, p.fileId, requestContext(req));
  }
}
