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
} from '@nestjs/common';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { CurrentAccess, RequireModule } from '../../common/access/access.decorators';
import { IdParamDto } from '../../common/pipes/params';
import { requestContext } from '../../common/security/request-context';
import {
  assignSchema,
  loginChangeSchema,
  loginsQuerySchema,
  peopleQuerySchema,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import { PeopleService, type Page, type PeopleCards, type PersonRow } from './people.service';

class PeopleQueryDto extends createZodDto(peopleQuerySchema) {}
class LoginsQueryDto extends createZodDto(loginsQuerySchema) {}
class AssignDto extends createZodDto(assignSchema) {}
class LoginChangeDto extends createZodDto(loginChangeSchema) {}

/**
 * People and User logins (Admin panel). Module PEOPLE is Hidden for every role but Admin by
 * default (ROLE-D6). Static routes come before `:id` (Express matches in order).
 */
@ApiTags('People')
@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @RequireModule('PEOPLE', 'VIEW')
  @Get()
  list(
    @CurrentAccess() access: ResolvedAccess,
    @Query() query: PeopleQueryDto,
  ): Promise<Page<PersonRow> & { cards: PeopleCards }> {
    return this.people.list(access, query);
  }

  @RequireModule('PEOPLE', 'VIEW')
  @Get('logins')
  logins(
    @CurrentAccess() access: ResolvedAccess,
    @Query() query: LoginsQueryDto,
  ): Promise<Page<PersonRow>> {
    return this.people.logins(access, query);
  }

  @RequireModule('PEOPLE', 'VIEW')
  @Get(':id')
  get(@CurrentAccess() access: ResolvedAccess, @Param() params: IdParamDto): Promise<PersonRow> {
    return this.people.get(access, params.id);
  }

  @RequireModule('PEOPLE', 'SUBMIT')
  @Put(':id/assignment')
  assign(
    @CurrentAccess() access: ResolvedAccess,
    @Param() params: IdParamDto,
    @Body() body: AssignDto,
    @Req() req: Request,
  ): Promise<PersonRow> {
    return this.people.assign(access, params.id, body, requestContext(req));
  }

  @RequireModule('PEOPLE', 'SUBMIT')
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @CurrentAccess() access: ResolvedAccess,
    @Param() params: IdParamDto,
    @Body() body: LoginChangeDto,
    @Req() req: Request,
  ): Promise<PersonRow> {
    return this.people.activate(access, params.id, body, requestContext(req));
  }

  @RequireModule('PEOPLE', 'SUBMIT')
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @CurrentAccess() access: ResolvedAccess,
    @Param() params: IdParamDto,
    @Body() body: LoginChangeDto,
    @Req() req: Request,
  ): Promise<PersonRow> {
    return this.people.deactivate(access, params.id, body, requestContext(req));
  }

  @RequireModule('PEOPLE', 'SUBMIT')
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(
    @CurrentAccess() access: ResolvedAccess,
    @Param() params: IdParamDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.people.resetPassword(access, params.id, requestContext(req));
  }
}
