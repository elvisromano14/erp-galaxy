import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { addPriceSchema, createProductSchema, listProductsSchema, ProductsService, updateProductSchema } from './products.service';

const id = new ZodPipe(uuid);

@ApiTags('products') @ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly svc: ProductsService) {}

  @Get() @RequirePermissions('admin:products:read')
  list(@Query(new ZodPipe(listProductsSchema)) q: z.infer<typeof listProductsSchema>) { return this.svc.list(q); }

  @Get(':id') @RequirePermissions('admin:products:read')
  get(@Param('id', id) pid: string) { return this.svc.get(pid); }

  @Post() @RequirePermissions('admin:products:create')
  create(@Body(new ZodPipe(createProductSchema)) b: z.infer<typeof createProductSchema>) { return this.svc.create(b); }

  @Patch(':id') @RequirePermissions('admin:products:update')
  update(@Param('id', id) pid: string, @Body(new ZodPipe(updateProductSchema)) b: z.infer<typeof updateProductSchema>) { return this.svc.update(pid, b); }

  @Delete(':id') @RequirePermissions('admin:products:delete')
  remove(@Param('id', id) pid: string) { return this.svc.remove(pid); }

  @Post(':id/restore') @RequirePermissions('admin:products:update')
  restore(@Param('id', id) pid: string) { return this.svc.restore(pid); }

  @Post(':id/prices') @RequirePermissions('admin:products:update')
  addPrice(@Param('id', id) pid: string, @Body(new ZodPipe(addPriceSchema)) b: z.infer<typeof addPriceSchema>) { return this.svc.addPrice(pid, b); }

  @Get(':id/price-history') @RequirePermissions('admin:products:read')
  history(@Param('id', id) pid: string) { return this.svc.priceHistory(pid); }
}
