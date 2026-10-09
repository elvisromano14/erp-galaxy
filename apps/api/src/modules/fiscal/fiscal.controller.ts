import { Controller, Get, Param, Post, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';
import { WithholdingsService } from './withholdings.service';
import { cancelWithholdingSchema, eligibleQuery, issueWithholdingSchema, receiveWithholdingSchema, withholdingListSchema } from './withholdings.types';

const id = new ZodPipe(uuid);

@ApiTags('fiscal') @ApiBearerAuth()
@Controller('fiscal/withholdings')
export class FiscalController {
  constructor(private readonly svc: WithholdingsService) {}

  @Get() @RequirePermissions('fiscal:withholdings:read')
  list(@ZQuery(withholdingListSchema) q: z.infer<typeof withholdingListSchema>) { return this.svc.list(q); }

  @Get('eligible') @RequirePermissions('fiscal:withholdings:read')
  eligible(@ZQuery(eligibleQuery) q: z.infer<typeof eligibleQuery>) { return this.svc.eligible(q.direction, q.partyId); }

  @Get(':id') @RequirePermissions('fiscal:withholdings:read')
  get(@Param('id', id) wid: string) { return this.svc.get(wid); }

  @Post('issue') @RequirePermissions('fiscal:withholdings:create')
  issue(@ZBody(issueWithholdingSchema) b: z.infer<typeof issueWithholdingSchema>) { return this.svc.issue(b); }

  @Post('receive') @RequirePermissions('fiscal:withholdings:create')
  receive(@ZBody(receiveWithholdingSchema) b: z.infer<typeof receiveWithholdingSchema>) { return this.svc.receive(b); }

  @Post(':id/cancel') @RequirePermissions('fiscal:withholdings:cancel')
  cancel(@Param('id', id) wid: string, @ZBody(cancelWithholdingSchema) b: z.infer<typeof cancelWithholdingSchema>) { return this.svc.cancel(wid, b.reason); }

  @Get(':id/pdf') @RequirePermissions('fiscal:withholdings:read')
  async pdf(@Param('id', id) wid: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.pdf(wid);
    res.setHeader('Content-Disposition', `inline; filename="${r.filename}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return new StreamableFile(r.buffer, { type: 'application/pdf' });
  }
}
