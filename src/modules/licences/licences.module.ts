import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { LicencesController } from './licences.controller';
import { LicencesExport } from './licences.export';
import { LicencesService } from './licences.service';

/** Licences — Statutory and Mandatory, Internal testing (Phase 9). */
@Module({
  imports: [AttachmentsModule],
  controllers: [LicencesController],
  providers: [LicencesService, LicencesExport],
  exports: [LicencesService],
})
export class LicencesModule {}
