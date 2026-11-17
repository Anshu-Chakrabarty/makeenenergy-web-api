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
  LICENCE_TYPES,
  licenceExportSchema,
  licenceQuerySchema,
  licenceSaveSchema,
  remindOptionsQuerySchema,
  type LicenceDetail,
  type LicenceItemOption,
  type LicencePage,
  type PersonOption,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import type { IncomingFile } from '../attachments/attachments.service';
import { LicencesExport } from './licences.export';
import { LicencesService } from './licences.service';

class QueryDto extends createZodDto(licenceQuerySchema) {}
class ExportDto extends createZodDto(licenceExportSchema) {}
class SaveDto extends createZodDto(licenceSaveSchema) {}
class ItemsDto extends createZodDto(z.object({ licenceType: z.enum(LICENCE_TYPES).optional() })) {}
class RemindDto extends createZodDto(remindOptionsQuerySchema) {}
class FileParamDto extends createZodDto(z.object({ id: z.uuid(), fileId: z.uuid() })) {}

/** Statutory and Mandatory / Internal testing (module LICENCES). Static paths before `:id`. */
@ApiTags('Licences')
@Controller('licences')
export class LicencesController {
  constructor(
    private readonly licences: LicencesService,
    private readonly exports: LicencesExport,
  ) {}

  @RequireModule('LICENCES', 'VIEW')
  @Get()
  list(@CurrentAccess() access: ResolvedAccess, @Query() q: QueryDto): Promise<LicencePage> {
    return this.licences.list(access, q);
  }

  @RequireModule('LICENCES', 'DOWNLOAD')
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

  @RequireModule('LICENCES', 'VIEW')
  @Get('items')
  items(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: ItemsDto,
  ): Promise<LicenceItemOption[]> {
    return this.licences.items(access, q.licenceType);
  }

  @RequireModule('LICENCES', 'SUBMIT')
  @Get('remind-options')
  remindOptions(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: RemindDto,
  ): Promise<PersonOption[]> {
    return this.licences.remindOptions(access, q.plantId);
  }

  @RequireModule('LICENCES', 'SUBMIT')
  @Post()
  create(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<LicenceDetail> {
    return this.licences.create(access, body, requestContext(req));
  }

  @RequireModule('LICENCES', 'VIEW')
  @Get(':id')
  get(@CurrentAccess() access: ResolvedAccess, @Param() p: IdParamDto): Promise<LicenceDetail> {
    return this.licences.get(access, p.id);
  }

  @RequireModule('LICENCES', 'SUBMIT')
  @Put(':id')
  update(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<LicenceDetail> {
    return this.licences.update(access, p.id, body, requestContext(req));
  }

  @RequireModule('LICENCES', 'SUBMIT')
  @Post(':id/files')
  @ApiConsumes('multipart/form-data')
  @ApiBody(UPLOAD_BODY)
  @UseInterceptors(SingleUpload())
  addFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @UploadedFile() file: IncomingFile | undefined,
    @Req() req: Request,
  ): Promise<LicenceDetail> {
    return this.licences.addFile(access, p.id, requireFile(file), requestContext(req));
  }

  @RequireModule('LICENCES', 'VIEW')
  @Get(':id/files/:fileId')
  async readFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: FileParamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(res, await this.licences.readFile(access, p.id, p.fileId, requestContext(req)));
  }

  @RequireModule('LICENCES', 'SUBMIT')
  @Delete(':id/files/:fileId')
  removeFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: FileParamDto,
    @Req() req: Request,
  ): Promise<LicenceDetail> {
    return this.licences.removeFile(access, p.id, p.fileId, requestContext(req));
  }
}
