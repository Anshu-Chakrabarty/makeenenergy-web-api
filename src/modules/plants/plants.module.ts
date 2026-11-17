import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { PlantsController } from './plants.controller';
import { PlantsExport } from './plants.export';
import { PlantsService } from './plants.service';

/** Plant master and plant details (Phase 9). */
@Module({
  imports: [AttachmentsModule],
  controllers: [PlantsController],
  providers: [PlantsService, PlantsExport],
  exports: [PlantsService],
})
export class PlantsModule {}
