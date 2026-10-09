import { Controller, Delete, Get, Param, Patch, Post, Type } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { PermissionsService } from '../../common/auth/permissions.service';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';
import { SalesService } from './sales.service';
import {
  SalesRoute, SALES_ROUTES, salesCancelSchema, salesDocSchema, salesDocUpdateSchema, salesListSchema, Viewer,
} from './sales.types';

const id = new ZodPipe(uuid);

async function viewerOf(perms: PermissionsService, u: AuthUser): Promise<Viewer> {
  if (u.isSuperAdmin) return { userId: u.userId, all: true };
  const have = await perms.forUser(u.userId, u.companyId!);
  return { userId: u.userId, all: have.includes('sales:documents:read-all') };
}

/** Un controlador por tipo de documento; los vendedores sin `sales:documents:read-all` solo ven los suyos. */
function makeController(route: SalesRoute): Type<unknown> {
  const P = (a: string) => `${route.permission}:${a}`;
  const t = route.docType;

  @ApiTags(route.path) @ApiBearerAuth()
  @Controller(route.path)
  class DocController {
    constructor(readonly svc: SalesService, readonly perms: PermissionsService) {}

    @Get() @RequirePermissions(P('read'))
    async list(@CurrentUser() u: AuthUser, @ZQuery(salesListSchema) q: z.infer<typeof salesListSchema>) { return this.svc.list(t, q, await viewerOf(this.perms, u)); }

    @Get(':id') @RequirePermissions(P('read'))
    async get(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.get(t, did, await viewerOf(this.perms, u)); }

    @Post() @RequirePermissions(P('create'))
    async create(@CurrentUser() u: AuthUser, @ZBody(salesDocSchema) b: z.infer<typeof salesDocSchema>) { return this.svc.create(t, b, await viewerOf(this.perms, u)); }

    @Patch(':id') @RequirePermissions(P('update'))
    async update(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZBody(salesDocUpdateSchema) b: z.infer<typeof salesDocUpdateSchema>) {
      return this.svc.update(t, did, b as any, await viewerOf(this.perms, u));
    }

    @Delete(':id') @RequirePermissions(P('update'))
    async remove(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.remove(t, did, await viewerOf(this.perms, u)); }

    @Post(':id/cancel') @RequirePermissions(P('cancel'))
    async cancel(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZBody(salesCancelSchema) b: z.infer<typeof salesCancelSchema>) {
      return this.svc.cancel(t, did, b.reason, await viewerOf(this.perms, u));
    }
  }
  Reflect.defineMetadata('design:paramtypes', [SalesService, PermissionsService], DocController);
  return DocController;
}

@ApiTags('sales/actions') @ApiBearerAuth()
@Controller('sales')
export class SalesActionsController {
  constructor(private readonly svc: SalesService, private readonly perms: PermissionsService) {}

  @Post('quotes/:id/send') @RequirePermissions('sales:quotes:confirm')
  async send(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.quoteAction(did, 'send', await viewerOf(this.perms, u)); }
  @Post('quotes/:id/accept') @RequirePermissions('sales:quotes:confirm')
  async accept(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.quoteAction(did, 'accept', await viewerOf(this.perms, u)); }
  @Post('quotes/:id/reject') @RequirePermissions('sales:quotes:confirm')
  async reject(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.quoteAction(did, 'reject', await viewerOf(this.perms, u)); }
  @Post('quotes/:id/convert-to-budget') @RequirePermissions('sales:budgets:create')
  async quoteToBudget(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.convert('QUOTE', 'BUDGET', did, await viewerOf(this.perms, u)); }
  @Post('quotes/:id/convert-to-order') @RequirePermissions('sales:orders:create')
  async quoteToOrder(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.convert('QUOTE', 'ORDER', did, await viewerOf(this.perms, u)); }

  @Post('budgets/:id/confirm') @RequirePermissions('sales:budgets:confirm')
  async confirmBudget(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.confirm('BUDGET', did, await viewerOf(this.perms, u)); }
  @Post('budgets/:id/convert-to-order') @RequirePermissions('sales:orders:create')
  async budgetToOrder(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.convert('BUDGET', 'ORDER', did, await viewerOf(this.perms, u)); }

  @Post('orders/:id/confirm') @RequirePermissions('sales:orders:confirm')
  async confirmOrder(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.confirm('ORDER', did, await viewerOf(this.perms, u)); }
}

export const SalesControllers: Type<unknown>[] = [SalesActionsController, ...SALES_ROUTES.map(makeController)];
