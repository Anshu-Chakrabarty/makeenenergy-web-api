import { Body, Controller, Get, Put, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { AdminOnly, CurrentAccess, RequireModule } from '../../common/access/access.decorators';
import { sendFile } from '../../common/export/report-file';
import { requestContext } from '../../common/security/request-context';
import {
  comparisonQuerySchema,
  dashboardExportSchema,
  dashboardQuerySchema,
  graphsExportSchema,
  graphsQuerySchema,
  manHourSettingSchema,
  performanceQuerySchema,
  reviewExportSchema,
  reviewPackQuerySchema,
  searchQuerySchema,
  type Comparison,
  type DashboardView,
  type GraphsView,
  type ManHourSetting,
  type PlantPerformance,
  type ReviewPack,
  type SearchHit,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { DashboardService } from './dashboard.service';
import { GraphsService } from './graphs.service';
import { InsightsExport } from './insights.export';
import { ReviewService } from './review.service';
import { SearchService } from './search.service';

class DashboardQueryDto extends createZodDto(dashboardQuerySchema) {}
class DashboardExportDto extends createZodDto(dashboardExportSchema) {}
class PerformanceDto extends createZodDto(performanceQuerySchema) {}
class ReviewPackDto extends createZodDto(reviewPackQuerySchema) {}
class ReviewExportDto extends createZodDto(reviewExportSchema) {}
class ComparisonDto extends createZodDto(comparisonQuerySchema) {}
class GraphsQueryDto extends createZodDto(graphsQuerySchema) {}
class GraphsExportDto extends createZodDto(graphsExportSchema) {}
class ManHourDto extends createZodDto(manHourSettingSchema) {}
class SearchDto extends createZodDto(searchQuerySchema) {}

/** Dashboard (module DASHBOARD): counts, waiting tables, Plant Performance, download. */
@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly exports: InsightsExport,
  ) {}

  @RequireModule('DASHBOARD', 'VIEW')
  @Get()
  view(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: DashboardQueryDto,
  ): Promise<DashboardView> {
    return this.dashboard.view(access, q);
  }

  @RequireModule('DASHBOARD', 'VIEW')
  @Get('performance')
  performance(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: PerformanceDto,
  ): Promise<PlantPerformance> {
    return this.dashboard.performance(access, q.range, q.plantId);
  }

  @RequireModule('DASHBOARD', 'DOWNLOAD')
  @Get('export')
  async export(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: DashboardExportDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { format, ...filter } = q;
    sendFile(res, await this.exports.dashboardFile(access, filter, format, requestContext(req)));
  }
}

/** Command palette search (any login that may open the Dashboard). */
@ApiTags('Dashboard')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @RequireModule('DASHBOARD', 'VIEW')
  @Get()
  search(@CurrentAccess() access: ResolvedAccess, @Query() q: SearchDto): Promise<SearchHit[]> {
    return this.searchService.search(access, q.q);
  }
}

/** Management Review (module MANAGEMENT_REVIEW — senior roles by default, ROLE-D7). */
@ApiTags('Management Review')
@Controller('management-review')
export class ReviewController {
  constructor(
    private readonly review: ReviewService,
    private readonly exports: InsightsExport,
  ) {}

  @RequireModule('MANAGEMENT_REVIEW', 'VIEW')
  @Get()
  pack(@CurrentAccess() access: ResolvedAccess, @Query() q: ReviewPackDto): Promise<ReviewPack> {
    return this.review.pack(access, q);
  }

  @RequireModule('MANAGEMENT_REVIEW', 'VIEW')
  @Get('comparison')
  comparison(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: ComparisonDto,
  ): Promise<Comparison> {
    return this.review.comparison(access, q);
  }

  @RequireModule('MANAGEMENT_REVIEW', 'DOWNLOAD')
  @Get('export')
  async export(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: ReviewExportDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { format, layout, ...filter } = q;
    sendFile(
      res,
      await this.exports.reviewFile(access, filter, format, layout, requestContext(req)),
    );
  }
}

/** Graphs (module GRAPHS): eight charts with their tables; the GR-4 switch is Admin only. */
@ApiTags('Graphs')
@Controller('graphs')
export class GraphsController {
  constructor(
    private readonly graphs: GraphsService,
    private readonly exports: InsightsExport,
  ) {}

  @RequireModule('GRAPHS', 'VIEW')
  @Get()
  view(@CurrentAccess() access: ResolvedAccess, @Query() q: GraphsQueryDto): Promise<GraphsView> {
    return this.graphs.view(access, q);
  }

  @RequireModule('GRAPHS', 'DOWNLOAD')
  @Get('export')
  async export(
    @CurrentAccess() access: ResolvedAccess,
    @Query() q: GraphsExportDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { format, ...filter } = q;
    sendFile(res, await this.exports.graphsFile(access, filter, format, requestContext(req)));
  }

  @AdminOnly()
  @Put('settings')
  setManHour(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: ManHourDto,
    @Req() req: Request,
  ): Promise<ManHourSetting> {
    return this.graphs.setManHour(access, body, requestContext(req));
  }
}
