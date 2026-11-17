import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { GraphsService } from './graphs.service';
import {
  DashboardController,
  GraphsController,
  ReviewController,
  SearchController,
} from './insights.controller';
import { InsightsExport } from './insights.export';
import { ReviewService } from './review.service';
import { SearchService } from './search.service';

/** Dashboard, Management Review, Graphs and the command palette — read only (Phase 11). */
@Module({
  controllers: [DashboardController, SearchController, ReviewController, GraphsController],
  providers: [DashboardService, ReviewService, GraphsService, SearchService, InsightsExport],
})
export class InsightsModule {}
