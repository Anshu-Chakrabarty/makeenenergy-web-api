import { ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { CurrentAccess, RequireAction, RequireModule } from '../../common/access/access.decorators';
import { sendFile } from '../../common/export/report-file';
import { IdParamDto } from '../../common/pipes/params';
import { requestContext } from '../../common/security/request-context';
import {
  approvalQueueQuerySchema,
  approveSchema,
  monthlyMisExportSchema,
  monthlyMisQuerySchema,
  monthlyMisSaveSchema,
  monthlySummaryQuerySchema,
  reopenSchema,
  returnSchema,
  type ApprovalQueueItem,
  type MonthlyMisDetail,
  type MonthlyMisPage,
  type MonthlySummaryView,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { MonthlyMisExport } from './monthly-mis.export';
import { MonthlyMisService } from './monthly-mis.service';

class QueryDto extends createZodDto(monthlyMisQuerySchema) {}
class ExportDto extends createZodDto(monthlyMisExportSchema) {}
class SummaryDto extends createZodDto(monthlySummaryQuerySchema) {}
class QueueDto extends createZodDto(approvalQueueQuerySchema) {}
class SaveDto extends createZodDto(monthlyMisSaveSchema) {}
class ApproveDto extends createZodDto(approveSchema) {}
class ReturnDto extends createZodDto(returnSchema) {}
class ReopenDto extends createZodDto(reopenSchema) {}

/** Monthly MIS (module MONTHLY_MIS). Static paths come before `:id` (Express matches in order). */
@ApiTags('Monthly MIS')
@Controller('monthly-mis')
export class MonthlyMisController {
  constructor(
    private readonly monthly: MonthlyMisService,
    private readonly exports: MonthlyMisExport,
  ) {}

  @RequireModule('MONTHLY_MIS', 'VIEW')
  @Get()
  list(@CurrentAccess() access: ResolvedAccess, @Query() q: QueryDto): Promise<MonthlyMisPage> {
    return this.monthly.list(access, q);
  }

  @RequireModule('MONTHLY_MIS', 'APPROVE')
  @Get('queue')
  queue(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: QueueDto,
  ): Promise<ApprovalQueueItem[]> {
    return this.monthly.queue(access, q.plantId);
  }

  @RequireModule('MONTHLY_MIS', 'VIEW')
  @Get('summary')
  summary(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: SummaryDto,
  ): Promise<MonthlySummaryView> {
    return this.monthly.summary(access, q.plantId, q.month);
  }

  @RequireModule('MONTHLY_MIS', 'DOWNLOAD')
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

  @RequireModule('MONTHLY_MIS', 'SUBMIT')
  @Post()
  create(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<MonthlyMisDetail> {
    return this.monthly.create(access, body, requestContext(req));
  }

  @RequireModule('MONTHLY_MIS', 'VIEW')
  @Get(':id')
  get(@CurrentAccess() access: ResolvedAccess, @Param() p: IdParamDto): Promise<MonthlyMisDetail> {
    return this.monthly.get(access, p.id);
  }

  @RequireModule('MONTHLY_MIS', 'DOWNLOAD')
  @Get(':id/pdf')
  async pdf(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(res, await this.exports.record(access, p.id, requestContext(req)));
  }

  @RequireModule('MONTHLY_MIS', 'SUBMIT')
  @Put(':id')
  update(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: SaveDto,
    @Req() req: Request,
  ): Promise<MonthlyMisDetail> {
    return this.monthly.update(access, p.id, body, requestContext(req));
  }

  @RequireModule('MONTHLY_MIS', 'APPROVE')
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: ApproveDto,
    @Req() req: Request,
  ): Promise<MonthlyMisDetail> {
    return this.monthly.approve(access, p.id, body.version, requestContext(req));
  }

  @RequireModule('MONTHLY_MIS', 'APPROVE')
  @RequireAction('RETURN')
  @Post(':id/return')
  @HttpCode(HttpStatus.OK)
  returnRow(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: ReturnDto,
    @Req() req: Request,
  ): Promise<MonthlyMisDetail> {
    return this.monthly.returnRow(access, p.id, body.version, body.reason, requestContext(req));
  }

  @RequireModule('MONTHLY_MIS', 'VIEW')
  @RequireAction('REOPEN_APPROVED')
  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @CurrentAccess() access: ResolvedAccess,
    @Param() p: IdParamDto,
    @Body() body: ReopenDto,
    @Req() req: Request,
  ): Promise<MonthlyMisDetail> {
    return this.monthly.reopen(access, p.id, body.version, body.reason, requestContext(req));
  }
}
