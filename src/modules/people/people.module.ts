import { Module } from '@nestjs/common';
import { KekaApiSource } from './keka-api.source';
import { KekaImportController } from './keka-import.controller';
import { KekaImportService } from './keka-import.service';
import { PeopleController } from './people.controller';
import { PeopleService } from './people.service';
import { DesignationsController, RolesController } from './roles.controller';
import { RolesService } from './roles.service';

/** People, User logins, Role access, Designation map and the KEKA loader (Phase 4). */
@Module({
  // KekaImportController first: `people/import/*` must match before `people/:id`.
  controllers: [KekaImportController, PeopleController, RolesController, DesignationsController],
  providers: [PeopleService, RolesService, KekaImportService, KekaApiSource],
})
export class PeopleModule {}
