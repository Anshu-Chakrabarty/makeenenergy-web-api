import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { DailyExceptionsController } from './daily-exceptions.controller';
import { DailyExceptionsExport } from './daily-exceptions.export';
import { DailyExceptionsService } from './daily-exceptions.service';

/** Daily Exceptions: table with Lapse, 13-line form, SQC uploads, downloads (Phase 8). */
@Module({
  imports: [AttachmentsModule],
  controllers: [DailyExceptionsController],
  providers: [DailyExceptionsService, DailyExceptionsExport],
  exports: [DailyExceptionsService],
})
export class DailyExceptionsModule {}
