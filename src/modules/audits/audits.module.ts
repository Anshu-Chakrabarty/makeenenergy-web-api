import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuditsController } from './audits.controller';
import { AuditsExport } from './audits.export';
import { AuditsService } from './audits.service';

/** Audit + observations (Phase 9). */
@Module({
  imports: [AttachmentsModule],
  controllers: [AuditsController],
  providers: [AuditsService, AuditsExport],
  exports: [AuditsService],
})
export class AuditsModule {}
