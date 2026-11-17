import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { AdminOnly, CurrentAccess, RequireModule } from '../../common/access/access.decorators';
import { IdParamDto } from '../../common/pipes/params';
import { requestContext } from '../../common/security/request-context';
import {
  createRoleSchema,
  designationMapSchema,
  roleAccessSchema,
  roleVersionSchema,
} from '../../shared';
import type { ResolvedAccess } from '../access/access.service';
import {
  RolesService,
  type DesignationRow,
  type RoleDetail,
  type RoleSummary,
} from './roles.service';

class RoleAccessDto extends createZodDto(roleAccessSchema) {}
class RoleVersionDto extends createZodDto(roleVersionSchema) {}
class CreateRoleDto extends createZodDto(createRoleSchema) {}
class DesignationMapDto extends createZodDto(designationMapSchema) {}

/**
 * Admin panel › People › Role access (ROLE-5…8, ACT-1) and Create new role (DSG-3).
 * Reading needs People view; every change is Admin-only — whoever edits roles could otherwise
 * grant themselves anything.
 */
@ApiTags('Roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequireModule('PEOPLE', 'VIEW')
  @Get()
  list(): Promise<RoleSummary[]> {
    return this.roles.list();
  }

  @AdminOnly()
  @Post()
  create(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: CreateRoleDto,
    @Req() req: Request,
  ): Promise<RoleDetail> {
    return this.roles.create(access, body, requestContext(req));
  }

  @RequireModule('PEOPLE', 'VIEW')
  @Get(':id')
  get(@Param() params: IdParamDto): Promise<RoleDetail> {
    return this.roles.get(params.id);
  }

  @AdminOnly()
  @Put(':id')
  update(
    @CurrentAccess() access: ResolvedAccess,
    @Param() params: IdParamDto,
    @Body() body: RoleAccessDto,
    @Req() req: Request,
  ): Promise<RoleDetail> {
    return this.roles.update(access, params.id, body, requestContext(req));
  }

  @AdminOnly()
  @Post(':id/reset')
  @HttpCode(HttpStatus.OK)
  reset(
    @CurrentAccess() access: ResolvedAccess,
    @Param() params: IdParamDto,
    @Body() body: RoleVersionDto,
    @Req() req: Request,
  ): Promise<RoleDetail> {
    return this.roles.reset(access, params.id, body.version, requestContext(req));
  }
}

/** Admin panel › People › Designation map (DSG-1, DSG-2). */
@ApiTags('Designations')
@Controller('designations')
export class DesignationsController {
  constructor(private readonly roles: RolesService) {}

  @RequireModule('PEOPLE', 'VIEW')
  @Get()
  list(): Promise<DesignationRow[]> {
    return this.roles.designations();
  }

  @AdminOnly()
  @Put()
  map(
    @CurrentAccess() access: ResolvedAccess,
    @Body() body: DesignationMapDto,
    @Req() req: Request,
  ): Promise<DesignationRow> {
    return this.roles.mapDesignation(access, body, requestContext(req));
  }
}
