import { Module } from '@nestjs/common';
import { ReviewCheckController } from './review-check.controller';
import { ReviewCheckService } from './review-check.service';

/** Review Check — read-only plant summary (Phase 9). */
@Module({ controllers: [ReviewCheckController], providers: [ReviewCheckService] })
export class ReviewCheckModule {}
