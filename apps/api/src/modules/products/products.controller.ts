import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { addPriceSchema, bulkPriceSchema, createProductSchema, labelsQuerySchema, listProductsSchema, ProductsService, updateProductSchema } from './products.service';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';

const id = new ZodPipe(uuid);
const recalcSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

@ApiTags('products') @ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly svc: ProductsService) {}

  @Get() @RequirePermissions('admin:products:read')
  list(@ZQuery(listProductsSchema) q: z.infer<typeof listProductsSchema>) { return this.svc.list(q); }

  /** Etiquetas con QR (PDF del tamaño del rollo): ?ids=…|categoryId|brand|search &copies &width &height (mm). */
  @Get('labels') @RequirePermissions('admin:products:read')
  async labels(@ZQuery(labelsQuerySchema) q: z.infer<typeof labelsQuerySchema>, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.labels(q);
    res.setHeader('Content-Disposition', 'inline; filename="etiquetas-qr.pdf"');
    res.setHeader('X-Label-Count', String(r.count));
    return new StreamableFile(r.buffer, { type: 'application/pdf' });
  }

  @Post('prices/recalculate') @RequirePermissions('admin:price-lists:update')
  recalc(@ZBody(recalcSchema) b: z.infer<typeof recalcSchema>) { return this.svc.recomputeDerivedLists(b.date); }

  @Post('prices/bulk') @RequirePermissions('admin:products:update', 'admin:price-lists:update')
  bulkPrices(@ZBody(bulkPriceSchema) b: z.infer<typeof bulkPriceSchema>) { return this.svc.bulkPrices(b); }

  @Get(':id') @RequirePermissions('admin:products:read')
  get(@Param('id', id) pid: string) { return this.svc.get(pid); }

  @Post() @RequirePermissions('admin:products:create')
  create(@ZBody(createProductSchema) b: z.infer<typeof createProductSchema>) { return this.svc.create(b); }

  @Patch(':id') @RequirePermissions('admin:products:update')
  update(@Param('id', id) pid: string, @ZBody(updateProductSchema) b: z.infer<typeof updateProductSchema>) { return this.svc.update(pid, b); }

  @Delete(':id') @RequirePermissions('admin:products:delete')
  remove(@Param('id', id) pid: string) { return this.svc.remove(pid); }

  @Post(':id/restore') @RequirePermissions('admin:products:update')
  restore(@Param('id', id) pid: string) { return this.svc.restore(pid); }

  @Post(':id/prices') @RequirePermissions('admin:products:update')
  addPrice(@Param('id', id) pid: string, @ZBody(addPriceSchema) b: z.infer<typeof addPriceSchema>) { return this.svc.addPrice(pid, b); }

  @Get(':id/price-history') @RequirePermissions('admin:products:read')
  history(@Param('id', id) pid: string) { return this.svc.priceHistory(pid); }
}
