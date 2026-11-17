import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  AdminOnly,
  CurrentAccess,
  RequireAction,
  RequireModule,
} from '../../common/access/access.decorators';
import { sendFile } from '../../common/export/report-file';
import { IdParamDto } from '../../common/pipes/params';
import { SingleUpload, UPLOAD_BODY, requireFile } from '../../common/pipes/upload';
import { requestContext } from '../../common/security/request-context';
import {
  plantActivitySchema,
  plantDeleteSchema,
  plantDetailsSchema,
  plantQuerySchema,
  plantSaveSchema,
  type PersonOption,
  type PlantDetailView,
  type PlantPage,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import type { IncomingFile } from '../attachments/attachments.service';
import { PlantsExport } from './plants.export';
import { PlantsService } from './plants.service';

class QueryDto extends createZodDto(plantQuerySchema) {}
class ExportDto extends createZodDto(
  plantQuerySchema.omit({ page: true, pageSize: true }).extend({ format: z.enum(['xlsx', 'pdf']) }),
) {}
class SaveDto extends createZodDto(plantSaveSchema) {}
class DetailsDto extends createZodDto(plantDetailsSchema) {}
class ActivityDto extends createZodDto(plantActivitySchema) {}
class DeleteDto extends createZodDto(plantDeleteSchema) {}
class FileParamDto extends createZodDto(z.object({ id: z.uuid(), fileId: z.uuid() })) {}
class ActivityParamDto extends createZodDto(z.object({ id: z.uuid(), activityId: z.uuid() })) {}
class ActivityFileParamDto extends createZodDto(
  z.object({ id: z.uuid(), activityId: z.uuid(), fileId: z.uuid() }),
) {}

/** Plant master + plant details (module PLANT_MASTER). Static paths come before `:id`. */
@ApiTags('Plant master')
@Controller('plants')
export class PlantsController {
  constructor(
    private readonly plants: PlantsService,
    private readonly exports: PlantsExport,
  ) {}

  @RequireModule('PLANT_MASTER', 'VIEW')
  @Get()
  list(@CurrentAccess() access: ResolvedAccess, @Query() q: QueryDto): Promise<PlantPage> {
    return this.plants.list(access, q);
  }

  @RequireModule('PLANT_MASTER', 'DOWNLOAD')
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

  @AdminOnly()
  @Get('people-options')
  peopleOptions(@CurrentAccess() access: ResolvedAccess): Promise<PersonOption[]> {
    return this.plants.peopleOptions(access);
  }

  @AdminOnly()
  @Post()
  create(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<PlantDetailView> {
    return this.plants.create(access, body, requestContext(req));
  }

  @RequireModule('PLANT_MASTER', 'VIEW')
  @Get(':id')
  get(@CurrentAccess() access: ResolvedAccess, @Param() p: IdParamDto): Promise<PlantDetailView> {
    return this.plants.get(access, p.id);
  }

  @AdminOnly()
  @Put(':id')
  update(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<PlantDetailView> {
    return this.plants.update(access, p.id, body, requestContext(req));
  }

  @RequireModule('PLANT_MASTER', 'VIEW')
  @RequireAction('DELETE_PLANT')
  @Post(':id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: DeleteDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.plants.remove(access, p.id, body.reason, requestContext(req));
  }

  @RequireModule('PLANT_MASTER', 'SUBMIT')
  @Put(':id/details')
  saveDetails(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: DetailsDto,
    @Req() req: Request,
  ): Promise<PlantDetailView> {
    return this.plants.saveDetails(access, p.id, body, requestContext(req));
  }

  @RequireModule('PLANT_MASTER', 'SUBMIT')
  @Post(':id/activities')
  addActivity(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: ActivityDto,
    @Req() req: Request,
  ): Promise<PlantDetailView> {
    return this.plants.addActivity(access, p.id, body, requestContext(req));
  }

  @RequireModule('PLANT_MASTER', 'SUBMIT')
  @Delete(':id/activities/:activityId')
  removeActivity(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: ActivityParamDto,
    @Req() req: Request,
  ): Promise<PlantDetailView> {
    return this.plants.removeActivity(access, p.id, p.activityId, requestContext(req));
  }

  @RequireModule('PLANT_MASTER', 'SUBMIT')
  @Post(':id/activities/:activityId/images')
  @ApiConsumes('multipart/form-data')
  @ApiBody(UPLOAD_BODY)
  @UseInterceptors(SingleUpload())
  addImage(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: ActivityParamDto,
    @UploadedFile() file: IncomingFile | undefined,
    @Req() req: Request,
  ): Promise<PlantDetailView> {
    return this.plants.addFile(
      access,
      p.id,
      { activityId: p.activityId },
      requireFile(file),
      requestContext(req),
    );
  }

  @RequireModule('PLANT_MASTER', 'VIEW')
  @Get(':id/activities/:activityId/images/:fileId')
  async readImage(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: ActivityFileParamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(
      res,
      await this.plants.readFile(
        access,
        p.id,
        { activityId: p.activityId },
        p.fileId,
        requestContext(req),
      ),
    );
  }

  @RequireModule('PLANT_MASTER', 'SUBMIT')
  @Delete(':id/activities/:activityId/images/:fileId')
  removeImage(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: ActivityFileParamDto,
    @Req() req: Request,
  ): Promise<PlantDetailView> {
    return this.plants.removeFile(
      access,
      p.id,
      { activityId: p.activityId },
      p.fileId,
      requestContext(req),
    );
  }

  @RequireModule('PLANT_MASTER', 'SUBMIT')
  @Post(':id/files')
  @ApiConsumes('multipart/form-data')
  @ApiBody(UPLOAD_BODY)
  @UseInterceptors(SingleUpload())
  addContractFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @UploadedFile() file: IncomingFile | undefined,
    @Req() req: Request,
  ): Promise<PlantDetailView> {
    return this.plants.addFile(access, p.id, 'contract', requireFile(file), requestContext(req));
  }

  @RequireModule('PLANT_MASTER', 'VIEW')
  @Get(':id/files/:fileId')
  async readContractFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: FileParamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(
      res,
      await this.plants.readFile(access, p.id, 'contract', p.fileId, requestContext(req)),
    );
  }

  @RequireModule('PLANT_MASTER', 'SUBMIT')
  @Delete(':id/files/:fileId')
  removeContractFile(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: FileParamDto,
    @Req() req: Request,
  ): Promise<PlantDetailView> {
    return this.plants.removeFile(access, p.id, 'contract', p.fileId, requestContext(req));
  }
}
