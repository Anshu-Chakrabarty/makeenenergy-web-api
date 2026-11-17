import { Module } from '@nestjs/common';
import { MonthlyMisController } from './monthly-mis.controller';
import { MonthlyMisExport } from './monthly-mis.export';
import { MonthlyMisService } from './monthly-mis.service';

/** Monthly MIS: cumulative summary, Block B, cylinder grids, workflow, downloads (Phase 7). */
@Module({
  controllers: [MonthlyMisController],
  providers: [MonthlyMisService, MonthlyMisExport],
  exports: [MonthlyMisService],
})
export class MonthlyMisModule {}
